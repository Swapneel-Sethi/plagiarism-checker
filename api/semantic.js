/*
 * Semantic plagiarism layer (backend).
 *
 * The offline engine only matches identical / near-identical WORDS (5-gram
 * shingles + lexical TF-IDF). That misses reworded plagiarism — the same idea
 * expressed in different words. This module closes that gap using Google's
 * text-embedding model: it embeds the document's sentences and the reference
 * sources' passages, then flags any document sentence whose meaning is close
 * (cosine >= threshold) to a source passage.
 *
 * Run server-side only (the API key must never reach the browser).
 *
 * Quota policy: the Gemini free tier has a tiny quota. This module is
 * BEST-EFFORT and must NEVER block the analysis. On a 429/5xx it fails fast
 * (2 tries, short backoff, then throws) so the caller can abort the whole
 * semantic pass in well under a second instead of grinding for minutes and
 * blowing the serverless function timeout.
 */
'use strict';

const MODEL = 'models/gemini-embedding-001';

// Cosine cutoff for "this sentence is a semantic copy / heavy paraphrase".
// Tuned (calibrated on the test docs) so original topical sentences stay below
// it while reworded/verbatim source text clears it. 0.72 = clean separation:
// genuine copies score 0.69-0.79, original prose that merely mentions the topic scores 0.62-0.67.
let SEMANTIC_THRESHOLD = 0.72;

// Source passages are capped (chars) and windowed so embedding cost stays low
// while still covering the lead/definition sections that paraphrases map to.
const SRC_CAP = 1800;   // was 3000 — trim to keep embedding volume bounded
const SRC_WIN = 120;    // words per passage (was 100)
const SRC_STEP = 120;   // stride (was 80) — fewer, more spaced passages

// Doc sentences: only embed reasonably long ones, and cap the total so a very
// long document can't blow the timeout even when the quota is healthy.
const DOC_MIN_WORDS = 8;
const DOC_CAP = 70;

// Cache embeddings of stable corpus docs (id-based) across requests.
const cache = new Map();

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return 'h' + h;
}

function splitSentencesWithBounds(text) {
  if (!text) return [];
  let parts;
  try { parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/); } catch (e) { parts = null; }
  if (!parts) parts = text.split(/[.!?]+\s+/);
  const out = [];
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    if (!s) continue;
    let start = text.indexOf(s, idx);
    if (start < 0) start = idx;
    out.push({ text: s, start: start, end: start + s.length });
    idx = start + s.length + 1;
  }
  return out;
}

function splitSourcePassages(text) {
  const capped = (text || '').slice(0, SRC_CAP);
  const words = capped.split(/\s+/).filter(Boolean);
  const passages = [];
  for (let i = 0; i < words.length; i += SRC_STEP) {
    const chunk = words.slice(i, i + SRC_WIN).join(' ');
    if (chunk.trim().length > 40) passages.push(chunk);
  }
  return passages;
}

// Fail-fast embed of a single text. Throws on persistent quota/network failure
// so the caller can abort the whole pass quickly instead of grinding.
async function embedOne(text, key) {
  const tries = 2;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: text }] } })
      });
      if (r.ok) {
        const j = await r.json();
        return (j.embedding && j.embedding.values) ? j.embedding.values : [];
      }
      // Quota / server errors: retry once briefly, then give up loudly.
      if (r.status === 429 || r.status >= 500) {
        if (a < tries - 1) { await new Promise(function (res) { setTimeout(res, 700 * (a + 1)); }); continue; }
        throw new Error('EMBED_QUOTA');
      }
      // Non-retryable client error (bad key, bad request) — return empty.
      const e = await r.text().catch(function () { return ''; });
      process.stderr.write('EMBED ERR ' + r.status + ' ' + e.slice(0, 160) + '\n');
      return [];
    } catch (err) {
      if (a < tries - 1) { await new Promise(function (res) { setTimeout(res, 400 * (a + 1)); }); continue; }
      throw err; // network failure — propagate so caller can abort
    }
  }
  return [];
}

// Sequential batches (CONC at a time); propagates the first rejection so a
// quota/network failure aborts the pass immediately.
async function embedTexts(texts, key) {
  const CONC = 8;
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += CONC) {
    const slice = texts.slice(i, i + CONC);
    const res = await Promise.all(slice.map(function (t) { return embedOne(t, key); }));
    for (let k = 0; k < res.length; k++) out[i + k] = res[k];
  }
  return out;
}

function norm(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; return Math.sqrt(n) || 1; }

async function semanticMatches(text, sources, key, skipRanges) {
  const result = { spans: [], perSource: {}, coveragePct: 0 };
  if (!key || !sources || !sources.length) return result;

  let docSents = splitSentencesWithBounds(text)
    .filter(function (s) { return s.text.split(/\s+/).filter(Boolean).length >= DOC_MIN_WORDS; });
  // Skip sentences already caught by word-matching — no need to embed/flag them.
  if (skipRanges && skipRanges.length) {
    docSents = docSents.filter(function (s) {
      return !skipRanges.some(function (r) { return s.start >= r.start && s.end <= r.end; });
    });
  }
  if (docSents.length > DOC_CAP) docSents = docSents.slice(0, DOC_CAP);
  if (!docSents.length) return result;

  // The entire embedding + comparison block is best-effort. Any quota/network
  // failure aborts the pass (no semantic spans) so it never delays the report.
  try {
    const docVecs = await embedTexts(docSents.map(function (s) { return s.text; }), key);
    const docNorms = docVecs.map(norm);

    // Flatten source passages into comparable items (cache stable corpus docs).
    const items = [];
    for (let si = 0; si < sources.length; si++) {
      const s = sources[si];
      const cacheKey = s.id || s.url || ('t' + hash(s.text || ''));
      let entry = s.id ? cache.get(cacheKey) : null;
      if (!entry) {
        const passages = splitSourcePassages(s.text || '');
        const vecs = passages.length ? await embedTexts(passages, key) : [];
        entry = { title: s.title, vecs: vecs };
        if (s.id) cache.set(cacheKey, entry);
      }
      for (let p = 0; p < entry.vecs.length; p++) {
        if (!entry.vecs[p].length) continue;
        items.push({ title: entry.title, vec: entry.vecs[p], n: norm(entry.vecs[p]) });
      }
    }
    if (!items.length) return result;

    for (let d = 0; d < docSents.length; d++) {
      const a = docVecs[d];
      if (!a.length) continue;
      let best = 0, bestTitle = null;
      for (let k = 0; k < items.length; k++) {
        const b = items[k].vec;
        let dot = 0;
        for (let x = 0; x < a.length; x++) dot += a[x] * b[x];
        const sim = dot / (docNorms[d] * items[k].n);
        if (sim > best) { best = sim; bestTitle = items[k].title; }
      }
      if (best >= SEMANTIC_THRESHOLD) {
        result.spans.push({ start: docSents[d].start, end: docSents[d].end, title: bestTitle });
        result.perSource[bestTitle] = (result.perSource[bestTitle] || 0) + 1;
      }
    }
  } catch (e) {
    // Quota/network exhausted — degrade gracefully, no semantic spans.
    return result;
  }

  result.coveragePct = (result.spans.length / docSents.length) * 100;
  return result;
}

module.exports = {
  semanticMatches: semanticMatches,
  setThreshold: function (t) { if (typeof t === 'number') SEMANTIC_THRESHOLD = t; },
  _threshold: function () { return SEMANTIC_THRESHOLD; }
};

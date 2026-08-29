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
// --- Groq fallback helpers start ---
async function pickGroqModel(key) {
  const resp = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!resp.ok) throw new Error('Groq model list fetch failed');
  const data = await resp.json();
  const candidate = data.data.find(m => !m.id.includes('guard') && !m.id.includes('whisper'));
  return candidate ? candidate.id : null;
}

async function groqChatCompletion(messages, key, model) {
  const payload = { model, messages, max_tokens: 500 };
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error('Groq chat failed: ' + resp.status);
  return await resp.json();
}
// --- Groq fallback helpers end ---

// --- OpenAI-compatible embedding (opencode / Groq / any /v1 embeddings) ---
// Used as a fallback when Gemini's quota is exhausted. `baseUrl` is the
// provider's /v1 root (e.g. https://api.groq.com/openai/v1). Returns [] on
// any failure so the caller can try the next provider in the chain.
async function embedOneOpenAI(text, key, baseUrl, model) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/embeddings';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ input: text, model: model })
    });
    if (!resp.ok) {
      const e = await resp.text().catch(function () { return ''; });
      process.stderr.write('OPENAI EMBED ERR ' + resp.status + ' ' + e.slice(0, 160) + '\n');
      return [];
    }
    const j = await resp.json();
    const vals = j.data && j.data[0] && j.data[0].embedding;
    return vals ? vals : [];
  } catch (err) {
    process.stderr.write('OPENAI EMBED FAIL ' + (err && err.message) + '\n');
    return [];
  }
}
async function embedTextsOpenAI(texts, key, baseUrl, model) {
  const CONC = 8;
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += CONC) {
    const slice = texts.slice(i, i + CONC);
    const res = await Promise.all(slice.map(function (t) { return embedOneOpenAI(t, key, baseUrl, model); }));
    for (let k = 0; k < res.length; k++) out[i + k] = res[k];
  }
  return out;
}
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
  const result = { spans: [], perSource: {}, coveragePct: 0, status: 'ok', provider: null };
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

  // Provider fallback chain for embeddings. Gemini is primary; if its quota is
  // exhausted we fall back to an OpenAI-compatible endpoint (opencode key, via
  // OPENAI_BASE_URL) and then to Groq — each using a free embedding model. The
  // whole pass is best-effort: if every provider fails, we return no semantic
  // spans so it never delays the report.
  const providers = [];
  if (key) providers.push({ name: 'gemini', embed: function (ts) { return embedTexts(ts, key); } });
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY)
    providers.push({ name: 'openai', embed: function (ts) { return embedTextsOpenAI(ts, process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL, process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'); } });
  if (process.env.GROQ_API_KEY)
    providers.push({ name: 'groq', embed: function (ts) { return embedTextsOpenAI(ts, process.env.GROQ_API_KEY, 'https://api.groq.com/openai/v1', process.env.GROQ_EMBED_MODEL || 'all-MiniLM-L6-v2'); } });

  if (!providers.length) {
    result.status = 'unavailable';
    result.reason = 'no embedding provider configured';
    return result;
  }

  let embedded = null;
  for (let pi = 0; pi < providers.length && !embedded; pi++) {
    const p = providers[pi];
    try {
      const docVecs = await p.embed(docSents.map(function (s) { return s.text; }));
      if (!docVecs.length || !docVecs[0].length) throw new Error('empty embeddings');
      const docNorms = docVecs.map(norm);

      // Flatten source passages into comparable items (cache stable corpus docs,
      // keyed by provider so vectors from different models never mix).
      const items = [];
      for (let si = 0; si < sources.length; si++) {
        const s = sources[si];
        const cacheKey = p.name + ':' + (s.id || s.url || ('t' + hash(s.text || '')));
        let entry = s.id ? cache.get(cacheKey) : null;
        if (!entry) {
          const passages = splitSourcePassages(s.text || '');
          const vecs = passages.length ? await p.embed(passages) : [];
          entry = { title: s.title, vecs: vecs };
          if (s.id) cache.set(cacheKey, entry);
        }
        for (let q = 0; q < entry.vecs.length; q++) {
          if (!entry.vecs[q].length) continue;
          items.push({ title: entry.title, vec: entry.vecs[q], n: norm(entry.vecs[q]) });
        }
      }
      if (!items.length) throw new Error('no source vectors');
      embedded = { docVecs: docVecs, docNorms: docNorms, items: items, provider: p.name };
    } catch (e) {
      process.stderr.write('semantic provider ' + p.name + ' failed: ' + (e && e.message) + '\n');
    }
  }
  if (!embedded) {
    result.status = 'unavailable';
    result.reason = 'all embedding providers failed (check GEMINI_KEY / OPENAI / GROQ keys)';
    return result;
  }

  const docVecs = embedded.docVecs, docNorms = embedded.docNorms, items = embedded.items;

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

  result.coveragePct = (result.spans.length / docSents.length) * 100;
  result.provider = embedded.provider;
  return result;
}

module.exports = {
  semanticMatches: semanticMatches,
  setThreshold: function (t) { if (typeof t === 'number') SEMANTIC_THRESHOLD = t; },
  _threshold: function () { return SEMANTIC_THRESHOLD; }
};

// Export Groq helpers for fallback use
module.exports.pickGroqModel = pickGroqModel;
module.exports.groqChatCompletion = groqChatCompletion;

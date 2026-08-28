/*
 * Plagiarism Checker — Vercel serverless function.
 *
 * Vercel is serverless, so the long-running `node server.js` (server.listen)
 * does not run there. Instead this file is deployed as a function at
 *   POST /api/web-sources   { text, key? }  ->  { sources: [{ title, url, text }] }
 *
 * Vercel serves index.html + /assets/* automatically; only the API needs code.
 * The browser (app.js) POSTs to the SAME relative path, so nothing changes
 * on the frontend.
 *
 * Web sources: Wikipedia's free, key-less, fast API is the PRIMARY source and
 * detects verbatim copies of Wikipedia articles reliably. A SerpAPI (Google)
 * key — if set via SERPAPI_KEY env or sent in body.key — is a fallback for
 * non-Wikipedia text. Both are parallelised and capped so they never exceed
 * Vercel's function-timeout budget.
 */

'use strict';

const https = require('https');
const http = require('http');

const UA = 'PlagiarismChecker/1.0 (https://plagiarism-checker-teal.vercel.app; educational originality engine)';

// ---------- HTML -> plain text ----------
function extractText(html) {
  let s = html || '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/[ \r]+/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return s;
}

// ---------- fetch a URL (with one redirect follow) ----------
function fetchUrl(target, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch (e) { return resolve(null); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(null);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u.href, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      timeout: timeoutMs || 4000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, u.href).href, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(Buffer.concat(chunks).toString('utf8')); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------- Wikipedia API (primary, free, no key) ----------
function wikiGet(params, timeoutMs) {
  return new Promise((resolve) => {
    const target = 'https://en.wikipedia.org/w/api.php?' + params;
    const req = https.get(target, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: timeoutMs || 6000
    }, (res) => {
      // Retry once on rate-limit (429) so a transient throttle doesn't blank the scan.
      if (res.statusCode === 429) { res.resume(); setTimeout(() => wikiGet(params, timeoutMs).then(resolve), 1200); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Return up to `limit` Wikipedia article titles whose plain-text extract is
// likely to contain the sentence used as the query.
async function wikiSearch(query, limit) {
  const j = await wikiGet(
    'action=query&list=search&srsearch=' + encodeURIComponent(query) +
    '&srlimit=' + (limit || 3) + '&format=json&utf8=1',
    5000
  );
  if (!j || !j.query || !j.query.search) return [];
  return j.query.search.map(function (r) { return r.title; }).filter(Boolean);
}

// Fetch the plain-text extract of one Wikipedia article.
async function wikiExtract(title) {
  const j = await wikiGet(
    'action=query&prop=extracts&explaintext=1&redirects=1&titles=' +
    encodeURIComponent(title) + '&format=json&utf8=1',
    6000
  );
  if (!j || !j.query || !j.query.pages) return null;
  const pages = Object.keys(j.query.pages).map(function (k) { return j.query.pages[k]; });
  if (!pages.length) return null;
  const txt = pages[0].extract || '';
  if (txt.length < 120) return null;
  const slug = encodeURIComponent(title).replace(/%20/g, '_');
  return { title: pages[0].title || title, url: 'https://en.wikipedia.org/wiki/' + slug, text: txt.slice(0, 20000) };
}

// ---------- SerpAPI (Google) — optional fallback, requires a key ----------
function searchSerpapi(query, apiKey) {
  if (!apiKey) return Promise.resolve([]);
  return new Promise((resolve) => {
    const target = 'https://serpapi.com/search.json?engine=google&num=10&q=' +
      encodeURIComponent(query) + '&api_key=' + encodeURIComponent(apiKey);
    const req = https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve((j.organic_results || []).map(function (r) { return r.link; }).filter(Boolean).slice(0, 6));
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// Parallel, capped SerpAPI path — only used when Wikipedia yields little and a
// key is present, so it can never exceed the timeout budget.
async function serpSources(queries, apiKey) {
  if (!apiKey) return [];
  const results = await Promise.all(queries.map(function (q) { return searchSerpapi(q, apiKey); }));
  const urls = [];
  results.forEach(function (us) {
    us.slice(0, 2).forEach(function (u) { if (u && urls.indexOf(u) === -1 && urls.length < 16) urls.push(u); });
  });
  const pages = await Promise.all(urls.map(function (u) { return fetchUrl(u, 4000); }));
  const sources = [];
  for (let i = 0; i < urls.length; i++) {
    const html = pages[i];
    if (!html) continue;
    const t = extractText(html);
    if (t.length >= 120) sources.push({ title: urls[i], url: urls[i], text: t.slice(0, 20000) });
  }
  return sources;
}

// ---------- pick distinctive, TOPIC-DIVERSE sentences as search queries ----------
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 40; });
}

async function webSources(text, apiKey) {
  var STOP = new Set(('the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been being has had did does doing would should could shall may might must this that these those it its he she they we you i me him her them my your his our their us not no so than too very just also only even there what which who whom whose when where why how').split(/\s+/));
  function rareCount(s) { var w = s.toLowerCase().split(/[^a-z]+/), n = 0; for (var i = 0; i < w.length; i++) if (w[i].length >= 7 && !STOP.has(w[i])) n++; return n; }
  function rareWords(s) { return new Set(s.toLowerCase().split(/[^a-z]+/).filter(function (w) { return w.length >= 7 && !STOP.has(w); })); }

  var picked = [];
  if (text && text.length) {
    // Score every long sentence, then greedily pick a DIVERSE set so every topic
    // in the document gets its own search query — not just the densest section.
    // Diversity = rare-word coverage: once a topic's vocabulary (artificial /
    // intelligence / neural …) is represented, further sentences from it add
    // little and are skipped in favour of topics with NEW vocabulary (greenhouse,
    // mausoleum …). Without this, a long section crowds out the others and
    // multi-topic plagiarism is missed.
    const cands = splitSentences(text).map(function (s) {
      return { s: s, score: s.length + rareCount(s) * 15, rare: rareWords(s) };
    });
    cands.sort(function (a, b) { return b.score - a.score; });
    const covered = new Set();
    const MAXQ = 10;
    for (var k = 0; k < MAXQ; k++) {
      var best = null, bestNeu = 0, bestMetric = -1;
      for (var ci = 0; ci < cands.length; ci++) {
        const c = cands[ci];
        if (picked.indexOf(c.s) !== -1) continue;
        var neu = 0; c.rare.forEach(function (w) { if (!covered.has(w)) neu++; });
        const metric = neu * 1000 + c.score; // weight new vocabulary heavily
        if (metric > bestMetric) { bestMetric = metric; best = c; bestNeu = neu; }
      }
      if (!best || bestNeu === 0) break; // no new topic left to cover
      picked.push(best.s);
      best.rare.forEach(function (w) { covered.add(w); });
    }
  }

  // 1) Wikipedia — parallel search then parallel extract. Fast, free, reliable.
  const searchResults = await Promise.all(picked.map(function (q) { return wikiSearch(q, 3); }));
  const titles = [];
  searchResults.forEach(function (ts) {
    ts.forEach(function (t) { if (titles.indexOf(t) === -1 && titles.length < 12) titles.push(t); });
  });
  let sources = (await Promise.all(titles.map(function (t) { return wikiExtract(t); }))).filter(Boolean);

  // 2) SerpAPI fallback only if Wikipedia found few sources and a key is present.
  if (sources.length < 3 && apiKey) {
    const extra = await serpSources(picked, apiKey);
    sources = sources.concat(extra);
  }

  // De-duplicate by URL.
  const seen = new Set();
  return sources.filter(function (s) {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// ---------- request body (Vercel may pre-parse JSON into req.body) ----------
function readJson(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    return req.body;
  }
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const data = await readJson(req);
    const text = (data.text || '').trim();
    const apiKey = (data.key || process.env.SERPAPI_KEY || '').trim();
    if (text.length < 20) {
      res.end(JSON.stringify({ sources: [], error: 'text too short' }));
      return;
    }
    const sources = await webSources(text, apiKey);
    const payload = { sources: sources, count: sources.length };
    if (sources.length === 0) {
      payload.notice = 'No live web sources matched. The local reference corpus was used instead. Paste a SERPAPI_KEY for broader Google coverage of non-Wikipedia text.';
    }
    res.end(JSON.stringify(payload));
  } catch (e) {
    res.end(JSON.stringify({ sources: [], error: String(e && e.message || e) }));
  }
};

// Shared so the local `server.js` and this Vercel function run identical code.
module.exports.webSources = webSources;

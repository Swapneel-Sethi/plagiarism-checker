/*
 * Plagiarism Checker — local backend.
 *
 * 1. Serves the static site (so the API and the page share an origin).
 * 2. POST /api/web-sources  { text, key? }  ->  { sources: [{ title, url, text }] }
 *    Searches the web for distinctive passages from the document, fetches the
 *    top result pages, extracts their text, and returns them. The browser then
 *    feeds these into the SAME engine (engine.js) for shingle-containment scoring.
 *
 * The web-scan implementation lives in api/web-sources.js so the local server
 * and the Vercel deployment run the EXACT same code (Wikipedia is the primary,
 * key-less, fast source; SerpAPI is an optional Google fallback).
 *
 * Run:  node server.js [SERPAPI_KEY]   then open http://localhost:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;

// Single source of truth for web scanning — shared with the Vercel function.
const { webSources } = require('./api/web-sources');
const { semanticMatches } = require('./api/semantic');
const PE = require('./assets/engine.js');
const CORPUS = require('./assets/corpus.js');

// Load a local .env file (SERPAPI_KEY=xxxx) — no external dependencies.
function loadEnv() {
  try {
    const f = path.join(ROOT, '.env');
    if (!fs.existsSync(f)) return;
    fs.readFileSync(f, 'utf8').split('\n').forEach(function (line) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) { /* ignore */ }
}
loadEnv();
if (process.argv[2]) process.env.SERPAPI_KEY = process.argv[2]; // one-step: node server.js YOUR_KEY

const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml'
};

// ---------- helpers ----------
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error((label || 'operation') + ' timed out')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}
function safeJson(body) {
  try { return JSON.parse(body || '{}'); } catch (e) { return {}; }
}
const WEB_MS = 18000;
const SEMANTIC_MS = 25000;

// ---------- request router ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);

  if (parsed.pathname === '/api/web-sources' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const data = JSON.parse(body || '{}');
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
    });
    return;
  }

  if (parsed.pathname === '/api/analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const data = safeJson(body);
        const text = (data.text || '').trim();
        if (text.length < 20) { res.end(JSON.stringify({ error: 'text too short' })); return; }

        const apiKey = (data.key || process.env.SERPAPI_KEY || '').trim();
        const doWeb = data.scanWeb !== false;
        const gk = process.env.GEMINI_KEY;
        let sources = CORPUS.slice();
        let notice = '';

        // 1) Web scan (best-effort, bounded). Wikipedia + SerpAPI.
        if (doWeb) {
          try {
            const ws = await withTimeout(webSources(text, apiKey), WEB_MS, 'Web scan');
            if (ws && ws.length) sources = sources.concat(ws);
            else notice = 'No live web sources matched. Compared against the local reference corpus. Paste a SERPAPI_KEY for broader Google coverage.';
          } catch (e) {
            notice = 'Web scan unavailable (' + (e.message || e) + '). Compared against the local corpus.';
          }
        }

        // 2) Offline word-match + fuzzy (FAST, no network) — always returns.
        const pre = PE.analyzePlagiarism(text, sources);

        // 3) Semantic (reworded) pass — Gemini embeddings. Best-effort, bounded.
        let extraSpans = [];
        if (gk) {
          try {
            const sem = await withTimeout(
              semanticMatches(text, sources, gk, pre.coveredRanges || []),
              SEMANTIC_MS,
              'Semantic scan'
            );
            extraSpans = sem.spans || [];
            const semCount = Object.keys(sem.perSource || {}).length;
            if (semCount) {
              notice += (notice ? ' ' : '') + 'Semantic scan flagged ' + sem.spans.length + ' reworded sentence(s) across ' + semCount + ' source(s).';
            } else {
              notice += (notice ? ' ' : '') + 'Semantic scan found no reworded matches (Gemini quota may be exhausted).';
            }
          } catch (e) {
            notice += (notice ? ' ' : '') + 'Semantic scan skipped (' + (e.message || e) + ').';
          }
        } else {
          notice += (notice ? ' ' : '') + 'No Gemini key — reworded-text detection disabled.';
        }

        const rep = PE.fullReport(text, sources, extraSpans);
        rep.corpusCount = sources.length;
        rep.webNote = notice.trim();
        res.end(JSON.stringify(rep));
      } catch (e) {
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    });
    return;
  }

  serveStatic(parsed.pathname, res);
});

function serveStatic(pathname, res) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.normalize(path.join(ROOT, p));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log('Plagiarism Checker running at http://localhost:' + PORT);
  console.log('Search provider: ' + (process.env.SERPAPI_KEY ? 'SerpAPI (keyed) + Wikipedia' : 'Wikipedia (keyless) + SerpAPI fallback'));
});

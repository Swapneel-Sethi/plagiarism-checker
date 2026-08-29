/*
 * Vercel serverless function: POST /api/analyze
 *
 * Runs the full plagiarism analysis server-side (the browser only sends text
 * and renders the result): web sources + Gemini semantic (reworded-text) pass
 * + the offline engine, merged into one report. Mirrors the /api/analyze route
 * in server.js (which is the local equivalent).
 *
 * Robustness contract: the report MUST always return within the function
 * timeout. The offline word-match + fuzzy pass is fast and network-free, so it
 * is computed first and is always returned. The web scan and the Gemini
 * semantic pass are best-effort and wrapped in hard timeouts — if either stalls
 * or exhausts its quota, the report still returns with what we have.
 */
'use strict';

const { webSources } = require('./web-sources');
const { semanticMatches } = require('./semantic');
const PE = require('../assets/engine.js');
const CORPUS = require('../assets/corpus.js');

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

const WEB_MS = 18000;     // Wikipedia + SerpAPI scan budget
const SEMANTIC_MS = 25000; // Gemini embedding budget (best-effort)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }
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
      let notice = '';
      let sources = CORPUS.slice();

      // 1) Web scan (best-effort, bounded). Wikipedia + SerpAPI.
      if (doWeb) {
        try {
          const ws = await withTimeout(webSources(text, apiKey), WEB_MS, 'Web scan');
          if (ws && ws.length) sources = sources.concat(ws);
          else notice = 'No live web sources matched. Compared against the local reference corpus.';
        } catch (e) {
          notice = 'Web scan unavailable (' + (e.message || e) + '). Compared against the local corpus.';
        }
      }

      // 2) Offline word-match + fuzzy (FAST, no network) — always returns.
      const pre = PE.analyzePlagiarism(text, sources);

      // 3) Semantic reworded-text pass (Gemini) — best-effort, bounded, never blocks.
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
            notice += (notice ? ' ' : '') + 'Semantic scan flagged ' + sem.spans.length +
              ' reworded sentence(s) across ' + semCount + ' source(s) [provider: ' + (sem.provider || '?') + '].';
          } else if (sem.status === 'unavailable') {
            notice += (notice ? ' ' : '') + 'Semantic (reworded-text) scan is unavailable: ' +
              (sem.reason || 'embedding provider failed') + '. Falling back to exact/fuzzy matching only.';
          } else {
            notice += (notice ? ' ' : '') + 'Semantic scan ran (' + (sem.provider || '?') +
              ') and found no reworded matches.';
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
};

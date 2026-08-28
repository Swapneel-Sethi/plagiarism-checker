# Plagiarism Checker — Originality Engine

A static, offline plagiarism + AI-writing checker built with the MekaVerse
monochrome gallery design (pure black void, white ink, hairline chrome).

## Run it

No build step. Either:

- Double-click `index.html`, **or**
- Serve it (recommended for file uploads):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Web-wide scanning (backend)

For plagiarism against the **live web**, run the Node backend (it also serves the
site, so the API and page share an origin):

```bash
node server.js
# then open http://localhost:3000
```

Tick **SCAN THE WEB** in the Submit section. For reliable scanning, paste your
SerpAPI key into the **SERPAPI KEY** box (saved in your browser, sent only to this
local server) — or launch with `node server.js YOUR_KEY`. The backend searches the
web for distinctive sentences from your document, fetches the top result pages,
extracts their text, and feeds those pages into the same `engine.js` shingle-
containment logic — so web matches show up in the same report as local ones.

Notes:
- The SerpAPI key can be supplied three ways (all optional): pasted into the
  **SERPAPI KEY** box on the page, passed as `node server.js YOUR_KEY`, or set in a
  `.env` file (`SERPAPI_KEY=xxxx`). On Vercel, set it as the `SERPAPI_KEY`
  environment variable (see below). Without a key, search falls back to DuckDuckGo/Bing
  (best-effort, may be rate-limited/blocked).
- If the web search returns nothing, the report shows a notice and falls back
  to the local corpus automatically.
- Opening `index.html` directly (file://) skips the backend; web scanning then
  silently falls back to the local corpus.
- Scanned/image-only PDFs still have no extractable text (no OCR).

## Deploy to Vercel

Vercel is serverless, so the long-running `node server.js` does not run there.
The backend is already ported into a serverless function at `api/web-sources.js`,
and Vercel serves `index.html` + `assets/*` automatically — the frontend POSTs
to the same relative path, so no code changes are needed.

1. Push this folder to a Git repo (or run `npx vercel` in it).
2. Set the SerpAPI key as an environment variable (do **not** commit it):
   ```bash
   npx vercel env add SERPAPI_KEY
   # paste your key when prompted, scope to Production + Preview + Development
   ```
   (Or add it under Project → Settings → Environment Variables in the Vercel dashboard.)
3. Deploy:
   ```bash
   npx vercel --prod
   ```
4. Open the deployed URL, tick **SCAN THE WEB**, hit **RUN ANALYSIS**. Web
   scanning now runs through the function using the `SERPAPI_KEY` env var — the
   in-page key box still works as an override if you prefer.

`vercel.json` sets the function timeout to 30s (web fetch + text extraction can
take a few seconds). The local `server.js` is kept for `node server.js` dev use
and is ignored by Vercel.

## What it does

**Plagiarism** — splits your document into 5-word shingles, builds a set, and
measures *containment* against each reference document in the corpus:
`matched_shingles / doc_shingles * 100`. Matched passages are highlighted in
the Document Map, and each source is listed with its overlap %.

**AI-writing index** — eight stylometric parameters, each scored 0–1 and
averaged into a single index:

1. Burstiness (sentence-length variance)
2. Rare-word ratio
3. Function-word density
4. Hedge / boilerplate phrases
5. Repeated 4-gram ratio
6. Type-token ratio (vocabulary diversity)
7. Average word length
8. Comma density

## Limitations (read this)

This is a **heuristic engine**, not a certified classifier. With the backend
running (local `server.js` or the Vercel function) it scans the live web via
SerpAPI (Google results); without it, it only compares against the on-device
corpus. No engine can read every document on earth — web scanning covers
whatever is indexed by the search provider plus your local corpus. The AI
index is an estimate from writing style, not a definitive AI detector.

## Project layout

```
index.html          # markup + design shell
assets/styles.css    # MekaVerse tokens + components
assets/engine.js     # PE.fullReport(text, corpus) — the detection core
assets/corpus.js      # seed reference documents
assets/app.js         # UI wiring (paste/drop, analyze, corpus management)
server.js            # local dev backend (serves site + /api/web-sources)
api/web-sources.js   # Vercel serverless function (same backend, no server.listen)
vercel.json          # function timeout config
package.json         # pins Node engine for Vercel
```

## API

```js
const report = PE.fullReport(docText, corpusArray);
// report = {
//   plagiarismPct, aiIndex, perSource:[{title,pct}],
//   html,            // highlighted document
//   aiParams:[{label,raw,score,note}],
//   wordCount, docShingleCount
// }
```

Add reference documents at runtime via the Corpus panel (stored in
`localStorage`), or edit `assets/corpus.js` to seed them permanently.

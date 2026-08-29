# Project conventions

## Git — auto-push
After **every** change or update to this repo, commit and push to `origin/main`
automatically. Do not wait for a separate "push" request. This is a standing
instruction from the owner.

- Never commit secrets: `.env`, `.env.local`, `server.log` are git-ignored.
- Push code, configs, tests, and generated test fixtures together.
- Keep commits small and clearly described.

## Web scanning
The plagiarism web scan (`api/web-sources.js`) is **always on** — both backends
(`api/analyze.js` for Vercel and `server.js` for local) force `doWeb = true`.
The UI toggle in `index.html` is locked (disabled + checked). Do not re-add a
way to disable it.

## AI-writing detection
Stylometric ensemble in `assets/engine.js`. Verdicts: AI if `aiIndex >= 50`,
plagiarism if `plagiarismPct >= 20%`. The AI index is an *estimate*, not a
certifier. Tell-rich AI (delve/tapestry/crucial-role boilerplate) scores high
(e.g. ~90). Uniform, tell-free technical/formal prose is the hard case: reweighted
so it now crosses 50 on the test sample, but a careful human technical writer can
score similarly, so it stays inherently borderline. Do NOT lower the 50 threshold
to "fix" this — that would false-flag human assignments.

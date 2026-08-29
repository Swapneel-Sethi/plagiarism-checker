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
plagiarism if `plagiarismPct >= 20%`. Known limitation: uniform, tell-free
technical/formal prose lands in a borderline ~45-46 zone (indistinguishable from
human technical writing) — this is expected, not a bug to "fix" by lowering the
threshold, because that would false-flag human assignments.

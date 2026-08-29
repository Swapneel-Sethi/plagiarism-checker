'use strict';
// One-shot live probe of each API key. Prints only PASS/FAIL + HTTP codes,
// never the key values themselves.
const fs = require('fs');
function loadEnv() {
  try {
    const txt = fs.readFileSync('.env', 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (e) { /* ignore */ }
}
loadEnv();

function mask(k) { return k ? (k.slice(0, 4) + '…' + k.slice(-4)) : '(none)'; }

async function testGemini() {
  const key = process.env.GEMINI_KEY;
  if (!key) return 'FAIL (no GEMINI_KEY)';
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: 'hello world' }] } })
    });
    if (r.ok) return 'PASS (HTTP ' + r.status + ')';
    const e = await r.text().catch(() => '');
    return 'FAIL (HTTP ' + r.status + ') ' + e.slice(0, 80);
  } catch (e) { return 'FAIL (net ' + e.message + ')'; }
}

async function testGroq() {
  const key = process.env.GROQ_API_KEY;
  if (!key) return 'FAIL (no GROQ_API_KEY)';
  // 1) model list (validates key)
  let model = 'llama-3.3-70b-versatile';
  try {
    const m = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key } });
    if (!m.ok) return 'FAIL model-list (HTTP ' + m.status + ')';
    const data = await m.json();
    const c = (data.data || []).find(x => !x.id.includes('guard') && !x.id.includes('whisper'));
    if (c) model = c.id;
  } catch (e) { return 'FAIL model-list (net ' + e.message + ')'; }
  // 2) chat completion
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 5 })
    });
    if (r.ok) return 'PASS chat (HTTP ' + r.status + ', model=' + model + ')';
    const e = await r.text().catch(() => '');
    return 'FAIL chat (HTTP ' + r.status + ') ' + e.slice(0, 80);
  } catch (e) { return 'FAIL chat (net ' + e.message + ')'; }
}

async function testOpencode() {
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL;
  if (!key) return 'FAIL (no OPENAI_API_KEY / opencode key)';
  if (!base) return 'BLOCKED: key present (' + mask(key) + ') but OPENAI_BASE_URL is empty — provider cannot fire. Needs e.g. https://<gateway>/v1';
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ input: 'hello', model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small' })
    });
    if (r.ok) return 'PASS (HTTP ' + r.status + ')';
    const e = await r.text().catch(() => '');
    return 'FAIL (HTTP ' + r.status + ') ' + e.slice(0, 80);
  } catch (e) { return 'FAIL (net ' + e.message + ')'; }
}

async function testSerp() {
  const key = process.env.SERPAPI_KEY;
  if (!key) return 'FAIL (no SERPAPI_KEY)';
  try {
    const r = await fetch('https://serpapi.com/search.json?engine=google&q=test&num=1&api_key=' + encodeURIComponent(key));
    if (r.ok) return 'PASS (HTTP ' + r.status + ')';
    const e = await r.text().catch(() => '');
    return 'FAIL (HTTP ' + r.status + ') ' + e.slice(0, 80);
  } catch (e) { return 'FAIL (net ' + e.message + ')'; }
}

(async () => {
  console.log('=== LIVE KEY PROBE ===');
  console.log('GEMINI  : ' + await testGemini());
  console.log('GROQ    : ' + await testGroq());
  console.log('OPENC-AI: ' + await testOpencode());
  console.log('SERPAPI : ' + await testSerp());
  console.log('------------------------');
  console.log('OPENAI_BASE_URL = ' + JSON.stringify(process.env.OPENAI_BASE_URL || '') + '  (empty => opencode provider disabled)');
})();

const fs = require('fs');

const txt = fs.readFileSync('ACCURACY_TESTS.txt', 'utf8');
const blocks = txt.split(/(?=^=== SAMPLE )/m).map(s => s.trim()).filter(Boolean);

const samples = blocks.map(b => {
  const m = b.match(/^=== SAMPLE (\d+): \[(\w+)\][^\n]*\n([\s\S]*?)(?=^=== SAMPLE |$)/m);
  const num = m[1];
  const tag = m[2];
  const text = m[3].trim();
  return { num, tag, text };
});

function expected(s) {
  if (s.tag === 'PLAG') return { plag: '>=20', ai: 'any', label: 'plagiarism' };
  if (s.tag === 'AI') return { plag: 'any', ai: '>=50', label: 'AI' };
  return { plag: '<20', ai: '<50', label: 'human' }; // HUMAN
}

async function post(text) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch('http://localhost:3000/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, scanWeb: true }), signal: ctrl.signal
    });
    clearTimeout(t);
    return await r.json();
  } catch (e) { clearTimeout(t); return { error: e.message }; }
}

(async () => {
  let pass = 0, fail = 0;
  console.log('SAMPLE | TAG    | aiIdx | plag%  | top source (plag)            | verdict | exp            | result');
  console.log('-'.repeat(110));
  for (const s of samples) {
    const j = await post(s.text);
    if (j.error) { console.log(`S${s.num.padStart(2)}   | ${s.tag.padEnd(6)} | ERR   | ${j.error}`); continue; }
    const exp = expected(s);
    const ai = j.aiIndex, plag = +(j.plagiarismPct || 0).toFixed(1);
    const top = (j.perSource && j.perSource[0]) ? j.perSource[0].title.slice(0, 28) : '-';
    let ok = true;
    if (s.tag === 'PLAG') ok = plag >= 20;
    else if (s.tag === 'AI') ok = ai >= 50;
    else ok = ai < 50 && plag < 20;
    ok ? pass++ : fail++;
    const verdict = (s.tag === 'PLAG') ? (plag >= 20 ? 'PLAG' : 'clean')
                  : (ai >= 50 ? 'AI' : 'human');
    console.log(
      `S${s.num.padStart(2)}   | ${s.tag.padEnd(6)} | ${String(ai).padStart(4)} | ${String(plag).padStart(5)}% | ${top.padEnd(28)} | ${verdict.padEnd(7)} | ${exp.label.padEnd(13)} | ${ok ? 'PASS' : 'FAIL'}`
    );
    await new Promise(r => setTimeout(r, 800));
  }
  console.log('-'.repeat(110));
  console.log(`RESULT: ${pass} pass / ${fail} fail  (${samples.length} samples)`);
})();

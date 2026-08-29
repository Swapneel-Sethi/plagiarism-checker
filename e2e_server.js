/*
 * Full-fledged end-to-end test: pushes all 10 labelled documents through the
 * LIVE server (/api/analyze) so the server-side Gemini embedding (semantic)
 * pass is exercised, then scores verdict vs ground truth.
 *
 * Run (server must be up on PORT):  node e2e_server.js [baseUrl]
 */
'use strict';
const BASE = process.argv[2] || 'http://localhost:3100';
const PLAG = 20, AI = 50;

const DOCS = [
  { name: 'T1  Verbatin copy (Computation)', truth: { p: true, a: false },
    text: 'Computation is the mechanical manipulation of symbols according to a fixed set of rules. A computer, in the broadest sense, is any system that can represent information and transform that representation through deterministic steps. The power of computation does not come from speed alone but from the ability to compose simple operations into procedures of arbitrary depth.' },
  { name: 'T2  Original human narrative', truth: { p: false, a: false },
    text: 'Last summer my brother and I drove across the state to visit our grandmother. We got lost twice, ate terrible gas-station tacos, and somehow ended up on a ferry we never meant to take. She laughed when we told her, then fed us until we could barely move. I still think about that night whenever the weather turns cold.' },
  { name: 'T3  LLM-tell AI text', truth: { p: false, a: true },
    text: 'It is important to note that the realm of modern technology presents a multifaceted tapestry. We must delve into the complexities of this ever-evolving landscape. Artificial intelligence plays a crucial role in navigating these challenges. Moreover, such systems underscore the importance of robust, scalable infrastructure that can adapt to a myriad of use cases.' },
  { name: 'T4  Paraphrase (climate/carbon)', truth: { p: true, a: false },
    text: 'Carbon moves between the sky, the seas, and all living things in what scientists call the carbon cycle. People have upset that balance by freeing carbon that stayed buried in rock for ages. Burning coal and oil puts carbon dioxide into the air, where it holds in warmth that should radiate away. This slowly heats the planet, changing storms, lifting the oceans, and straining nature that is already struggling.' },
  { name: 'T5  Uniform mechanical AI text', truth: { p: false, a: true },
    text: 'Machine learning models process data through layers of weighted connections. These models adjust their parameters during training to reduce prediction error. The training process repeats until the error stabilizes at an acceptable level. Deployment then uses the trained model to classify new inputs. Performance depends on the quality and quantity of the training data.' },
  { name: 'T6  Mixed verbatim + original', truth: { p: true, a: false },
    text: 'Libraries began as collections of clay tablets and scrolls guarded by priests and kings who alone could read them. With the spread of paper and the printing press, books ceased to be rare objects and became instruments of ordinary education. My own town still has a small branch where I spent rainy afternoons as a kid, and I hope it never closes.' },
  { name: 'T7  Verbatim Gettysburg', truth: { p: true, a: false },
    text: "The Gettysburg Address is a dedication speech delivered by Abraham Lincoln, the 16th U.S. president, following the Battle of Gettysburg during the American Civil War. The speech has come to be viewed as one of the most famous, enduring, and historically significant speeches in American history. Lincoln delivered the speech on the afternoon of November 19, 1863, during a formal dedication of Soldiers' National Cemetery." },
  { name: 'T8  Human blog voice', truth: { p: false, a: false },
    text: "So I tried the new ramen place downtown, right? The broth was unreal — like, deeply savory in a way I didn't expect from a strip-mall spot. My friend ordered the spicy one and immediately regretted every life choice that led her there. We went back three days later. No regrets." },
  { name: 'T9  Very short text', truth: { p: false, a: false },
    text: 'I love my cat and her tiny paws.' },
  { name: 'T10 Empty / whitespace', truth: { p: false, a: false },
    text: '    ' }
];

async function post(text) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50000);
  try {
    const r = await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, scanWeb: true }), signal: ctrl.signal
    });
    return await r.json();
  } finally { clearTimeout(t); }
}

(async () => {
  const dim = { p: 0, a: 0 }; const total = DOCS.length; let all = 0;
  console.log('=== FULL E2E via live server (' + BASE + ') ===\n');
  console.log('TEST'.padEnd(40) + 'PLAG%'.padStart(7) + 'AI'.padStart(5) + '  verdict (P/A) vs truth');
  console.log('-'.repeat(78));
  for (const d of DOCS) {
    let j;
    try { j = await post(d.text); } catch (e) { j = { plagiarismPct: 0, aiIndex: 0, webNote: 'ERR ' + e.message }; }
    if (!j || typeof j.plagiarismPct !== 'number') j = Object.assign({ plagiarismPct: 0, aiIndex: 0 }, j || {});
    if (typeof j.aiIndex !== 'number') j.aiIndex = 0;
    const plag = (j.plagiarismPct || 0) >= PLAG;
    const ai = (j.aiIndex || 0) >= AI;
    const got = (plag ? 'P' : '.') + (ai ? 'A' : '.');
    const want = (d.truth.p ? 'P' : '.') + (d.truth.a ? 'A' : '.');
    if (plag === d.truth.p) dim.p++;
    if (ai === d.truth.a) dim.a++;
    if (plag === d.truth.p && ai === d.truth.a) all++;
    const pct = (j.plagiarismPct || 0).toFixed(1);
    const aiS = String(j.aiIndex || 0);
    const src = (j.perSource && j.perSource[0]) ? ' [' + j.perSource[0].title.slice(0, 22) + ']' : '';
    console.log(d.name.padEnd(40) + pct.padStart(7) + aiS.padStart(5) + '  ' + got.padEnd(13) + ' vs ' + want + src);
  }
  console.log('-'.repeat(78));
  const acc = n => ((n / total) * 100).toFixed(1) + '%';
  console.log('\n=== ACCURACY (verdict vs labelled ground truth) ===');
  console.log('  Checking Plagiarism : ' + dim.p + '/' + total + '  = ' + acc(dim.p));
  console.log('  AI Writing          : ' + dim.a + '/' + total + '  = ' + acc(dim.a));
  console.log('  Both correct        : ' + all + '/' + total + '  = ' + acc(all));
})();

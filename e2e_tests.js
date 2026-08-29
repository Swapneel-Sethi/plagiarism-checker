/*
 * End-to-end test harness for the Plagiarism / AI-writing engine.
 *
 * Loads the SAME detection core the browser uses (assets/engine.js) and the
 * reference corpus (assets/corpus.js), then runs 10 documents of known
 * provenance through PE.fullReport(). For each capability we compare the
 * engine's verdict to the labelled ground truth and report accuracy.
 *
 * Decision thresholds (documented, not hidden):
 *   - Plagiarism flagged  if plagiarismPct  >= 20
 *   - AI-writing flagged  if aiIndex        >= 50
 *
 * Run:  node e2e_tests.js
 */
'use strict';

const PE = require('./assets/engine.js');
const CORPUS = require('./assets/corpus.js');

const PLAGIARISM_FLAG = 20; // %
const AI_FLAG = 50;         // index 0-100

// --- ground-truth documents ------------------------------------------------
// truth: { plagiarism, ai }  (booleans)
const TESTS = [
  {
    name: 'T1  Verbatim copy of corpus doc (Computation)',
    truth: { plagiarism: true, ai: false },
    text:
      'Computation is the mechanical manipulation of symbols according to a fixed set of rules. ' +
      'A computer, in the broadest sense, is any system that can represent information and transform that representation through deterministic steps. ' +
      'The power of computation does not come from speed alone but from the ability to compose simple operations into procedures of arbitrary depth.'
  },
  {
    name: 'T2  Original human narrative (first person, varied)',
    truth: { plagiarism: false, ai: false },
    text:
      'Last summer my brother and I drove across the state to visit our grandmother. ' +
      'We got lost twice, ate terrible gas-station tacos, and somehow ended up on a ferry we never meant to take. ' +
      'She laughed when we told her, then fed us until we could barely move. ' +
      'I still think about that night whenever the weather turns cold.'
  },
  {
    name: 'T3  LLM-tell-laden AI text (delve/realm/tapestry…)',
    truth: { plagiarism: false, ai: true },
    text:
      'It is important to note that the realm of modern technology presents a multifaceted tapestry. ' +
      'We must delve into the complexities of this ever-evolving landscape. ' +
      'Artificial intelligence plays a crucial role in navigating these challenges. ' +
      'Moreover, such systems underscore the importance of robust, scalable infrastructure that can adapt to a myriad of use cases.'
  },
  {
    name: 'T4  Paraphrase of corpus doc (Climate/carbon cycle)',
    truth: { plagiarism: true, ai: false },
    text:
      'Carbon moves between the sky, the seas, and all living things in what scientists call the carbon cycle. ' +
      'People have upset that balance by freeing carbon that stayed buried in rock for ages. ' +
      'Burning coal and oil puts carbon dioxide into the air, where it holds in warmth that should radiate away. ' +
      'This slowly heats the planet, changing storms, lifting the oceans, and straining nature that is already struggling.'
  },
  {
    name: 'T5  Uniform mechanical AI text (no obvious tells)',
    truth: { plagiarism: false, ai: true },
    text:
      'Machine learning models process data through layers of weighted connections. ' +
      'These models adjust their parameters during training to reduce prediction error. ' +
      'The training process repeats until the error stabilizes at an acceptable level. ' +
      'Deployment then uses the trained model to classify new inputs. ' +
      'Performance depends on the quality and quantity of the training data.'
  },
  {
    name: 'T6  Mixed verbatim + original (Libraries)',
    truth: { plagiarism: true, ai: false },
    text:
      'Libraries began as collections of clay tablets and scrolls guarded by priests and kings who alone could read them. ' +
      'With the spread of paper and the printing press, books ceased to be rare objects and became instruments of ordinary education. ' +
      'My own town still has a small branch where I spent rainy afternoons as a kid, and I hope it never closes.'
  },
  {
    name: 'T7  Verbatim Gettysburg Address (corpus doc)',
    truth: { plagiarism: true, ai: false },
    text:
      'The Gettysburg Address is a dedication speech delivered by Abraham Lincoln, the 16th U.S. president, following the Battle of Gettysburg during the American Civil War. ' +
      'The speech has come to be viewed as one of the most famous, enduring, and historically significant speeches in American history. ' +
      'Lincoln delivered the speech on the afternoon of November 19, 1863, during a formal dedication of Soldiers\' National Cemetery.'
  },
  {
    name: 'T8  Human blog voice (colloquial, contractions)',
    truth: { plagiarism: false, ai: false },
    text:
      'So I tried the new ramen place downtown, right? ' +
      'The broth was unreal — like, deeply savory in a way I didn\'t expect from a strip-mall spot. ' +
      'My friend ordered the spicy one and immediately regretted every life choice that led her there. ' +
      'We went back three days later. No regrets.'
  },
  {
    name: 'T9  Very short text (edge case, <10 words)',
    truth: { plagiarism: false, ai: false },
    text: 'I love my cat and her tiny paws.'
  },
  {
    name: 'T10 Empty / whitespace input (edge case)',
    truth: { plagiarism: false, ai: false },
    text: '    '
  }
];

function verdict(r) {
  const plag = r.plagiarismPct >= PLAGIARISM_FLAG;
  const ai = r.aiIndex >= AI_FLAG;
  return { plag, ai };
}

// --- run ----------------------------------------------------------------
const dim = { plagiarism: 0, ai: 0 };
const total = TESTS.length;
let passBoth = 0;

console.log('=== Plagiarism / AI-writing — 10 end-to-end tests ===\n');
console.log(
  'TEST'.padEnd(46) +
  'PLAG%'.padStart(7) +
  'AI'.padStart(5) +
  '  verdict (P/A)  vs truth'
);
console.log('-'.repeat(100));

TESTS.forEach((t) => {
  let r, v;
  let crashed = false;
  try {
    r = PE.fullReport(t.text, CORPUS);
    v = verdict(r);
  } catch (e) {
    crashed = true;
    r = { plagiarismPct: NaN, aiIndex: NaN };
    v = { plag: false, ai: false };
  }
  const got = (v.plag ? 'P' : '.') + (v.ai ? 'A' : '.');
  const want = (t.truth.plagiarism ? 'P' : '.') + (t.truth.ai ? 'A' : '.');
  const okP = v.plag === t.truth.plagiarism;
  const okA = v.ai === t.truth.ai;
  if (okP) dim.plagiarism++;
  if (okA) dim.ai++;
  if (okP && okA) passBoth++;

  const pct = Number.isNaN(r.plagiarismPct) ? 'ERR' : r.plagiarismPct.toFixed(1);
  const ai = Number.isNaN(r.aiIndex) ? 'ERR' : String(r.aiIndex);
  console.log(
    t.name.padEnd(46) +
    pct.padStart(7) +
    ai.padStart(5) +
    '  ' + got.padEnd(13) + ' vs ' + want +
    (crashed ? '  [CRASHED]' : '')
  );
});

console.log('-'.repeat(100));
const acc = (n) => ((n / total) * 100).toFixed(1) + '%';
console.log('\n=== ACCURACY (verdict vs labelled ground truth) ===');
console.log('  Checking Plagiarism : ' + dim.plagiarism + '/' + total + '  = ' + acc(dim.plagiarism));
console.log('  AI Writing          : ' + dim.ai + '/' + total + '  = ' + acc(dim.ai));
console.log('  Both correct        : ' + passBoth + '/' + total + '  = ' + acc(passBoth));
console.log('\nThresholds: Plagiarism >= ' + PLAGIARISM_FLAG + '%, AI index >= ' + AI_FLAG + '.');

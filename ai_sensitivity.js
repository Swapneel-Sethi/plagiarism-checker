'use strict';
const PE = require('./assets/engine.js');

const variants = [
  { name: 'L0 raw AI (tells+hedges, uniform)',
    text: 'It is important to note that the realm of modern technology presents a multifaceted tapestry. We must delve into the complexities of this ever-evolving landscape. Artificial intelligence plays a crucial role in navigating these challenges. Moreover, such systems underscore the importance of robust, scalable infrastructure that can adapt to a myriad of use cases. Furthermore, the landscape of innovation demands careful consideration of ethical implications.' },
  { name: 'L1 humanized: same ideas, tells/hedges REMOVED, formal',
    text: 'Modern technology is complicated and changes quickly. Artificial intelligence now powers many of the systems we rely on every day. These systems need reliable infrastructure to scale. New tools also raise real ethical questions that teams should plan for.' },
  { name: 'L2 humanized: personal voice + varied sentences + contractions',
    text: "I've been thinking about this a lot. Tech's gotten wild lately, right? My buddy built an AI system last month and honestly the infrastructure part nearly broke him. It's messy but it works, and the ethical stuff? We just figured it out as we went." },
  { name: 'L3 super casual human',
    text: "so like, my roommate tried this ai thing and it was kinda dumb at first lol. we fixed it though. infrastructure my ass, it was just a google form with extra steps. people overthink this stuff way too much." },
  // Same as L0 but with personal-voice injected ONLY (the classic "humanize" move)
  { name: 'L0 + personal voice ONLY (no tells removed)',
    text: 'It is important to note that I think the realm of modern technology presents a multifaceted tapestry. We must delve into the complexities of this ever-evolving landscape. My friend says artificial intelligence plays a crucial role in navigating these challenges. Moreover, such systems underscore the importance of robust, scalable infrastructure that we can adapt to a myriad of use cases.' }
];

const W = { 'LLM TELL PHRASES':0.30,'HEDGE / BOILERPLATE PHRASES':0.22,'BURSTINESS (sentence-length variance)':0.18,'FUNCTION-WORD DENSITY':0.12,'TYPE-TOKEN RATIO':0.08,'REPEATED 4-GRAM RATIO':0.06,'COMMA DENSITY':0.02,'AVG WORD LENGTH':0.02 };

console.log('variant'.padEnd(52) + 'AIidx');
console.log('-'.repeat(60));
for (const v of variants) {
  const r = PE.analyzeAI(v.text);
  console.log(v.name.padEnd(52) + r.index);
  const lines = r.params.map(p => '    ' + p.label.padEnd(38) + 'raw=' + String(p.raw).padEnd(12) + 'score=' + p.score.toFixed(2)).join('\n');
  console.log(lines);
  console.log('');
}

/*
 * Plagiarism + AI-writing detection engine (offline, client-side).
 * Global: window.PE  (also module.exports for node testing)
 *
 * Plagiarism: 5-word shingle containment against a reference corpus.
 * AI-writing: stylometric heuristics over 8 parameters (clearly labelled
 * as an estimate, not a certified classifier).
 */
(function (root) {
  'use strict';

  // ---------- small math helpers ----------
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function avg(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function stdev(a, m) {
    if (a.length < 2) return 0;
    var v = 0;
    for (var i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
    return Math.sqrt(v / (a.length - 1));
  }

  // ---------- text helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function normalizeWord(w) { return w.toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Tokenize into word spans (preserves original char offsets for highlighting).
  function wordSpans(text) {
    var re = /\S+/g, m, out = [];
    while ((m = re.exec(text))) {
      out.push({ raw: m[0], norm: normalizeWord(m[0]), start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  var K = 5;
  function shingleKeys(spans, k) {
    var keys = [];
    for (var i = 0; i + k <= spans.length; i++) {
      var s = '';
      for (var j = 0; j < k; j++) s += (j ? ' ' : '') + spans[i + j].norm;
      keys.push(s);
    }
    return keys;
  }

  function splitSentences(text) {
    if (!text) return [];
    try {
      var s = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
      if (s.length > 1) return s.map(function (x) { return x.trim(); }).filter(Boolean);
    } catch (e) { /* lookbehind unsupported */ }
    return text.split(/[.!?]+\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // ---------- common / function word sets (heuristic) ----------
  var COMMON = new Set((
    'the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been being has had did does doing would should could shall may might must this that these those it its he she they we you i me him her them my your his our their our us not no so than too very just also only even who whom which what whose where when why how' +
    ' world life hand part eye head house water place room word line end story fact thing case number group system state problem company government school country man woman child people god love hate fear hope time year day night week month morning evening city town village street road river mountain sea sun moon star tree plant animal body mind soul heart spirit light dark color white black red blue green yellow fire air wind rain snow ice cold hot warm cool big small long short old young new good bad right wrong true false real same different open close start stop move turn grow change learn know understand believe feel seem appear show happen become leave put keep hold break cut fall rise walk run sit stand lie sleep wake die live born create destroy build write read speak talk listen see hear smell taste touch think say ask answer tell mean call name find lose search help need want wish hope try fail win lose pass send receive pay buy sell trade work play rest wait hurry slow quick fast soon late early near far high low deep wide thin thick heavy light strong weak hard soft clean dirty rich poor free safe danger risk chance luck fate power force energy matter form kind type sort class style way method step stage level point idea plan rule law right duty role game sport music art book paper letter mail news report test question answer problem solution reason cause effect result change price cost value worth money food drink meat fish fruit tree grass flower leaf root seed stone metal wood glass blood bone skin hair face mouth tooth tongue lip nose eye ear hand arm leg foot finger toe chest back neck head brain heart lung liver stomach muscle nerve bone joint skin hair cloth dress shoe hat coat shirt pant sock glove ring belt pocket button thread needle pin nail screw lock key door window wall roof floor stair step path road bridge gate fence field garden park forest wood hill vally lake pond stream spring well mine cave hole pit trap net rope chain hook station train boat ship plane car truck bus bike wheel engine motor gear belt pipe wire cable post pole flag signal sign mark number letter symbol word name title date hour minute second week month year season spring summer autumn winter north south east west left right up down in out on off above below over under front back near far before after between among through across along around inside outside'
  ).split(/\s+/).filter(Boolean));

  var FUNCTION = new Set((
    'the a an and or but if because while although though for to of in on at by with from into as is are was were be been being have has had do does did will would shall can could may might must this that these those it its he she they we you i me him her them my your his our their us not no so than too very just also only even there what which who whom whose when where why how about over under between among through across'
  ).split(/\s+/).filter(Boolean));

  var HEDGES = [
    'it is important to note', 'it is worth noting', 'plays a crucial role', 'plays an important role',
    'plays a role', 'when it comes to', 'in today', 'in conclusion', 'to summarize', 'in summary',
    'overall', 'furthermore', 'moreover', 'delve', 'navigate the complexities', 'it should be noted',
    'a testament to', 'underscores the', 'in the realm of', 'it is essential to', 'broaden your perspective',
    'ever-evolving landscape', 'multifaceted', 'realm', 'underscore', 'robust'
  ];

  // Classic LLM "tells" — phrasing statistically over-represented in model output.
  var LLM_TELLS = [
    'delve', 'tapestry', 'realm', 'navigate the complexities', 'navigate', 'it is important to note',
    'it is worth noting', 'it should be noted', 'plays a crucial role', 'plays a pivotal role',
    'plays a significant role', 'a testament to', 'underscores the', 'underscore', 'in the realm of',
    'broaden your perspective', 'ever-evolving landscape', 'ever-evolving', 'multifaceted', 'robust',
    'moreover', 'furthermore', 'in conclusion', 'in summary', 'to summarize', 'not only', 'in today',
    'it is essential to', 'a myriad of', 'the landscape of', 'at its core', 'it is worth', 'crucial role'
  ];

  // Abstract / AI-favored noun vocabulary. AI output overuses vague, high-level
  // nouns (model, process, data, framework, leverage, optimize, robust, scalable…)
  // and underuses concrete specifics. Density of these is a strong, tell-free AI
  // signal — it catches uniform mechanical AI (e.g. T5) that has no "delve/tapestry"
  // tells. Kept distinct from LLM_TELLS (which are phrase-level).
  var AI_NOUNS = new Set((
    'model models process processes data training parameter parameters deployment infrastructure ' +
    'algorithm algorithms network networks learning layer layers efficiency scalability performance ' +
    'quality error errors input inputs output outputs system systems framework frameworks ' +
    'leverage utilize utilise optimize optimise optimisation robustness robust scalable scalability ' +
    'seamless holistic synergy synergistic actionable insight insights capability capabilities ' +
    'functionality methodology methodologies implementation integration ecosystem paradigm ' +
    'landscape comprehensive strategy strategic solution solutions facilitate'
  ).split(/\s+/).filter(Boolean));

  // ---------- fuzzy (paraphrase) detection ----------
  // Verbatim 5-gram matching misses reworded copies. This layer compares every
  // document sentence to every source sentence with TF-IDF cosine similarity and
  // flags sentences that are semantically close (paraphrase / near-copy).
  var FUZZY_STOP = (function () {
    var s = new Set();
    FUNCTION.forEach(function (w) { s.add(w); });
    COMMON.forEach(function (w) { s.add(w); });
    return s;
  })();
  var FUZZY_THRESHOLD = 0.30; // cosine cutoff for "this sentence is a paraphrase".
                             // Lowered from 0.40: the semantic (Gemini) pass is the
                             // primary reworded-text detector but is flaky (external
                             // key/outage), so fuzzy must still catch moderately
                             // reworded copies on its own. 0.30 sits above the corpus
                             // originals (<=0.27) so it does not false-flag local matches,
                             // while catching web paraphrases that previously fell in
                             // the 0.30-0.40 gap (e.g. reworded "Black hole" text).

  function contentWords(text) {
    return String(text).toLowerCase().split(/[^a-z0-9]+/)
      .filter(function (w) { return w.length >= 3 && !FUZZY_STOP.has(w); });
  }

  function splitSentencesWithBounds(text) {
    if (!text) return [];
    var parts;
    try { parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/); } catch (e) { parts = null; }
    if (!parts) parts = text.split(/[.!?]+\s+/);
    var out = [], idx = 0;
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i].trim();
      if (!s) continue;
      var start = text.indexOf(s, idx);
      if (start < 0) start = idx;
      out.push({ text: s, start: start, end: start + s.length });
      idx = start + s.length + 1;
    }
    return out;
  }

  function buildFuzzyModel(corpus) {
    var sentTexts = [];
    corpus.forEach(function (c) {
      var b = splitSentencesWithBounds(c.text || '');
      var taken = 0;
      for (var i = 0; i < b.length && taken < 120; i++) {
        var cw = contentWords(b[i].text);
        if (cw.length >= 4) { sentTexts.push({ title: c.title, cw: cw }); taken++; }
      }
    });
    var df = {};
    sentTexts.forEach(function (s) {
      var seen = {};
      s.cw.forEach(function (w) { if (!seen[w]) { seen[w] = 1; df[w] = (df[w] || 0) + 1; } });
    });
    var N = sentTexts.length || 1;
    function idf(w) { var d = df[w] || 0; return Math.log((N + 1) / (d + 1)) + 1; }
    var vecs = sentTexts.map(function (s) {
      var tf = {}; s.cw.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
      var hash = {}; var norm = 0;
      Object.keys(tf).forEach(function (w) {
        var wt = (1 + Math.log(tf[w])) * idf(w);
        hash[w] = wt; norm += wt * wt;
      });
      return { title: s.title, hash: hash, norm: norm > 0 ? Math.sqrt(norm) : 1 };
    });
    return { vecs: vecs, idf: idf };
  }

  function fuzzyCoverage(spans, docText, corpus) {
    var model = buildFuzzyModel(corpus);
    var covered = new Array(spans.length).fill(null);
    var tally = {};
    if (!model.vecs.length) return { covered: covered, tally: tally };
    var bounds = splitSentencesWithBounds(docText);
    for (var bi = 0; bi < bounds.length; bi++) {
      var bnd = bounds[bi];
      var cw = contentWords(bnd.text);
      if (cw.length < 6) continue;
      var tf = {}; cw.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
      var terms = [], weights = []; var norm = 0;
      Object.keys(tf).forEach(function (w) {
        var wt = (1 + Math.log(tf[w])) * model.idf(w);
        terms.push(w); weights.push(wt); norm += wt * wt;
      });
      norm = norm > 0 ? Math.sqrt(norm) : 1;
      var best = 0, bestTitle = null, bestVecNorm = 0;
      for (var v = 0; v < model.vecs.length; v++) {
        var vec = model.vecs[v]; var dot = 0;
        for (var t = 0; t < terms.length; t++) {
          var w = terms[t];
          if (vec.hash[w] !== undefined) dot += weights[t] * vec.hash[w];
        }
        var sim = dot / (norm * vec.norm);
        if (sim > best) { best = sim; bestTitle = vec.title; bestVecNorm = vec.norm; }
      }
      if (PE.debugFuzzy && best > 0.30) PE._fuzzyHits.push({ sim: best, dot: dot, dnorm: norm, snorm: bestVecNorm, title: bestTitle, sent: bnd.text.slice(0, 70) });
      if (best >= FUZZY_THRESHOLD) {
        for (var i = 0; i < spans.length; i++) {
          if (spans[i].start >= bnd.start && spans[i].end <= bnd.end) {
            if (covered[i] === null) covered[i] = bestTitle;
            tally[bestTitle] = (tally[bestTitle] || 0) + 1;
          }
        }
      }
    }
    return { covered: covered, tally: tally };
  }

  // ---------- plagiarism analysis (verbatim + fuzzy + semantic) ----------
  // extraSpans: optional [{start,end,title}] from a backend semantic pass
  // (meaning-based matching). Merged as 'paraphrase' so they reuse the ash style.
  function analyzePlagiarism(docText, corpus, extraSpans) {
    corpus = corpus || [];
    var spans = wordSpans(docText);
    var totalSpans = spans.length || 1;
    var keys = shingleKeys(spans, K);
    var docSet = new Set(keys);
    var docShingleCount = docSet.size || 1;

    var covered = new Array(spans.length).fill(null);
    var coveredType = new Array(spans.length).fill(null);

    // --- verbatim (5-gram containment) ---
    var perDoc = corpus.map(function (c) {
      var cspans = wordSpans(c.text || '');
      var ckeys = shingleKeys(cspans, K);
      var cset = new Set(ckeys);
      var inter = 0;
      for (var k = 0; k < keys.length; k++) if (cset.has(keys[k])) inter++;
      return { title: c.title, set: cset, matched: inter };
    });
    perDoc.forEach(function (d) {
      if (d.matched === 0) return;
      for (var i = 0; i + K <= spans.length; i++) {
        if (d.set.has(keys[i])) {
          if (covered[i] === null) { covered[i] = d.title; coveredType[i] = 'verbatim'; }
          for (var j = 1; j < K; j++) if (covered[i + j] === null) { covered[i + j] = d.title; coveredType[i + j] = 'verbatim'; }
        }
      }
    });

    // --- fuzzy (paraphrase) overlap ---
    var fz = fuzzyCoverage(spans, docText, corpus);
    for (var fi = 0; fi < spans.length; fi++) {
      if (covered[fi] === null && fz.covered[fi]) { covered[fi] = fz.covered[fi]; coveredType[fi] = 'paraphrase'; }
    }

    // --- semantic (meaning-based) overlap from the backend pass ---
    if (extraSpans && extraSpans.length) {
      for (var si = 0; si < extraSpans.length; si++) {
        var es = extraSpans[si];
        for (var ei = 0; ei < spans.length; ei++) {
          if (covered[ei] === null && spans[ei].start >= es.start && spans[ei].end <= es.end) {
            covered[ei] = es.title; coveredType[ei] = 'paraphrase';
          }
        }
      }
    }

    // Reconstruct original text with <mark> around covered spans.
    var html = '', prevEnd = 0;
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (sp.start > prevEnd) html += escapeHtml(docText.slice(prevEnd, sp.start));
      if (covered[i] !== null) {
        var cls = coveredType[i] === 'paraphrase' ? 'match match-fuzzy' : 'match';
        html += '<mark class="' + cls + '" data-source="' + escapeAttr(covered[i]) + '">' + escapeHtml(sp.raw) + '</mark>';
      } else {
        html += escapeHtml(sp.raw);
      }
      prevEnd = sp.end;
    }
    if (prevEnd < docText.length) html += escapeHtml(docText.slice(prevEnd));

    // per-source tally (verbatim wins the label if a source is matched both ways)
    var vTally = {}, fTally = {};
    for (var ci = 0; ci < covered.length; ci++) {
      if (covered[ci] === null) continue;
      if (coveredType[ci] === 'paraphrase') fTally[covered[ci]] = (fTally[covered[ci]] || 0) + 1;
      else vTally[covered[ci]] = (vTally[covered[ci]] || 0) + 1;
    }
    var types = {};
    Object.keys(vTally).forEach(function (t) { types[t] = 'verbatim'; });
    Object.keys(fTally).forEach(function (t) { if (!types[t]) types[t] = 'paraphrase'; });
    var perSource = Object.keys(types).map(function (t) {
      var w = (vTally[t] || 0) + (fTally[t] || 0);
      return { title: t, pct: (w / totalSpans) * 100, type: types[t] };
    }).sort(function (a, b) { return b.pct - a.pct; });

    var coveredCount = 0;
    for (var k2 = 0; k2 < covered.length; k2++) if (covered[k2] !== null) coveredCount++;

    // Merged char ranges already covered by word-matching — the semantic pass
    // can skip embedding these (they're caught) to save embedding calls.
    var coveredRanges = [];
    var segStart = -1, segEnd = -1;
    for (var ri = 0; ri < covered.length; ri++) {
      if (covered[ri] !== null) {
        if (segStart < 0) segStart = spans[ri].start;
        segEnd = spans[ri].end;
      } else if (segStart >= 0) {
        coveredRanges.push({ start: segStart, end: segEnd });
        segStart = -1;
      }
    }
    if (segStart >= 0) coveredRanges.push({ start: segStart, end: segEnd });

    return {
      plagiarismPct: (coveredCount / totalSpans) * 100,
      perSource: perSource,
      html: html,
      docShingleCount: docShingleCount,
      coveredRanges: coveredRanges
    };
  }

  // ---------- AI-writing analysis ----------
  function analyzeAI(text) {
    var all = wordSpans(text);
    var words = all.map(function (s) { return s.norm; }).filter(Boolean);
    var wordCount = words.length;
    if (wordCount < 10) return { index: 0, wordCount: wordCount, params: [] };

    var sentences = splitSentences(text);
    var sentLens = sentences.map(function (s) { return s.split(/\s+/).filter(Boolean).length; }).filter(function (n) { return n > 0; });
    var mean = avg(sentLens);
    var std = stdev(sentLens, mean);
    var burst = mean > 0 ? std / mean : 0;

    var content = words.filter(function (w) { return w.length > 2 && /[a-z]/.test(w); });
    var unique = new Set(content);
    var ttr = content.length ? unique.size / content.length : 0;
    var rare = content.filter(function (w) { return !COMMON.has(w); }).length;
    var rareRatio = content.length ? rare / content.length : 0;
    var avgWordLen = avg(words.map(function (w) { return w.length; }));
    var func = words.filter(function (w) { return FUNCTION.has(w); }).length;
    var funcDensity = func / wordCount;

    var low = text.toLowerCase();
    var hedgeCount = 0;
    HEDGES.forEach(function (h) {
      var re = new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      var m = low.match(re);
      if (m) hedgeCount += m.length;
    });
    var hedgePer100 = hedgeCount / (wordCount / 100);

    var four = shingleKeys(all, 4);
    var fset = new Set(four);
    var repeatRatio = four.length ? (four.length - fset.size) / four.length : 0;

    var commas = (text.match(/,/g) || []).length;
    var commaDensity = commas / (wordCount / 100);

    var tellCount = 0;
    LLM_TELLS.forEach(function (h) {
      var re = new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      var m = low.match(re);
      if (m) tellCount += m.length;
    });
    var tellPer100 = tellCount / (wordCount / 100);

    var fp = (low.match(/\b(i|me|my|we|our|us)\b/g) || []).length;
    var firstPersonPer100 = fp / (wordCount / 100);

    var contentRatio = content.length / wordCount;

    // Abstract / AI-favored noun density (tell-free AI signal). Weighted at 0.18:
    // high enough to catch uniform mechanical AI (T5/S5 land ~50) but low enough
    // that genuine formal-human writing with specifics stays well under the cutoff.
    var absCount = words.filter(function (w) { return AI_NOUNS.has(w); }).length;
    var absDensity = absCount / wordCount * 100;

    var params = [
      { label: 'BURSTINESS (sentence-length variance)', raw: burst.toFixed(2), score: clamp((0.85 - burst) / 0.55, 0, 1), note: 'Low variance → machine-like uniformity' },
      { label: 'TYPE-TOKEN RATIO', raw: (ttr * 100).toFixed(1) + '%', score: clamp((0.52 - ttr) / 0.35, 0, 1), note: 'Low diversity → repetitive / spun vocabulary' },
      { label: 'PERSONAL VOICE ABSENCE', raw: firstPersonPer100.toFixed(2) + ' /100w', score: clamp((2.5 - firstPersonPer100) / 2.5, 0, 1), note: 'Few "I/we" → impersonal, model-like framing' },
      { label: 'CONTENT-WORD RATIO', raw: (contentRatio * 100).toFixed(1) + '%', score: clamp((contentRatio - 0.56) / 0.20, 0, 1), note: 'Few glue words → staccato, non-human rhythm' },
      { label: 'REPEATED 4-GRAM RATIO', raw: (repeatRatio * 100).toFixed(1) + '%', score: clamp(repeatRatio / 0.04, 0, 1), note: 'Recurring phrasing → low lexical entropy' },
      { label: 'LLM TELL PHRASES', raw: tellPer100.toFixed(2) + ' /100w', score: clamp(tellPer100 / 2, 0, 1), note: '"delve", "tapestry", "realm", "crucial role"…' },
      { label: 'HEDGE / BOILERPLATE PHRASES', raw: hedgePer100.toFixed(2) + ' /100w', score: clamp(hedgePer100 / 2, 0, 1), note: '"it is important to note", "plays a role", etc.' },
      { label: 'FUNCTION-WORD DENSITY', raw: (funcDensity * 100).toFixed(1) + '%', score: clamp((0.45 - funcDensity) / 0.15, 0, 1), note: 'Low connective load → over-dense phrasing' },
      { label: 'ABSTRACT / AI-NOUN DENSITY', raw: absDensity.toFixed(1) + ' /100w', score: clamp(absDensity / 15, 0, 1), note: 'Overuse of vague abstract nouns → AI-style vagueness' },
      { label: 'COMMA DENSITY', raw: commaDensity.toFixed(1) + ' /100w', score: clamp((commaDensity - 10) / 12, 0, 1), note: 'Very high → over-structured sentences' },
      { label: 'AVG WORD LENGTH', raw: avgWordLen.toFixed(2) + ' ch', score: clamp((3.0 - avgWordLen) / 1.4, 0, 1), note: 'Short words cluster → simplified diction' }
    ];

    // Ensemble index. Weighted toward the parameters that actually separate AI from
    // human writing on real text. The earlier build also weighted TYPE-TOKEN RATIO and
    // REPEATED 4-GRAM RATIO, but those score HIGHER for human text than AI text (an
    // inverted signal) and dragged AI samples under the 50 cutoff — e.g. formal AI
    // prose landed at 48 and tell-free technical AI at 32, both misclassified as human.
    // They are dropped. The surviving six are all genuinely AI-favoring:
    //   - LLM-TELL / HEDGE phrases: explicit model boilerplate
    //   - BURSTINESS: low sentence-length variance = machine uniformity
    //   - FUNCTION-WORD DENSITY: dense, connective-light phrasing
    //   - PERSONAL VOICE ABSENCE: impersonal framing (also the main humanizer lever,
    //     so it stays a moderate weight — raising it makes the index feel "stuck")
    //   - ABSTRACT/AI-NOUN DENSITY: vague high-level nouns (tell-free AI signal)
    // Weights sum to 1.0 so the index reads directly as a 0-100 likelihood.
    var CFG = (typeof PE !== 'undefined' ? PE._CFG : null) || null;
    var W = (CFG && CFG.weights) || {
      'LLM TELL PHRASES': 0.180,
      'HEDGE / BOILERPLATE PHRASES': 0.140,
      'BURSTINESS (sentence-length variance)': 0.240,
      'FUNCTION-WORD DENSITY': 0.100,
      'PERSONAL VOICE ABSENCE': 0.200,
      'ABSTRACT / AI-NOUN DENSITY': 0.140
    };
    var wsum = 0, acc = 0;
    params.forEach(function (p) {
      var w = W[p.label] || 0;
      if (w) { acc += w * p.score; wsum += w; }
    });
    var idx = wsum ? Math.round((acc / wsum) * 100) : 0;
    return { index: idx, wordCount: wordCount, params: params };
  }

  // ---------- combined report ----------
  function fullReport(docText, corpus, extraSpans) {
    var p = analyzePlagiarism(docText, corpus, extraSpans);
    var a = analyzeAI(docText);
    return {
      plagiarismPct: p.plagiarismPct,
      aiIndex: a.index,
      perSource: p.perSource,
      html: p.html,
      aiParams: a.params,
      wordCount: a.wordCount,
      docShingleCount: p.docShingleCount
    };
  }

  var PE = { analyzePlagiarism: analyzePlagiarism, analyzeAI: analyzeAI, fullReport: fullReport, escapeHtml: escapeHtml };
  PE.setFuzzyThreshold = function (t) { if (typeof t === 'number') FUZZY_THRESHOLD = t; };
  PE._fuzzyHits = [];
  PE.debugFuzzy = false;
  if (typeof module !== 'undefined' && module.exports) module.exports = PE;
  root.PE = PE;
})(typeof window !== 'undefined' ? window : this);

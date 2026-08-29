/*
 * UI wiring for the plagiarism checker. Vanilla JS, no build step.
 * Depends on globals: PE (engine.js), CORPUS (corpus.js).
 */
(function () {
  'use strict';

  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }

  var $ = function (s) { return document.querySelector(s); };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- served-over-file warning ----
  // The web backend (/api/web-sources) only works over http(s). Opening
  // index.html directly (file://) silently skips the web scan. Warn the user.
  function showBanner(msg) {
    var b = document.getElementById('banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'banner';
      b.className = 'banner';
      document.body.insertBefore(b, document.body.firstChild);
    }
    b.textContent = msg;
    b.hidden = false;
  }
  if (location.protocol === 'file:') {
    showBanner('Opening this page directly as a file won\u2019t let it scan the web. Run "node server.js" and open http://localhost:3000, or use the deployed link.');
  }

  var input = $('#input');
  var fileInput = $('#file');
  var dropzone = $('#dropzone');
  var charCount = $('#charCount');
  var reportEl = $('#report');
  var analyzeBtn = $('#analyze');
  var scanWeb = $('#scanWeb');
  scanWeb.checked = true; // web scanning on by default
  var serpKey = $('#serpKey');
  serpKey.value = localStorage.getItem('pc_serpkey') || '';
  serpKey.addEventListener('input', function () {
    localStorage.setItem('pc_serpkey', serpKey.value.trim());
  });

  // ---- corpus state (seed + user docs from localStorage) ----
  var corpus = (window.CORPUS || []).slice();
  loadUserCorpus();

  function loadUserCorpus() {
    try {
      var raw = localStorage.getItem('pc_corpus');
      if (raw) JSON.parse(raw).forEach(function (d) { corpus.push(d); });
    } catch (e) { /* ignore */ }
  }
  function saveUserCorpus() {
    var user = corpus.filter(function (d) { return String(d.id).indexOf('user-') === 0; });
    try { localStorage.setItem('pc_corpus', JSON.stringify(user)); } catch (e) { /* ignore */ }
  }

  // ---- char count ----
  input.addEventListener('input', function () {
    charCount.textContent = input.value.length + ' characters';
  });

  // ---- file handling ----
  $('#loadFile').addEventListener('click', function () { fileInput.click(); });
  $('#nav-upload').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('check').scrollIntoView({ behavior: 'smooth' });
    fileInput.click();
  });
  $('#hero-check').addEventListener('click', function () {
    document.getElementById('check').scrollIntoView({ behavior: 'smooth' });
    input.focus();
  });

  fileInput.addEventListener('change', function (e) {
    if (e.target.files[0]) readFile(e.target.files[0]);
  });

  // Heuristic: is this text actually binary (Word/PDF) rather than plain text?
  function looksBinary(str) {
    if (str.indexOf(String.fromCharCode(0)) !== -1) return true;
    var sample = str.slice(0, 8000), nonPrint = 0;
    for (var i = 0; i < sample.length; i++) {
      var c = sample.charCodeAt(i);
      if (c < 9 || (c > 13 && c < 32)) nonPrint++;
    }
    return (nonPrint / sample.length) > 0.1;
  }

  function setDocText(t) {
    input.value = t;
    charCount.textContent = input.value.length + ' characters';
  }
  function showUnsupported() {
    input.value = '';
    charCount.textContent = 'Can\u2019t read this file — paste text or save as .txt';
  }

  function readFile(f) {
    var name = (f.name || '').toLowerCase();
    if (name.indexOf('.pdf') !== -1) return readPdf(f);
    if (name.indexOf('.docx') !== -1 || name.indexOf('.doc') !== -1) return readDocx(f);
    var r = new FileReader();
    r.onload = function () {
      if (looksBinary(r.result)) { showUnsupported(); return; }
      setDocText(r.result);
    };
    r.onerror = function () { charCount.textContent = 'File read error'; };
    r.readAsText(f);
  }

  async function readDocx(f) {
    if (!window.mammoth) { showUnsupported(); return; }
    try {
      var buf = await f.arrayBuffer();
      var res = await window.mammoth.extractRawText({ arrayBuffer: buf });
      setDocText(res.value || '');
    } catch (e) { showUnsupported(); }
  }

  async function readPdf(f) {
    if (!window.pdfjsLib) { showUnsupported(); return; }
    try {
      var buf = await f.arrayBuffer();
      var pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      var out = [];
      for (var pg = 1; pg <= pdf.numPages; pg++) {
        var page = await pdf.getPage(pg);
        var tc = await page.getTextContent();
        out.push(tc.items.map(function (it) { return it.str; }).join(' '));
      }
      setDocText(out.join('\n\n'));
    } catch (e) { showUnsupported(); }
  }

  // ---- drag & drop ----
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });

  // ---- analyze ----
  analyzeBtn.addEventListener('click', function () {
    var text = input.value.trim();
    if (text.length < 20) { charCount.textContent = 'Need at least 20 characters'; return; }
    analyzeBtn.textContent = 'Analyzing\u2026';
    analyze();
  });

  async function analyze() {
    var text = input.value.trim();
    analyzeBtn.textContent = 'Analyzing\u2026';
    try {
      var r = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, key: serpKey.value.trim(), scanWeb: scanWeb.checked })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var rep = await r.json();
      if (rep.error) { charCount.textContent = rep.error; return; }
      renderReport(rep, rep.corpusCount || corpus.length, rep.webNote || '');
      reportEl.hidden = false;
      reportEl.scrollIntoView({ behavior: 'sleep' });
    } catch (e) {
      charCount.textContent = 'Analysis failed — ' + (e.message || e) + (location.protocol === 'file:' ? ' (page opened as a file — try http://localhost:3000)' : '');
    } finally {
      analyzeBtn.textContent = 'Run analysis';
    }
  }

  function renderReport(rep, corpusCount, webNote) {
    var plag = rep.plagiarismPct.toFixed(1);
    var ai = rep.aiIndex.toFixed(0);

    var html = '';
    html += '<div class="result-head">';
    html += '<div class="metric"><span class="num">' + plag + '%</span><span class="mlabel">Plagiarism</span></div>';
    html += '<div class="metric"><span class="num">' + ai + '%</span><span class="mlabel">AI-writing index</span></div>';
    html += '</div>';
    html += '<p class="caption">' + rep.wordCount + ' words \u00b7 ' + rep.docShingleCount + ' shingles \u00b7 ' + (corpusCount || corpus.length) + ' reference docs</p>';

    html += '<h3 class="heading-sm">Matched sources</h3>';
    if (rep.perSource.length) {
      html += '<ul class="sources">';
      rep.perSource.forEach(function (s) {
        var tag = s.type === 'paraphrase' ? '<span class="src-type paraphrase">Paraphrase</span>' : '<span class="src-type">Verbatim</span>';
        html += '<li><span class="src-title">' + escapeHtml(s.title) + '</span>' + tag + '<span class="src-pct">' + s.pct.toFixed(1) + '%</span></li>';
      });
      html += '</ul>';
    } else {
      html += '<p class="caption">No overlap with reference corpus</p>';
    }
    html += '<p class="caption disclaimer">Verbatim = word-for-word match. Paraphrase = reworded text sharing the source\u2019s vocabulary (TF-IDF cosine \u2265 0.50). Plagiarism % = share of the document covered by either. Heavily reworded paraphrase can still read as original.</p>';

    html += '<h3 class="heading-sm">Stylometric parameters</h3>';
    html += '<div class="params">';
    rep.aiParams.forEach(function (p) {
      html += '<div class="param">' +
        '<div class="param-top"><span>' + escapeHtml(p.label) + '</span><span class="param-raw">' + escapeHtml(p.raw) + '</span></div>' +
        '<div class="bar"><i style="width:' + (p.score * 100).toFixed(0) + '%"></i></div>' +
        '<div class="param-note">' + escapeHtml(p.note) + '</div>' +
        '</div>';
    });
    html += '</div>';

    html += '<h3 class="heading-sm">Document map</h3>';
    html += '<div class="docmap">' + rep.html + '</div>';
    html += '<p class="caption">Frost underline = verbatim copy \u00b7 Ash underline = paraphrase / near-copy</p>';
    html += '<p class="caption disclaimer">Heuristic engine. Web matches come from live Google results. The AI-writing index is a rough estimate, not a certified detector. Plagiarism = copied from a source; AI-writing = machine-generated or spun. Spun text can read ~0% plagiarism yet score high on AI-writing.</p>';
    if (webNote) html += '<p class="caption disclaimer">' + escapeHtml(webNote) + '</p>';

    reportEl.innerHTML = html;
  }

  // ---- corpus management UI ----
  renderCorpus();
  function renderCorpus() {
    var list = $('#corpusList');
    list.innerHTML = '';
    corpus.forEach(function (d) {
      var li = document.createElement('li');
      var words = d.text.split(/\s+/).filter(Boolean).length;
      li.innerHTML = '<span class="src-title">' + escapeHtml(d.title) + '</span><span class="src-pct">' + words + ' words</span>';
      if (String(d.id).indexOf('user-') === 0) {
        var rm = document.createElement('button');
        rm.className = 'btn-mini';
        rm.textContent = 'Remove';
        rm.addEventListener('click', function () {
          corpus = corpus.filter(function (x) { return x.id !== d.id; });
          saveUserCorpus();
          renderCorpus();
        });
        li.appendChild(rm);
      }
      list.appendChild(li);
    });
  }

  $('#addCorpus').addEventListener('click', function () {
    var t = $('#corpusTitle').value.trim() || ('Doc ' + (corpus.length + 1));
    var x = $('#corpusText').value.trim();
    if (x.length < 20) { $('#corpusMsg').textContent = 'Text too short'; return; }
    corpus.push({ id: 'user-' + Date.now(), title: t, text: x });
    saveUserCorpus();
    renderCorpus();
    $('#corpusText').value = '';
    $('#corpusTitle').value = '';
    $('#corpusMsg').textContent = 'Added';
  });
})();

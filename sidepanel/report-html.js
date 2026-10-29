// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

// A standalone, shareable HTML report: one file with inline styles that
// opens anywhere, prints cleanly to PDF, and needs no extension to view.

const STORE_URL = 'https://chromewebstore.google.com/detail/agent-readiness-auditor/bgaigjpjdemhkngkaocgfekiedfaigfa';
const SITE_URL = 'https://agent-readiness-auditor.netlify.app';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toHtmlReport(r) {
  const tone = (s) => (s == null ? 'na' : s >= 90 ? 'pass' : s >= 70 ? 'warn' : 'fail');
  const host = (() => { try { return new URL(r.url).host; } catch { return r.url; } })();
  const when = new Date(r.timestamp);
  const fixes = topFixes(r, 3);
  const label = { pass: 'Passed', warn: 'Warning', fail: 'Failing', info: 'Note', na: 'Not applicable' };
  const issueCount = r.counts.fail + r.counts.warn;

  const cats = r.categories.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td class="bar">${c.scored === false || c.score == null ? '' : `<span class="track"><span class="fill t-${tone(c.score)}" style="width:${c.score}%"></span></span>`}</td>
        <td class="num t-${c.scored === false ? 'na' : tone(c.score)}">${c.scored === false ? 'Not scored' : c.score == null ? 'n/a' : c.score}</td>
      </tr>`).join('');

  const fixList = fixes.length ? `
    <section class="card">
      <h2>Fix these first</h2>
      <p class="muted">The changes that would raise the score the most.</p>
      <ol class="fixes">${fixes.map((f) => `<li><span class="gain">+${f.gain}</span><span><b>${esc(f.check.title)}</b><br><span class="muted">${esc(f.check.summary)}</span></span></li>`).join('')}</ol>
      <p class="muted small">Fixing all three would bring the score to about ${scoreWith(r, fixes.map((f) => f.check.id))}.</p>
    </section>` : '';

  const d = r.previous;
  const diff = d ? `
    <section class="card">
      <h2>Since the last audit</h2>
      <p>Score ${d.score} → <b>${d.score + d.delta}</b> (${d.delta >= 0 ? '+' : '−'}${Math.abs(d.delta)}) since ${esc(new Date(d.ts).toLocaleString())}.</p>
      ${d.fixed.length ? `<p><b>Fixed:</b> ${esc(d.fixed.join('; '))}</p>` : ''}
      ${d.regressed.length ? `<p><b>New problems:</b> ${esc(d.regressed.join('; '))}</p>` : ''}
    </section>` : '';

  const finding = (f) => `<li><code>${esc(f.snippet)}</code>${f.note ? `<div class="muted">${esc(f.note)}</div>` : ''}${f.selector ? `<div class="sel">${esc(f.selector)}</div>` : ''}${f.fix ? `<div class="fixlabel">Suggested fix</div><code class="fixcode">${esc(f.fix)}</code>` : ''}</li>`;
  const issueSections = r.categories.map((cat) => {
    const list = cat.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
      .sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1));
    if (!list.length) return '';
    return `
    <section class="card">
      <h2>${esc(cat.name)} ${cat.scored === false ? '' : `<span class="pill t-${tone(cat.score)}">${cat.score ?? 'n/a'}</span>`}</h2>
      <p class="muted">${esc(cat.description)}</p>
      ${list.map((c) => `
      <article class="check">
        <h3><span class="dot t-${c.status}"></span>${esc(c.title)} <span class="muted small">${label[c.status]}${c.issues ? ` · ${c.issues} ${c.issues === 1 ? 'issue' : 'issues'}` : ''}</span></h3>
        <p>${esc(c.summary)}</p>
        <p><b>Why it matters:</b> ${esc(c.why)}</p>
        <p><b>How to fix:</b> ${esc(c.fix)}</p>
        ${c.findings.length ? `<ul class="findings">${c.findings.slice(0, 10).map(finding).join('')}</ul>` : ''}
        ${c.issues > Math.min(10, c.findings.length) && c.findings.length ? `<p class="muted small">…and ${c.issues - Math.min(10, c.findings.length)} more.</p>` : ''}
      </article>`).join('')}
    </section>`;
  }).join('');

  const passed = r.categories.flatMap((c) => c.checks.filter((k) => k.status === 'pass').map((k) => k.title));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent-readiness report: ${esc(host)}</title>
<style>
  :root { --ink:#172033; --muted:#5A6678; --line:#D6DDE5; --paper:#EEF1F4; --accent:#2F4BD0; --pass:#177245; --warn:#9A5A00; --fail:#B3261E; --info:#4A5B76; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
  h1, h2 { font-family: Charter, "Iowan Old Style", Georgia, serif; font-weight: 600; }
  h1 { font-size: 30px; margin: 0 0 4px; }
  h2 { font-size: 21px; margin: 0 0 6px; }
  h3 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  p { margin: 0 0 8px; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  .top { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; flex-wrap: wrap; margin-bottom: 18px; }
  .brand { font-weight: 700; color: var(--accent); font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px; margin-bottom: 16px; break-inside: avoid-page; }
  .hero { display: grid; grid-template-columns: auto 1fr; gap: 24px; align-items: center; }
  .score { font: 600 72px/0.9 Charter, Georgia, serif; }
  .score small { font: 500 16px system-ui, sans-serif; color: var(--muted); }
  .grade { font: 600 22px/1.2 Charter, Georgia, serif; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  td { padding: 6px 0; border-top: 1px solid var(--line); font-size: 14px; }
  td.bar { width: 40%; padding: 0 14px; }
  td.num { text-align: right; font-weight: 700; white-space: nowrap; }
  .track { display: block; height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
  .fill { display: block; height: 100%; background: currentColor; border-radius: 3px; }
  .t-pass { color: var(--pass); } .t-warn { color: var(--warn); } .t-fail { color: var(--fail); } .t-na, .t-info { color: var(--info); }
  .pill { font: 700 14px system-ui, sans-serif; margin-left: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; display: inline-block; flex: none; }
  .fixes { margin: 12px 0 8px; padding: 0; list-style: none; }
  .fixes li { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); }
  .gain { flex: none; min-width: 46px; text-align: center; font-weight: 800; color: var(--pass); background: #E7F3EC; border-radius: 6px; padding: 2px 6px; height: fit-content; }
  .check { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 14px; }
  .findings { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 6px; }
  .findings li { background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; font-size: 13px; }
  code { font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
  .fixlabel { margin-top: 6px; font-size: 12px; font-weight: 700; color: var(--pass); }
  .fixcode { display: block; background: #fff; border: 1px dashed var(--line); border-radius: 4px; padding: 4px 6px; }
  .sel { font: 11px ui-monospace, Menlo, Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
  .passed { columns: 2; padding-left: 18px; margin: 8px 0 0; font-size: 14px; }
  footer { text-align: center; color: var(--muted); font-size: 13px; margin-top: 24px; }
  @media (max-width: 560px) { .hero { grid-template-columns: 1fr; } .passed { columns: 1; } td.bar { display: none; } }
  @media print { body { background: #fff; } .wrap { padding: 0; } .card { border-color: #ccc; } a { color: inherit; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <div class="brand">Agent-readiness report</div>
      <h1>${esc(host)}</h1>
      <div class="muted small">${esc(r.title || 'Untitled page')} · <a href="${esc(r.url)}">${esc(r.url)}</a></div>
    </div>
    <div class="muted small">Audited ${esc(when.toLocaleString())}</div>
  </div>

  <section class="card">
    <div class="hero">
      <div class="score t-${tone(r.score)}">${r.score}<small>/100</small></div>
      <div>
        <div class="grade">${esc(r.grade)}</div>
        <p class="muted">${esc(r.gradeText)}</p>
        <p class="small">${r.counts.fail} failing · ${r.counts.warn} warnings · ${r.counts.pass} passed${r.stats.tokens != null ? ` · about ${r.stats.tokens.toLocaleString()} tokens as an accessibility snapshot` : ''}</p>
      </div>
    </div>
    <table>${cats}</table>
  </section>
  ${diff}
  ${fixList}
  ${issueCount ? issueSections : '<section class="card"><h2>No issues found</h2><p>Every check passed or doesn’t apply to this page.</p></section>'}
  ${passed.length ? `<section class="card"><h2>Passed checks</h2><ul class="passed">${passed.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
  <p class="muted small">How this works: the audit reads the page the way AI agents do, through its accessibility tree and markup, and scores ${r.categories.reduce((a, c) => a + c.checks.length, 0)} checks. Scores are heuristics for finding problems; confirm important flows with a real agent.</p>
  <footer>
    Made with <a href="${STORE_URL}">Agent-Readiness Auditor</a> ${esc(r.version)}, a free Chrome extension · <a href="${SITE_URL}">${SITE_URL.replace('https://', '')}</a>
  </footer>
</div>
</body>
</html>`;
}

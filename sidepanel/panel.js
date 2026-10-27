'use strict';

// --------------------------------------------------------------- constants

const CATEGORY_INTRO = [
  ['Real controls', 'Are clickable things real buttons and links?'],
  ['Labels and names', 'Can an agent tell controls apart by name?'],
  ['Forms', 'Are fields labeled, typed and marked as required?'],
  ['Interaction traps', 'Do overlays, CAPTCHAs or frames block the way?'],
  ['Stable targeting', 'Will selectors still work after the next release?'],
  ['Page structure', 'Title, language, landmarks, headings and page size.'],
  ['Machine-readable signals', 'Metadata, structured data, llms.txt and robots.txt.'],
];

const GLYPHS = {
  pass: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.6 11.9H1.4z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6.1v3.4" stroke="var(--surface)" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".95" fill="var(--surface)"/></svg>',
  fail: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="currentColor"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke="var(--surface)" stroke-width="1.7" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".95" fill="currentColor"/></svg>',
  na: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
const CHEVRON = '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LOCATE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const STATUS_LABEL = { pass: 'Passed', warn: 'Warning', fail: 'Failing', info: 'Note', na: 'Not applicable' };
const STATUS_ORDER = { fail: 0, warn: 1, info: 2, pass: 3, na: 4 };
const FINDINGS_PREVIEW = 5;

// ------------------------------------------------------------------- state

const state = {
  windowId: null,
  tabId: null,
  report: null,
  stale: false,
  filter: 'issues',
  running: false,
};

const $view = document.getElementById('view');
const $run = document.getElementById('runBtn');
const $pageLabel = document.getElementById('pageLabel');
const $banner = document.getElementById('banner');
const $toast = document.getElementById('toast');

// ----------------------------------------------------------------- helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with constants above
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function glyph(status) {
  return h('span', { class: `glyph tone-${status}`, html: GLYPHS[status] || GLYPHS.na, role: 'img', 'aria-label': STATUS_LABEL[status] });
}

function toneFor(score) {
  if (score == null) return 'na';
  return score >= 90 ? 'pass' : score >= 70 ? 'warn' : 'fail';
}

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url || ''; }
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
}

function setView(...nodes) {
  $view.replaceChildren(...nodes);
}

function setRunButton() {
  $run.disabled = state.running;
  $run.textContent = state.running ? 'Auditing…' : state.report ? 'Run again' : 'Run audit';
}

function showBanner(text, actionLabel, action) {
  $banner.replaceChildren(text, actionLabel ? h('button', { type: 'button', onclick: action }, actionLabel) : '');
  $banner.hidden = false;
}
function hideBanner() { $banner.hidden = true; }

// ---------------------------------------------------------------- storage

const keyFor = (tabId) => `report:${tabId}`;

async function loadReport(tabId) {
  try {
    const got = await chrome.storage.session.get(keyFor(tabId));
    return got[keyFor(tabId)] || null;
  } catch { return null; }
}
async function saveReport(tabId, report) {
  try { await chrome.storage.session.set({ [keyFor(tabId)]: report }); } catch { /* quota or unavailable */ }
}

// ----------------------------------------------------------------- running

async function runAudit() {
  if (state.running || state.tabId == null) return;
  const tabId = state.tabId;
  state.running = true;
  setRunButton();
  hideBanner();
  renderLoading();

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/auditor.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.__ARA ? window.__ARA.run() : null),
    });
    const report = res && res.result;
    if (!report) throw new Error('The audit didn’t return any results.');
    await saveReport(tabId, report);
    if (state.tabId === tabId) {
      state.report = report;
      state.stale = false;
      renderResults();
      $view.focus({ preventScroll: true });
    }
  } catch (err) {
    if (state.tabId === tabId) handleError(err);
  } finally {
    state.running = false;
    setRunButton();
  }
}

function handleError(err) {
  const msg = String((err && err.message) || err || '');
  state.report = null;

  if (/chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|devtools:|extensions gallery|chrome web store|cannot be scripted|webstore/i.test(msg)) {
    $pageLabel.textContent = 'Browser page';
    return setView(h('section', { class: 'message' },
      h('h1', { text: 'This page can’t be audited' }),
      h('p', { text: 'Chrome doesn’t let extensions read its own pages, the Chrome Web Store, or other extensions. Open a regular website and run the audit there.' }),
    ));
  }
  if (/file:\/\//i.test(msg)) {
    return setView(h('section', { class: 'message' },
      h('h1', { text: 'Allow access to local files' }),
      h('p', { text: 'To audit files opened from your computer, turn on “Allow access to file URLs” for this extension, then run the audit again.' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }) }, 'Open extension settings'),
      ),
    ));
  }
  if (/permission|Cannot access contents|activeTab/i.test(msg)) {
    return renderPermission();
  }
  setView(h('section', { class: 'message' },
    h('h1', { text: 'The audit stopped before it finished' }),
    h('p', {}, 'Reload the page and run the audit again. If it keeps happening, the page may be blocking scripts. Details: ', h('code', { text: msg.slice(0, 240) || 'Unknown error' })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: runAudit }, 'Run audit'),
    ),
  ));
}

async function requestAllSites() {
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch { /* ignore */ }
  if (granted) runAudit();
  else toast('Access wasn’t granted. Click the toolbar icon while on the page to audit it once.');
}

// --------------------------------------------------------------- locating

// Serialized and run inside the page. Must not reference anything outside itself.
function locateInPage(ref, selector, runId, label) {
  const store = window.__ARA;
  let el = store && store.runId === runId ? store.refs[ref] : null;
  if (!el || !el.isConnected) {
    try { el = selector ? document.querySelector(selector) : null; } catch (e) { el = null; }
  }
  if (!el) return { ok: false };

  if (window.__ARA_HL) window.__ARA_HL.stop();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });

  const host = document.createElement('div');
  host.setAttribute('data-agent-readiness-highlight', '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML =
    '<style>' +
    '.box{position:fixed;border:2px solid #2F4BD0;border-radius:4px;' +
    'box-shadow:0 0 0 4px rgba(47,75,208,.28),0 0 0 100vmax rgba(15,20,27,.22);transition:opacity .35s}' +
    '.tag{position:fixed;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
    'font:600 12px/1.3 system-ui,sans-serif;background:#2F4BD0;color:#fff;padding:3px 7px;border-radius:3px;transition:opacity .35s}' +
    '.fade{opacity:0}' +
    '</style><div class="box"></div><div class="tag"></div>';
  const box = root.querySelector('.box');
  const tag = root.querySelector('.tag');
  tag.textContent = label || 'Here';
  document.documentElement.appendChild(host);

  let raf = 0;
  const started = performance.now();
  const stop = () => { cancelAnimationFrame(raf); host.remove(); if (window.__ARA_HL && window.__ARA_HL.host === host) window.__ARA_HL = null; };
  const tick = () => {
    if (!el.isConnected) return stop();
    const r = el.getBoundingClientRect();
    box.style.left = (r.left - 4) + 'px';
    box.style.top = (r.top - 4) + 'px';
    box.style.width = (r.width + 8) + 'px';
    box.style.height = (r.height + 8) + 'px';
    tag.style.left = Math.max(4, r.left - 4) + 'px';
    tag.style.top = (r.top - 28 > 4 ? r.top - 28 : r.bottom + 8) + 'px';
    if (performance.now() - started < 3200) raf = requestAnimationFrame(tick);
    else { box.classList.add('fade'); tag.classList.add('fade'); setTimeout(stop, 400); }
  };
  tick();
  window.__ARA_HL = { host, stop };
  return { ok: true };
}

async function locate(f, label) {
  if (!state.report) return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: locateInPage,
      args: [f.ref, f.selector, state.report.runId, label],
    });
    if (!res || !res.result || !res.result.ok) toast('That element is no longer on the page. Run the audit again.');
  } catch {
    toast('Couldn’t reach the page. Run the audit again.');
  }
}

// --------------------------------------------------------------- rendering

function renderEmpty() {
  $pageLabel.textContent = 'Audit the page you’re on';
  setView(h('section', { class: 'intro' },
    h('h1', { text: 'How well can AI agents use this page?' }),
    h('p', { text: 'Run an audit to see how easily agents like Claude, Gemini and ChatGPT can read this page, find its controls and finish tasks on it. You’ll get a score and specific fixes.' }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: runAudit }, 'Run audit'),
    h('ul', { class: 'scope', 'aria-label': 'What the audit checks' },
      CATEGORY_INTRO.map(([name, desc]) => h('li', {}, h('strong', { text: name }), h('span', { text: desc }))),
    ),
    h('p', { class: 'privacy', text: 'Everything runs in your browser. Nothing about the page is sent anywhere.' }),
  ));
}

function renderLoading() {
  setView(h('section', { class: 'loading', 'aria-busy': 'true' },
    h('div', { class: 'scan-page', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i'), h('div', { class: 'scan-line' })),
    h('p', { text: 'Reading the page the way an agent would…' }),
  ));
}

function renderPermission() {
  setView(h('section', { class: 'message' },
    h('h1', { text: 'Chrome needs your OK to read this page' }),
    h('p', { text: 'Click the extension’s toolbar icon while you’re on the page to allow a one-time audit, then press Run audit. Or allow the auditor on all sites so it works anywhere without asking.' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: requestAllSites }, 'Allow on all sites'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: runAudit }, 'Try again'),
    ),
  ));
}

function checkMeta(c) {
  if (c.status === 'pass') return 'Passed';
  if (c.status === 'na') return 'Not applicable';
  if (c.status === 'info') return c.issues ? `${c.issues} found` : 'Note';
  if (c.issues) return c.issues === 1 ? '1 issue' : `${c.issues.toLocaleString()} issues`;
  return STATUS_LABEL[c.status];
}

function visibleChecks(cat) {
  const list = [...cat.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  if (state.filter === 'issues') return list.filter((c) => c.status === 'fail' || c.status === 'warn');
  if (state.filter === 'passed') return list.filter((c) => c.status === 'pass' || c.status === 'info' || c.status === 'na');
  return list;
}

function renderFinding(f, label) {
  return h('li', { class: 'finding' },
    h('code', { text: f.snippet }),
    h('div', { class: 'finding-foot' },
      h('span', { class: 'finding-note', text: f.note }),
      f.selector || f.ref != null
        ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => locate(f, f.note || label), title: 'Scroll to this element and highlight it' },
          h('span', { html: LOCATE_ICON, style: { display: 'inline-flex' } }), 'Show on page')
        : null,
    ),
  );
}

function renderCheck(c, open) {
  const list = h('ul', { class: 'findings' });
  const shown = c.findings.slice(0, FINDINGS_PREVIEW);
  shown.forEach((f) => list.append(renderFinding(f, c.title)));

  let moreBtn = null;
  if (c.findings.length > FINDINGS_PREVIEW) {
    moreBtn = h('button', {
      class: 'btn btn-quiet btn-small more', type: 'button',
      onclick: () => {
        c.findings.slice(FINDINGS_PREVIEW).forEach((f) => list.append(renderFinding(f, c.title)));
        moreBtn.remove();
      },
    }, `Show all ${c.findings.length}`);
  }
  const capNote = c.issues > c.findings.length
    ? h('p', { class: 'cap-note', text: `Listing the first ${c.findings.length} of ${c.issues.toLocaleString()}. Fix these and run the audit again to see the rest.` })
    : null;

  const hasIssues = c.status === 'fail' || c.status === 'warn';
  return h('details', { class: 'check', open: open || null },
    h('summary', {},
      glyph(c.status),
      h('span', { class: 'check-title', text: c.title }),
      h('span', { class: 'check-meta', text: checkMeta(c) }),
      h('span', { html: CHEVRON, style: { display: 'inline-flex' } }),
    ),
    h('div', { class: 'check-body' },
      h('p', { class: 'check-summary', text: c.summary }),
      h('h3', { text: 'Why it matters' }),
      h('p', { text: c.why }),
      hasIssues || c.status === 'info' ? [h('h3', { text: 'How to fix' }), h('p', { text: c.fix })] : null,
      c.findings.length ? list : null,
      moreBtn,
      capNote,
    ),
  );
}

function renderResults() {
  const r = state.report;
  if (!r) return renderEmpty();
  $pageLabel.textContent = hostOf(r.url);
  $pageLabel.title = r.url;

  const tone = toneFor(r.score);
  const issueCount = r.counts.fail + r.counts.warn;
  const passCount = r.counts.pass + r.counts.info + r.counts.na;
  const total = issueCount + passCount;
  const totalWeight = r.categories.reduce((a, c) => a + (c.score == null ? 0 : c.weight), 0) || 1;

  const breakdown = [];
  if (r.counts.fail) breakdown.push(`${r.counts.fail} failing`);
  if (r.counts.warn) breakdown.push(`${r.counts.warn} ${r.counts.warn === 1 ? 'warning' : 'warnings'}`);
  breakdown.push(`${r.counts.pass} passed`);

  const score = h('section', { class: 'score', 'aria-label': 'Overall score' },
    h('div', { class: 'score-head' },
      h('div', { class: `score-num tone-${tone}` }, String(r.score), h('small', { text: '/100' })),
      h('div', { class: 'score-grade' },
        h('strong', { text: r.grade }),
        h('span', { text: breakdown.join(', ') }),
      ),
    ),
    h('p', { class: 'score-text', text: r.gradeText }),
    h('div', { class: 'strip', role: 'img', 'aria-label': 'Score by category, sized by weight in the overall score' },
      r.categories.filter((c) => c.score != null).map((c, i) => h('span', {
        class: `tone-${toneFor(c.score)}`,
        title: `${c.name}: ${c.score}`,
        style: { flex: `${c.weight / totalWeight} 1 0` },
      }, h('b', { style: { width: `${c.score}%`, animationDelay: `${i * 60}ms` } }))),
    ),
    h('ul', { class: 'cats' },
      r.categories.map((c) => h('li', {},
        h('button', { type: 'button', onclick: () => jumpTo(c.id) },
          h('span', { class: 'cat-name', text: c.name }),
          h('span', { class: `cat-bar tone-${toneFor(c.score)}`, 'aria-hidden': 'true' }, h('b', { style: { width: `${c.score ?? 0}%` } })),
          h('span', { class: `cat-score tone-${toneFor(c.score)}`, text: c.score == null ? '–' : String(c.score) }),
        ),
      )),
    ),
  );

  const filterBtn = (id, label, count) => h('button', {
    type: 'button', 'aria-pressed': String(state.filter === id),
    onclick: () => { state.filter = id; renderResults(); },
  }, label, count != null ? h('span', { class: 'count', text: count }) : null);

  const exportMenu = buildExportMenu();
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show checks' },
      filterBtn('issues', 'Issues', issueCount),
      filterBtn('passed', 'Passed', passCount),
      filterBtn('all', 'All', total),
    ),
    exportMenu,
  );

  const sections = [];
  let firstIssueOpened = false;
  for (const cat of r.categories) {
    const checks = visibleChecks(cat);
    if (!checks.length) continue;
    const catTone = toneFor(cat.score);
    sections.push(h('section', { class: 'category', id: `cat-${cat.id}`, 'aria-labelledby': `cat-h-${cat.id}` },
      h('div', { class: 'category-head' },
        h('h2', { id: `cat-h-${cat.id}`, text: cat.name }),
        h('span', { class: `cat-score-lg tone-${catTone}`, text: cat.score == null ? '–' : String(cat.score) }),
      ),
      h('p', { class: 'category-desc', text: cat.description }),
      checks.map((c) => {
        const open = !firstIssueOpened && c.status === 'fail';
        if (open) firstIssueOpened = true;
        return renderCheck(c, open);
      }),
    ));
  }
  if (!sections.length) {
    sections.push(h('div', { class: 'all-clear' },
      h('strong', { text: state.filter === 'issues' ? 'No issues found' : 'Nothing to show' }),
      state.filter === 'issues' ? 'Every check passed or doesn’t apply to this page.' : 'Switch to All to see every check.',
    ));
  }

  const when = new Date(r.timestamp);
  const foot = h('p', { class: 'foot' },
    `Audited ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} in ${(r.durationMs / 1000).toFixed(1)} s. `,
    `${r.stats.elements.toLocaleString()} elements, ${r.stats.controls.toLocaleString()} controls and ${r.stats.fields.toLocaleString()} form fields checked in the top frame. Scores are heuristics: use them to find problems, then confirm with a real agent.`,
  );

  setView(score, toolbar, ...sections, foot);
  if (state.stale) showBanner('This page has changed since the audit.', 'Run it again', runAudit);
  setRunButton();
}

function jumpTo(catId) {
  let el = document.getElementById(`cat-${catId}`);
  if (!el && state.filter !== 'all') {
    state.filter = 'all';
    renderResults();
    el = document.getElementById(`cat-${catId}`);
  }
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = el.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar').offsetHeight - 8;
  window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  el.querySelector('h2').setAttribute('tabindex', '-1');
  el.querySelector('h2').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ export

function buildExportMenu() {
  const list = h('div', { class: 'menu-list', role: 'menu', hidden: true });
  const trigger = h('button', {
    class: 'btn btn-quiet btn-small', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); toggle(list.hidden); },
  }, 'Export');
  const item = (label, fn) => h('button', { type: 'button', role: 'menuitem', onclick: () => { toggle(false); fn(); } }, label);
  list.append(
    item('Copy report as Markdown', copyMarkdown),
    item('Download Markdown', () => download('md')),
    item('Download JSON', () => download('json')),
  );
  function toggle(open) {
    list.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) list.querySelector('button').focus();
  }
  list.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggle(false); trigger.focus(); } });
  return h('div', { class: 'menu' }, trigger, list);
}

function toMarkdown(r) {
  const tick = (s) => String(s).replace(/`/g, 'ˋ');
  const L = [];
  L.push('# Agent-readiness audit', '');
  L.push(`**Page:** ${r.title || 'Untitled'}  `);
  L.push(`**URL:** ${r.url}  `);
  L.push(`**Audited:** ${new Date(r.timestamp).toLocaleString()}  `);
  L.push(`**Score:** ${r.score}/100, ${r.grade}`, '');
  L.push(r.gradeText, '');
  L.push('| Category | Score |', '| --- | --- |');
  for (const c of r.categories) L.push(`| ${c.name} | ${c.score == null ? 'n/a' : c.score} |`);
  L.push('');
  for (const cat of r.categories) {
    L.push(`## ${cat.name} (${cat.score == null ? 'n/a' : `${cat.score}/100`})`, '');
    const checks = [...cat.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    for (const c of checks) {
      L.push(`### ${STATUS_LABEL[c.status]}: ${c.title}`, '');
      L.push(c.summary, '');
      if (c.status === 'fail' || c.status === 'warn') {
        L.push(`**Why it matters:** ${c.why}`, '');
        L.push(`**How to fix:** ${c.fix}`, '');
        for (const f of c.findings.slice(0, 20)) {
          L.push(`- \`${tick(f.snippet)}\`${f.note ? `: ${f.note}` : ''}${f.selector ? `  \n  Selector: \`${tick(f.selector)}\`` : ''}`);
        }
        if (c.issues > Math.min(20, c.findings.length)) L.push(`- …and ${(c.issues - Math.min(20, c.findings.length)).toLocaleString()} more`);
        if (c.findings.length) L.push('');
      }
    }
  }
  L.push('---', `Generated by Agent-Readiness Auditor ${r.version}.`);
  return L.join('\n');
}

async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(toMarkdown(state.report));
    toast('Report copied');
  } catch {
    toast('Couldn’t copy. Use Download Markdown instead.');
  }
}

function download(kind) {
  const r = state.report;
  if (!r) return;
  const host = hostOf(r.url).replace(/[^a-z0-9.-]+/gi, '-');
  const stamp = new Date(r.timestamp).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const body = kind === 'md' ? toMarkdown(r) : JSON.stringify(r, null, 2);
  const type = kind === 'md' ? 'text/markdown' : 'application/json';
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = h('a', { href: url, download: `agent-readiness-${host}-${stamp}.${kind}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(kind === 'md' ? 'Markdown downloaded' : 'JSON downloaded');
}

// -------------------------------------------------------------- tab events

async function showTab(tabId) {
  state.tabId = tabId;
  state.stale = false;
  hideBanner();
  state.report = await loadReport(tabId);
  if (state.tabId !== tabId) return;
  if (state.report) renderResults(); else renderEmpty();
  setRunButton();
}

async function init() {
  $run.addEventListener('click', runAudit);
  document.addEventListener('click', () => {
    for (const m of document.querySelectorAll('.menu-list')) {
      m.hidden = true;
      m.previousElementSibling?.setAttribute('aria-expanded', 'false');
    }
  });
  try {
    const win = await chrome.windows.getCurrent();
    state.windowId = win.id;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    await showTab(tab ? tab.id : null);
  } catch {
    renderEmpty();
  }

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId === state.windowId) showTab(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== state.tabId || info.status !== 'loading') return;
    if (state.report && !state.stale) {
      state.stale = true;
      showBanner('This page has changed since the audit.', 'Run it again', runAudit);
    }
  });
}

init();

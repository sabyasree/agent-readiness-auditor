'use strict';

// --------------------------------------------------------------- constants

const CATEGORY_INTRO = [
  ['Real controls', 'Are clickable things real buttons and links?'],
  ['Labels and names', 'Can an agent tell controls apart by name?'],
  ['Forms', 'Are fields labeled, typed and marked as required?'],
  ['Interaction traps', 'Do overlays, CAPTCHAs or frames block the way?'],
  ['Stable targeting', 'Will selectors still work after the next release?'],
  ['Page structure', 'Title, landmarks, headings, page size, and content that needs JavaScript.'],
  ['Agent safety', 'Is there hidden text trying to give agents instructions?'],
  ['Machine-readable signals', 'Metadata, structured data, llms.txt and robots.txt.'],
  ['Agent protocols', 'Markdown, MCP, WebMCP, API and sign-in discovery. Shown for information, not scored.'],
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
  tab: 'report',
  viewFilter: 'all',
  viewQuery: '',
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

// Last audit per page (URL without the hash), kept in local storage so a
// re-audit after a fix can show what changed. Only scores and check statuses.
const HISTORY_KEY = 'history';
const HISTORY_MAX = 200;
const pageKey = (url) => String(url || '').split('#')[0];

async function readHistory() {
  try { return (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || {}; } catch { return {}; }
}

function summarize(r) {
  const checks = {};
  for (const cat of r.categories) {
    for (const c of cat.checks) checks[c.id] = { s: c.status, n: c.issues, t: c.title };
  }
  return { ts: r.timestamp, score: r.score, checks };
}

function diffReports(prev, r) {
  const isIssue = (s) => s === 'fail' || s === 'warn';
  const fixed = [];
  const regressed = [];
  const better = [];
  const worse = [];
  for (const cat of r.categories) {
    for (const c of cat.checks) {
      const p = prev.checks[c.id];
      if (!p) continue; // check added in a newer version
      if (isIssue(p.s) && !isIssue(c.status)) fixed.push(c.title);
      else if (!isIssue(p.s) && isIssue(c.status)) regressed.push(c.title);
      else if (isIssue(p.s) && isIssue(c.status)) {
        if (c.issues < p.n) better.push(`${c.title} (${p.n} → ${c.issues})`);
        else if (c.issues > p.n) worse.push(`${c.title} (${p.n} → ${c.issues})`);
      }
    }
  }
  return { ts: prev.ts, score: prev.score, delta: r.score - prev.score, fixed, regressed, better, worse };
}

/** Attach the change since the last audit of this page, then remember this one. */
async function recordHistory(r) {
  const all = await readHistory();
  const key = pageKey(r.url);
  const prev = all[key];
  r.previous = prev ? diffReports(prev, r) : null;
  all[key] = summarize(r);
  const keys = Object.keys(all);
  if (keys.length > HISTORY_MAX) {
    keys.sort((a, b) => all[a].ts - all[b].ts).slice(0, keys.length - HISTORY_MAX).forEach((k) => delete all[k]);
  }
  try { await chrome.storage.local.set({ [HISTORY_KEY]: all }); } catch { /* quota or unavailable */ }
}

async function clearHistory() {
  try { await chrome.storage.local.remove(HISTORY_KEY); } catch { /* ignore */ }
  if (state.report) { state.report.previous = null; saveReport(state.tabId, state.report); renderResults(); }
  toast('Audit history cleared');
}

// ----------------------------------------------------------------- running

// Serialized and run in the page's own JavaScript world, where WebMCP tools
// registered by the page are visible. Must not reference anything outside itself.
async function probeMainWorld() {
  const out = { supported: false, tools: null };
  try {
    out.supported = !!(document.modelContext || navigator.modelContext);
    const testing = navigator.modelContextTesting || document.modelContextTesting;
    if (testing && typeof testing.listTools === 'function') {
      const list = await Promise.race([
        Promise.resolve(testing.listTools()),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (list) {
        out.tools = Array.from(list).slice(0, 50).map((t) => ({
          name: String((t && t.name) || ''),
          description: String((t && t.description) || ''),
        }));
      }
    }
  } catch (e) { /* not available */ }
  return out;
}

async function runAudit() {
  if (state.running || state.tabId == null) return;
  const tabId = state.tabId;
  state.running = true;
  setRunButton();
  hideBanner();
  renderLoading();

  try {
    let probe = null;
    try {
      const [p] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probeMainWorld });
      probe = p && p.result;
    } catch { /* the audit still runs without it */ }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/auditor.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (opts) => (window.__ARA ? window.__ARA.run(opts) : null),
      args: [{ probe }],
    });
    const report = res && res.result;
    if (!report) throw new Error('The audit didn’t return any results.');
    await recordHistory(report);
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
      hasIssues ? h('div', { class: 'check-actions' },
        h('button', {
          class: 'btn btn-quiet btn-small', type: 'button', title: 'Copy a prompt that asks a coding agent to fix and test this issue',
          onclick: () => copyText(toPrompt(state.report, c.id), 'Fix prompt copied'),
        }, 'Copy fix prompt'),
      ) : null,
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
    renderDiff(r.previous),
    h('div', { class: 'strip', role: 'img', 'aria-label': 'Score by category, sized by weight in the overall score' },
      r.categories.filter((c) => c.score != null && c.scored !== false).map((c, i) => h('span', {
        class: `tone-${toneFor(c.score)}`,
        title: `${c.name}: ${c.score}`,
        style: { flex: `${c.weight / totalWeight} 1 0` },
      }, h('b', { style: { width: `${c.score}%`, animationDelay: `${i * 60}ms` } }))),
    ),
    h('ul', { class: 'cats' },
      r.categories.map((c) => h('li', {},
        h('button', { type: 'button', onclick: () => jumpTo(c.id) },
          h('span', { class: 'cat-name', text: c.name }),
          c.scored === false
            ? h('span', { class: 'cat-unscored', text: 'Not scored' })
            : [h('span', { class: `cat-bar tone-${toneFor(c.score)}`, 'aria-hidden': 'true' }, h('b', { style: { width: `${c.score ?? 0}%` } })),
              h('span', { class: `cat-score tone-${toneFor(c.score)}`, text: c.score == null ? '–' : String(c.score) })],
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
        h('span', { class: `cat-score-lg tone-${catTone}`, text: cat.scored === false ? 'Not scored' : cat.score == null ? '–' : String(cat.score) }),
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

  const tab = (id, label) => h('button', {
    type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(state.tab === id), 'aria-controls': 'tabpanel',
    tabindex: state.tab === id ? '0' : '-1',
    onclick: () => { state.tab = id; renderResults(); document.getElementById(`tab-${id}`)?.focus(); },
    onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      state.tab = state.tab === 'report' ? 'agent' : 'report';
      renderResults();
      document.getElementById(`tab-${state.tab}`)?.focus();
    },
  }, label);
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Results' },
    tab('report', 'Report'),
    tab('agent', 'Agent view'),
  );
  const panel = h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` },
    state.tab === 'agent' ? renderAgentView(r) : [toolbar, ...sections, foot]);

  setView(score, tabs, panel);
  if (state.stale) showBanner('This page has changed since the audit.', 'Run it again', runAudit);
  setRunButton();
}

function renderDiff(d) {
  if (!d) return null;
  const when = new Date(d.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tone = d.delta > 0 ? 'pass' : d.delta < 0 ? 'fail' : 'na';
  const counts = [];
  if (d.fixed.length) counts.push(`${d.fixed.length} fixed`);
  if (d.regressed.length) counts.push(`${d.regressed.length} new`);
  if (d.better.length) counts.push(`${d.better.length} improved`);
  if (d.worse.length) counts.push(`${d.worse.length} worse`);
  const group = (label, items) => items.length
    ? [h('h3', { text: label }), h('ul', {}, items.map((t) => h('li', { text: t })))]
    : null;
  const any = counts.length > 0;
  return h('details', { class: 'diff' },
    h('summary', {},
      h('span', { class: `diff-delta tone-${tone}`, text: d.delta > 0 ? `+${d.delta}` : d.delta < 0 ? `−${-d.delta}` : '±0' }),
      h('span', { class: 'diff-text', text: `since the audit on ${when} (was ${d.score}). ${any ? counts.join(', ') : 'No check changed.'}` }),
      any ? h('span', { html: CHEVRON, style: { display: 'inline-flex' } }) : null,
    ),
    any ? h('div', { class: 'diff-body' },
      group('Fixed', d.fixed),
      group('New problems', d.regressed),
      group('Fewer issues', d.better),
      group('More issues', d.worse),
    ) : null,
  );
}

const INTERACTIVE_ROLES = new Set(['link', 'button', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'spinbutton',
  'slider', 'listbox']);
const VIEW_PAGE = 600;

/** The agent view as indented text, in the style of a Playwright ARIA snapshot. */
function viewText(nodes) {
  return nodes.map((n, i) => {
    const pad = '  '.repeat(n.d);
    if (n.role === 'text') return `${pad}- text: ${n.name}`;
    const kids = nodes[i + 1] && nodes[i + 1].d > n.d;
    const name = n.name ? ` "${n.name.replace(/"/g, '\\"')}"` : '';
    const props = n.props ? ` [${n.props}]` : '';
    return `${pad}- ${n.role}${name}${props}${kids ? ':' : ''}`;
  }).join('\n');
}

function renderAgentView(r) {
  const v = r.agentView;
  if (!v) {
    return h('div', { class: 'all-clear' }, h('strong', { text: 'Run the audit again' }), 'This report was made by an older version, before the agent view existed.');
  }
  const stat = (num, label, tone) => h('div', { class: 'view-stat' },
    h('strong', { class: tone ? `tone-${tone}` : null, text: num }), h('span', { text: label }));
  const list = h('ul', { class: 'tree', 'aria-label': 'Accessibility tree' });
  const more = h('button', { class: 'btn btn-quiet btn-small more', type: 'button' }, 'Show more');
  const empty = h('p', { class: 'view-empty', text: 'Nothing matches.' });

  const matches = () => {
    const q = state.viewQuery.trim().toLowerCase();
    return v.nodes.filter((n) => {
      if (state.viewFilter === 'controls' && !INTERACTIVE_ROLES.has(n.role)) return false;
      if (state.viewFilter === 'unnamed' && n.flag !== 'unnamed') return false;
      return !q || n.name.toLowerCase().includes(q) || n.role.includes(q);
    });
  };
  let shown = [];
  let count = 0;
  const row = (n) => {
    const flat = state.viewFilter !== 'all' || state.viewQuery.trim();
    const body = [
      h('span', { class: 'node-role', text: n.role }),
      n.name ? h('span', { class: 'node-name', text: n.role === 'text' ? n.name : `“${n.name}”` }) : null,
      n.props ? h('span', { class: 'node-props', text: n.props }) : null,
      n.flag === 'unnamed' ? h('span', { class: 'node-flag', text: 'no name' }) : null,
    ];
    return h('li', { class: `node${n.role === 'text' ? ' node-text' : ''}`, style: { paddingLeft: `${8 + (flat ? 0 : Math.min(n.d, 12) * 14)}px` } },
      n.ref != null
        ? h('button', { type: 'button', title: 'Show on page', onclick: () => locate({ ref: n.ref, selector: '' }, n.name ? `${n.role} “${n.name.slice(0, 40)}”` : n.role) }, body)
        : h('span', {}, body));
  };
  const page = () => {
    const next = shown.slice(count, count + VIEW_PAGE);
    list.append(...next.map(row));
    count += next.length;
    more.hidden = count >= shown.length;
    more.textContent = `Show ${Math.min(VIEW_PAGE, shown.length - count).toLocaleString()} more`;
  };
  const refresh = () => {
    shown = matches();
    count = 0;
    list.replaceChildren();
    empty.hidden = shown.length > 0;
    page();
  };
  more.addEventListener('click', page);

  const filterBtn = (id, label) => h('button', {
    type: 'button', 'aria-pressed': String(state.viewFilter === id),
    onclick: (e) => {
      state.viewFilter = id;
      for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      refresh();
    },
  }, label);
  const search = h('input', {
    type: 'search', class: 'view-search', placeholder: 'Find a name or role', 'aria-label': 'Find in the agent view', value: state.viewQuery,
    oninput: (e) => { state.viewQuery = e.target.value; refresh(); },
  });

  refresh();
  return h('section', { class: 'agent-view' },
    h('p', { class: 'view-intro', text: 'Roughly what an agent reads: the page’s accessibility tree as text. A control without a name shows up as a bare role, so the agent can’t tell it from the others. Select a line to find it on the page.' }),
    h('div', { class: 'view-stats' },
      stat(`~${v.tokens.toLocaleString()}`, 'tokens'),
      stat(v.nodes.length.toLocaleString() + (v.truncated ? '+' : ''), 'lines'),
      stat(v.unnamed.toLocaleString(), v.unnamed === 1 ? 'control with no name' : 'controls with no name', v.unnamed ? 'fail' : 'pass'),
    ),
    h('div', { class: 'toolbar view-toolbar' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show lines' },
        filterBtn('all', 'Everything'),
        filterBtn('controls', 'Controls'),
        filterBtn('unnamed', 'No name'),
      ),
      h('button', {
        class: 'btn btn-quiet btn-small', type: 'button',
        onclick: () => copyText(viewText(v.nodes), 'Agent view copied'),
      }, 'Copy as text'),
    ),
    h('div', { class: 'view-searchbar' }, search),
    v.truncated ? h('p', { class: 'cap-note view-cap', text: `Showing the first ${v.nodes.length.toLocaleString()} lines. The token estimate covers the whole page.` }) : null,
    list, empty, more,
  );
}

function jumpTo(catId) {
  let el = document.getElementById(`cat-${catId}`);
  if (!el && (state.filter !== 'all' || state.tab !== 'report')) {
    state.filter = 'all';
    state.tab = 'report';
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
    item('Copy report as Markdown', () => copyText(toMarkdown(state.report), 'Report copied')),
    item('Copy report as prompt', () => copyText(toPrompt(state.report), 'Prompt copied')),
    item('Download Markdown', () => download('md')),
    item('Download JSON', () => download('json')),
    item('Clear audit history', clearHistory),
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
  L.push(`**Score:** ${r.score}/100, ${r.grade}  `);
  if (r.stats.tokens != null) L.push(`**Agent view:** about ${r.stats.tokens.toLocaleString()} tokens  `);
  L.push('');
  L.push(r.gradeText, '');
  if (r.previous) L.push(...diffMarkdown(r.previous), '');
  const catScore = (c) => (c.scored === false ? 'not scored' : c.score == null ? 'n/a' : c.score);
  L.push('| Category | Score |', '| --- | --- |');
  for (const c of r.categories) L.push(`| ${c.name} | ${catScore(c)} |`);
  L.push('');
  for (const cat of r.categories) {
    L.push(`## ${cat.name} (${cat.scored === false ? 'not scored' : cat.score == null ? 'n/a' : `${cat.score}/100`})`, '');
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

function diffMarkdown(d) {
  const when = new Date(d.ts).toLocaleString();
  const L = [`**Since the last audit (${when}):** score ${d.score} → ${d.score + d.delta}.`];
  if (d.fixed.length) L.push(`- Fixed: ${d.fixed.join('; ')}`);
  if (d.regressed.length) L.push(`- New problems: ${d.regressed.join('; ')}`);
  if (d.better.length) L.push(`- Fewer issues: ${d.better.join('; ')}`);
  if (d.worse.length) L.push(`- More issues: ${d.worse.join('; ')}`);
  return L;
}

// Same findings as toMarkdown, framed as a task for a coding agent: a goal,
// a checklist of every failing/warning check, and a fix-verify loop to run
// until the checklist is done. With `onlyId`, the prompt covers one check.
function toPrompt(r, onlyId) {
  const tick = (s) => String(s).replace(/`/g, 'ˋ');
  const todo = [];
  for (const cat of r.categories) {
    for (const c of cat.checks) {
      if ((c.status === 'fail' || c.status === 'warn') && (!onlyId || c.id === onlyId)) todo.push({ cat, c });
    }
  }
  todo.sort((a, b) => STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status] || (b.c.weight || 0) - (a.c.weight || 0));
  const L = [];
  if (onlyId && todo.length) {
    L.push(`# Task: fix “${todo[0].c.title}” on this page`, '');
    L.push(`An audit of **${r.title || 'Untitled'}** (${r.url}) scored **${r.score}/100, ${r.grade}**. `
      + 'This task covers one of its checks, which makes the page hard for AI agents to use.', '');
  } else {
    L.push('# Task: fix every agent-readiness issue on this page', '');
    L.push(`An audit of **${r.title || 'Untitled'}** (${r.url}) scored **${r.score}/100, ${r.grade}**. `
      + `It found ${todo.length} failing or warning ${todo.length === 1 ? 'check that makes' : 'checks that make'} the page hard for AI agents to use.`, '');
  }
  if (!onlyId && r.previous && r.previous.regressed.length) {
    L.push(`These checks passed in the previous audit and fail now, so look at recent changes first: ${r.previous.regressed.join('; ')}.`, '');
  }
  L.push('## Goal', '');
  L.push('Every item in the checklist below is fixed in the source code and verified by a test or a check you ran. '
    + 'Do not stop after the first fix: keep looping until the goal is met or you hit a stop condition.', '');
  L.push('## Loop', '');
  L.push('Work through the checklist in order (failures first) and repeat these steps for each item:', '');
  L.push('1. **Locate.** Find the code that renders the listed elements. Use the snippets and selectors as search hints; they come from the rendered DOM, so the source may look different (templates, components, CSS-in-JS).');
  L.push('2. **Fix.** Apply the fix described for the check. Fix the root cause in the shared component or template so every instance is covered, not just the listed ones. Keep changes minimal and match the existing code style.');
  L.push('3. **Test.** Add or update an automated test that fails without the fix and passes with it (e.g. a DOM/accessibility assertion, a Testing Library `getByRole`/`getByLabelText` query, or an axe-core rule). Run the project\'s test suite, linter and type checker.');
  L.push('4. **Verify.** Confirm in the rendered page that the listed elements now meet the check (correct role, accessible name, label, stable attribute, etc.). Also confirm nothing that previously passed has regressed.');
  L.push('5. **Record.** Tick the item in the checklist, note the files changed and the test that covers it, then move to the next item.', '');
  L.push('After the last item, run the full test suite once more and go back over the checklist. If anything is still open or a test fails, start the loop again for those items.', '');
  L.push('**Stop conditions:** stop and report instead of guessing when a fix needs a product or design decision, the code lives outside this repository (third-party widget, CMS content), or the same item fails verification three times.', '');
  L.push('## Checklist', '');
  if (!todo.length) L.push('No failing or warning checks. Nothing to fix.', '');
  todo.forEach(({ cat, c }, i) => {
    L.push(`- [ ] **${i + 1}. ${STATUS_LABEL[c.status]}: ${c.title}** (${cat.name}, \`${c.id}\`)`);
  });
  L.push('');
  L.push('## Issue details', '');
  todo.forEach(({ cat, c }, i) => {
    L.push(`### ${i + 1}. ${c.title}`, '');
    L.push(`**Status:** ${STATUS_LABEL[c.status]} · **Category:** ${cat.name} · **Check id:** \`${c.id}\``, '');
    L.push(c.summary, '');
    L.push(`**Why it matters:** ${c.why}`, '');
    L.push(`**How to fix:** ${c.fix}`, '');
    if (c.findings.length) L.push('**Affected elements:**', '');
    for (const f of c.findings.slice(0, 20)) {
      L.push(`- \`${tick(f.snippet)}\`${f.note ? `: ${f.note}` : ''}${f.selector ? `  \n  Selector: \`${tick(f.selector)}\`` : ''}`);
    }
    if (c.issues > Math.min(20, c.findings.length)) L.push(`- …and ${(c.issues - Math.min(20, c.findings.length)).toLocaleString()} more of the same kind; your fix must cover them too`);
    if (c.findings.length) L.push('');
    L.push('**Done when:** every affected element (listed or not) passes this check and a test covers it.', '');
  });
  L.push('## Final report', '');
  L.push('When the loop ends, reply with: the completed checklist, the files changed per item, the tests added, the test-suite result, and any items you stopped on and why. '
    + 'The user will re-run Agent-Readiness Auditor on the page to confirm the score.', '');
  L.push('---', `Generated by Agent-Readiness Auditor ${r.version}.`);
  return L.join('\n');
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
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

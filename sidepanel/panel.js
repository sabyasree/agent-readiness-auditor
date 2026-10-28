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
  ['Shopping agents', 'On product pages: can an AI shopping agent read the price, stock and cart button?'],
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
  tab: 'overview',
  viewFilter: 'all',
  viewQuery: '',
  running: false,
  marked: false,
  usage: null,
  test: { task: '', result: null, running: false, ai: null },
  site: null,
  compareOpen: false,
  compareWith: null,
  watch: null, // tab id whose audit re-runs after each reload
};

const VERSION = chrome.runtime.getManifest().version;
const WHATS_NEW = 'A new tab bar puts everything one click away. Plus: scan up to 25 pages of a site and find the problems they share, suggested code for each fix, compare any two pages, and re-run on every reload.';

const $view = document.getElementById('view');
const $run = document.getElementById('runBtn');
const $pageLabel = document.getElementById('pageLabel');
const $banner = document.getElementById('banner');
const $toast = document.getElementById('toast');
const $tabs = document.getElementById('tabs');

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
  $view.replaceChildren(...nodes.filter(Boolean));
  $tabs.hidden = true; // renderResults shows it again
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
  const cats = Object.fromEntries(r.categories.filter((c) => c.scored !== false && c.score != null).map((c) => [c.name, c.score]));
  return { ts: r.timestamp, score: r.score, title: r.title, cats, checks };
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
  all[key] = { ...summarize(r), prev: prev ? prev.score : null };
  const keys = Object.keys(all);
  if (keys.length > HISTORY_MAX) {
    keys.sort((a, b) => all[a].ts - all[b].ts).slice(0, keys.length - HISTORY_MAX).forEach((k) => delete all[k]);
  }
  try { await chrome.storage.local.set({ [HISTORY_KEY]: all }); } catch { /* quota or unavailable */ }
}

async function clearHistory() {
  try {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove([HISTORY_KEY, ...Object.keys(all).filter((k) => k.startsWith('sitescan:'))]);
  } catch { /* ignore */ }
  state.site = null;
  if (state.report) { state.report.previous = null; saveReport(state.tabId, state.report); renderResults(); }
  toast('Audit history cleared');
}

// Usage counters for the review prompt and "What's new". Local only.
const USAGE_KEY = 'usage';

async function loadUsage() {
  try { state.usage = (await chrome.storage.local.get(USAGE_KEY))[USAGE_KEY] || null; } catch { state.usage = null; }
  if (!state.usage) state.usage = { audits: 0, review: 'ask', reviewAfter: 3, seenVersion: VERSION, firstTs: Date.now() };
  if (!state.usage.seenVersion) state.usage.seenVersion = VERSION;
  return state.usage;
}
async function saveUsage() {
  try { await chrome.storage.local.set({ [USAGE_KEY]: state.usage }); } catch { /* ignore */ }
}

/** Ask for a rating at a good moment: after a few audits, ideally right after the score went up. */
function shouldAskForReview(r) {
  const u = state.usage;
  if (!u || u.review !== 'ask' || u.audits < u.reviewAfter) return false;
  return (r.previous && r.previous.delta > 0) || u.audits >= u.reviewAfter + 2;
}

/** The score on the toolbar icon, for this tab only. Cleared when the tab navigates. */
function setBadge(tabId, score) {
  const color = score >= 90 ? '#177245' : score >= 70 ? '#9A5A00' : '#B3261E';
  try {
    chrome.action.setBadgeText({ tabId, text: String(score) });
    chrome.action.setBadgeBackgroundColor({ tabId, color });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' });
  } catch { /* ignore */ }
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
  if (state.marked) { state.marked = false; pageCall(clearMarksInPage); }

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
    setBadge(tabId, report.score);
    if (state.usage) { state.usage.audits++; saveUsage(); }
    if (state.tabId === tabId) {
      state.report = report;
      state.test = { task: state.test.task, result: null, running: false, ai: state.test.ai };
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
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => chrome.tabs.create({ url: `${SITE_URL}/demo/` }) }, 'Try the demo store'),
      ),
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

async function pageCall(func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func, args });
    return res ? res.result : null;
  } catch { return null; }
}

async function toggleMarks(btn) {
  const r = state.report;
  if (!r) return;
  if (state.marked && await pageCall(marksShownInPage)) {
    await pageCall(clearMarksInPage);
    state.marked = false;
  } else {
    const items = [];
    for (const cat of r.categories) {
      for (const c of cat.checks) {
        if (c.status !== 'fail' && c.status !== 'warn') continue;
        for (const f of c.findings) items.push({ ref: f.ref, selector: f.selector, tone: c.status, label: f.note ? `${c.title}: ${f.note}` : c.title });
      }
    }
    if (!items.length) return toast('No elements to mark. The issues on this page are page-wide.');
    const res = await pageCall(markAllInPage, [items, r.runId]);
    if (!res || !res.ok) return toast('Couldn’t reach the page. Run the audit again.');
    if (!res.shown) return toast('Those elements are no longer on the page. Run the audit again.');
    state.marked = true;
    toast(`Marked ${res.shown} ${res.shown === 1 ? 'element' : 'elements'} on the page. Hover a number for details.`);
  }
  btn.textContent = state.marked ? 'Hide marks' : 'Mark issues on page';
  btn.setAttribute('aria-pressed', String(state.marked));
}

function reportBlobUrl() {
  return URL.createObjectURL(new Blob([toHtmlReport(state.report)], { type: 'text/html' }));
}

async function openShareableReport() {
  if (!state.report) return;
  const url = reportBlobUrl();
  try { await chrome.tabs.create({ url }); } catch { window.open(url, '_blank'); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Report opened in a new tab. Use Print → Save as PDF to send it.');
}

async function toggleWatch() {
  const r = state.report;
  if (!r) return;
  if (state.watch === state.tabId) {
    state.watch = null;
  } else {
    let origin;
    try { origin = new URL(r.url).origin; } catch { return; }
    // Re-running after a reload needs lasting access to this site (the one-time access ends on reload).
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [`${origin}/*`] }); } catch { granted = false; }
    if (!granted) return toast('Re-run on reload needs access to this site.');
    state.watch = state.tabId;
    toast('The audit will run again each time this page reloads.');
  }
  renderResults();
}

function compareCard(r) {
  if (!state.compareOpen) return null;
  const card = h('section', { class: 'compare-card', 'aria-label': 'Compare' }, h('p', { class: 'test-progress', text: 'Loading your recent audits…' }));
  const label = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return u; } };
  readHistory().then((all) => {
    const me = pageKey(r.url);
    const others = Object.entries(all).filter(([u]) => u !== me).sort((a, b) => b[1].ts - a[1].ts).slice(0, 30);
    if (!others.length) {
      card.replaceChildren(h('p', { class: 'compare-empty', text: 'Audit another page first, such as a competitor’s homepage or product page, then compare it with this one here.' }));
      return;
    }
    const pick = state.compareWith && all[state.compareWith] && state.compareWith !== me ? state.compareWith : others[0][0];
    const o = all[pick];
    const select = h('select', {
      id: 'compare-with', class: 'view-search',
      onchange: (e) => { state.compareWith = e.target.value; renderResults(); },
    }, others.map(([u, e]) => h('option', { value: u, selected: u === pick || null }, `${label(u)} (${e.score})`)));
    const cell = (v) => h('td', { class: `num tone-${toneFor(v)}`, text: v == null ? '–' : String(v) });
    const rows = [['Overall', r.score, o.score], ...r.categories.filter((c) => c.scored !== false)
      .map((c) => [c.name, c.score, o.cats ? o.cats[c.name] : undefined])
      .filter(([, a, b]) => a != null || b != null)];
    const isIssue = (s) => s === 'fail' || s === 'warn';
    const mine = r.categories.flatMap((c) => c.checks.filter((k) => c.scored !== false));
    const theyLead = mine.filter((k) => isIssue(k.status) && o.checks[k.id] && o.checks[k.id].s === 'pass').map((k) => k.title);
    const youLead = mine.filter((k) => k.status === 'pass' && o.checks[k.id] && isIssue(o.checks[k.id].s)).map((k) => k.title);
    const list = (title, items) => (items.length ? [h('h3', { text: title }), h('ul', {}, items.slice(0, 8).map((t) => h('li', { text: t })))] : null);
    card.replaceChildren(...[
      h('label', { for: 'compare-with', class: 'test-label', text: 'Compare this page with' }),
      select,
      h('table', { class: 'compare-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'This page' }), h('th', { text: 'Other' }))),
        h('tbody', {}, rows.map(([name, a, b]) => h('tr', { class: name === 'Overall' ? 'overall' : '' }, h('td', { text: name }), cell(a), cell(b == null ? null : b))))),
      o.cats ? null : h('p', { class: 'compare-note', text: 'Category scores appear for pages audited with version 1.4 or later.' }),
      list('Where the other page does better', theyLead),
      list('Where this page does better', youLead),
      h('p', { class: 'compare-note', text: `Other page audited ${timeAgo(o.ts)}. Run it again for a fresh comparison.` }),
    ].flat().filter(Boolean));
  });
  return card;
}

function jumpToCheck(id) {
  state.tab = 'issues';
  if (state.filter === 'passed') state.filter = 'issues';
  renderResults();
  const el = document.getElementById(`check-${id}`);
  if (!el) return;
  el.open = true;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = el.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar').offsetHeight - 8;
  window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  el.querySelector('summary').focus({ preventScroll: true });
}

// --------------------------------------------------------------- rendering

function whatsNewCard() {
  const u = state.usage;
  if (!u || u.seenVersion === VERSION) return null;
  const card = h('section', { class: 'note-card', 'aria-label': 'What’s new' },
    h('div', {}, h('strong', { text: `New in ${VERSION}` }), h('p', { text: WHATS_NEW })),
    h('button', {
      class: 'btn btn-quiet btn-small', type: 'button',
      onclick: () => { u.seenVersion = VERSION; saveUsage(); card.remove(); },
    }, 'Got it'),
  );
  return card;
}

function reviewCard(r) {
  if (!shouldAskForReview(r)) return null;
  const u = state.usage;
  const up = r.previous && r.previous.delta > 0;
  const done = (value, after) => { u.review = value; if (after) u.reviewAfter = u.audits + after; saveUsage(); card.remove(); };
  const card = h('section', { class: 'note-card review-card', 'aria-label': 'Rate the extension' },
    h('div', {},
      h('strong', { text: up ? `Up ${r.previous.delta} points. Nice work.` : 'Finding this useful?' }),
      h('p', { text: 'A quick rating on the Chrome Web Store helps other developers find it. It takes ten seconds.' }),
    ),
    h('div', { class: 'note-actions' },
      h('button', {
        class: 'btn btn-primary btn-small', type: 'button',
        onclick: () => { chrome.tabs.create({ url: `${STORE_URL}/reviews` }); done('done'); },
      }, 'Rate it'),
      h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { u.review = 'ask'; done('ask', 8); } }, 'Not now'),
      h('button', { class: 'btn-link', type: 'button', onclick: () => done('never') }, 'Don’t ask again'),
    ),
  );
  return card;
}

function topFixesCard(r) {
  const fixes = topFixes(r, 3);
  if (!fixes.length) return null;
  const all = scoreWith(r, fixes.map((f) => f.check.id));
  return h('section', { class: 'fixes-card', 'aria-labelledby': 'fixes-h' },
    h('div', { class: 'fixes-head' },
      h('h2', { id: 'fixes-h', text: 'Fix these first' }),
      h('span', { class: 'fixes-target', text: `${r.score} → ${all}` }),
    ),
    h('ol', { class: 'fixes' },
      fixes.map((f) => h('li', {},
        h('button', { type: 'button', onclick: () => jumpToCheck(f.check.id) },
          h('span', { class: 'gain', text: `+${f.gain}` }),
          h('span', { class: 'fix-text' },
            h('strong', { text: f.check.title }),
            h('span', { text: f.check.summary }),
          ),
        ),
      )),
    ),
    h('div', { class: 'fixes-actions' },
      h('button', {
        class: 'btn btn-quiet btn-small', type: 'button',
        onclick: () => copyText(toPrompt(r, fixes.map((f) => f.check.id)), 'Prompt for the top fixes copied'),
      }, 'Copy prompt for these'),
    ),
  );
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

async function renderRecent(list) {
  const all = await readHistory();
  const rows = Object.entries(all).sort((a, b) => b[1].ts - a[1].ts).slice(0, 8);
  if (!rows.length) { list.parentElement.remove(); return; }
  list.replaceChildren(...rows.map(([url, e]) => {
    let label = url;
    try { const u = new URL(url); label = u.host + (u.pathname === '/' ? '' : u.pathname); } catch { /* keep url */ }
    const delta = e.prev != null ? e.score - e.prev : 0;
    return h('li', {},
      h('button', { type: 'button', title: `Open ${url}`, onclick: () => chrome.tabs.create({ url }) },
        h('span', { class: `recent-score tone-${toneFor(e.score)}`, text: String(e.score) }),
        h('span', { class: 'recent-text' },
          h('strong', { text: e.title || label }),
          h('span', { text: `${label} · ${timeAgo(e.ts)}` }),
        ),
        delta ? h('span', { class: `recent-delta tone-${delta > 0 ? 'pass' : 'fail'}`, text: delta > 0 ? `+${delta}` : `−${-delta}` }) : null,
      ),
    );
  }));
}

function renderEmpty() {
  $pageLabel.textContent = 'Audit the page you’re on';
  const recentList = h('ul', { class: 'recent-list' });
  setView(
    whatsNewCard(),
    h('section', { class: 'intro' },
      h('h1', { text: 'How well can AI agents use this page?' }),
      h('p', { text: 'Run an audit to see how easily agents like Claude, Gemini and ChatGPT can read this page, find its controls and finish tasks on it. You’ll get a score and specific fixes.' }),
      h('div', { class: 'intro-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: runAudit }, 'Run audit'),
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => chrome.tabs.create({ url: `${SITE_URL}/demo/` }) }, 'Try the demo store'),
      ),
      h('section', { class: 'recent', 'aria-labelledby': 'recent-h' },
        h('h2', { id: 'recent-h', text: 'Recent audits' }),
        recentList,
      ),
      h('section', { class: 'gets', 'aria-labelledby': 'gets-h' },
        h('h2', { id: 'gets-h', text: 'What you get' }),
        h('ul', {}, [
          ['overview', 'A score and what to fix first', 'Ranked by how many points each fix is worth, with code you can copy.'],
          ['agent', 'The page as an agent sees it', 'Its accessibility tree, with every unnamed button flagged.'],
          ['test', 'A test run of a real task', 'Type “add to cart” or “sign up” and see where an agent gets stuck.'],
          ['site', 'A scan of the whole site', 'Up to 25 pages, and the problems they share.'],
        ].map(([id, title, sub]) => h('li', {}, icon(TAB_ICON[id], 'tool-ico'), h('span', { class: 'tool-text' }, h('strong', { text: title }), h('span', { text: sub }))))),
      ),
      h('details', { class: 'scope-details' },
        h('summary', {}, 'What it checks', h('span', { html: CHEVRON, style: { display: 'inline-flex' } })),
        h('ul', { class: 'scope', 'aria-label': 'What the audit checks' },
          CATEGORY_INTRO.map(([name, desc]) => h('li', {}, h('strong', { text: name }), h('span', { text: desc }))),
        ),
      ),
      h('p', { class: 'privacy', text: 'Everything runs in your browser. Nothing about the page is sent anywhere.' }),
    ),
  );
  renderRecent(recentList);
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
    f.fix ? h('details', { class: 'fix' },
      h('summary', {}, 'Suggested fix'),
      h('pre', { text: f.fix }),
      h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => copyText(f.fix, 'Fix copied') }, 'Copy code'),
    ) : null,
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
  return h('details', { class: 'check', id: `check-${c.id}`, open: open || null },
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

// The five results views, shown in a tab bar that stays under the header.
const TABS = [
  ['overview', 'Overview', '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4.5-5"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'],
  ['issues', 'Issues', '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor"/>'],
  ['agent', 'Agent view', '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'],
  ['test', 'Agent test', '<path d="M6 3.5l12.5 7.2-5.6 1.6-2.6 5.3z"/><path d="M13 13l5 5"/>'],
  ['site', 'Site scan', '<rect x="7.5" y="3" width="12.5" height="14.5" rx="2"/><path d="M4 7v11.5A2.5 2.5 0 0 0 6.5 21H16"/>'],
];
const icon = (paths, cls = 'ico') => h('span', { class: cls, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>` });
const TAB_ICON = Object.fromEntries(TABS.map(([id, , paths]) => [id, paths]));

function switchTab(id) {
  state.tab = id;
  renderResults();
  window.scrollTo(0, 0);
  document.getElementById(`tab-${id}`)?.focus({ preventScroll: true });
}

function renderTabs(r) {
  const issueCount = r.counts.fail + r.counts.warn;
  const unnamed = r.agentView ? r.agentView.unnamed : 0;
  const ids = TABS.map(([id]) => id);
  $tabs.replaceChildren(...TABS.map(([id, label, paths]) => {
    const badge = id === 'issues' && issueCount ? String(issueCount) : id === 'agent' && unnamed ? String(unnamed) : '';
    return h('button', {
      type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(state.tab === id), 'aria-controls': 'tabpanel',
      tabindex: state.tab === id ? '0' : '-1',
      title: { overview: 'Score and what to fix first', issues: 'Every check, with fixes', agent: 'The page as an agent reads it', test: 'Test a task the way an agent would', site: 'Audit up to 25 pages of this site' }[id],
      onclick: () => switchTab(id),
      onkeydown: (e) => {
        const i = ids.indexOf(state.tab);
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
        if (next == null) return;
        e.preventDefault();
        switchTab(ids[(next + ids.length) % ids.length]);
      },
    },
    icon(paths),
    h('span', { class: 'tab-label', text: label }),
    badge ? h('span', { class: `tab-badge${id === 'agent' ? ' tab-badge-soft' : ''}`, text: badge, 'aria-label': id === 'issues' ? `${badge} issues` : `${badge} unnamed controls` }) : null);
  }));
  $tabs.hidden = false;
}

function scoreHeader(r) {
  const breakdown = [];
  if (r.counts.fail) breakdown.push(`${r.counts.fail} failing`);
  if (r.counts.warn) breakdown.push(`${r.counts.warn} ${r.counts.warn === 1 ? 'warning' : 'warnings'}`);
  breakdown.push(`${r.counts.pass} passed`);
  return h('section', { class: 'score', 'aria-label': 'Overall score' },
    h('div', { class: 'score-head' },
      h('div', { class: `score-num tone-${toneFor(r.score)}` }, String(r.score), h('small', { text: '/100' })),
      h('div', { class: 'score-grade' },
        h('strong', { text: r.grade }),
        h('span', { text: breakdown.join(', ') }),
      ),
    ),
    h('p', { class: 'score-text', text: r.gradeText }),
    renderDiff(r.previous),
  );
}

const TOOL_ICONS = {
  mark: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
  share: '<path d="M12 3v12"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  compare: '<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/>',
  rerun: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
};

function toolsSection() {
  const watching = state.watch === state.tabId;
  const tile = (key, title, sub, onclick, pressed) => h('button', {
    type: 'button', class: `tool${pressed ? ' is-on' : ''}`, onclick, 'aria-pressed': pressed == null ? null : String(!!pressed),
  }, icon(TOOL_ICONS[key], 'tool-ico'), h('span', { class: 'tool-text' }, h('strong', { text: title }), h('span', { text: sub })));
  return h('section', { class: 'block', 'aria-labelledby': 'tools-h' },
    h('h2', { id: 'tools-h', class: 'block-h', text: 'Tools' }),
    h('div', { class: 'tools' },
      tile('mark', state.marked ? 'Hide marks' : 'Mark issues', 'Number every problem on the page', (e) => toggleMarks(e.currentTarget), state.marked),
      tile('share', 'Share report', 'Send it, or save as PDF', openShareableReport),
      tile('compare', 'Compare', 'Next to another page you audited', () => { state.compareOpen = !state.compareOpen; renderResults(); }, state.compareOpen),
      tile('rerun', watching ? 'Re-run on reload: on' : 'Re-run on reload', watching ? 'Runs again after each reload' : 'For when you’re editing the site', toggleWatch, watching),
    ),
    compareCard(state.report),
  );
}

function categoriesSection(r) {
  return h('section', { class: 'block', 'aria-labelledby': 'cats-h' },
    h('div', { class: 'block-head' },
      h('h2', { id: 'cats-h', class: 'block-h', text: 'Scores by category' }),
      h('button', { type: 'button', class: 'btn-link', onclick: () => switchTab('issues') }, 'See all checks'),
    ),
    h('ul', { class: 'cats' },
      r.categories.map((c) => h('li', {},
        h('button', { type: 'button', title: `See the ${c.name} checks`, onclick: () => jumpTo(c.id) },
          h('span', { class: 'cat-name', text: c.name }),
          c.scored === false
            ? h('span', { class: 'cat-unscored', text: 'Not scored' })
            : [h('span', { class: `cat-bar tone-${toneFor(c.score)}`, 'aria-hidden': 'true' }, h('b', { style: { width: `${c.score ?? 0}%` } })),
              h('span', { class: `cat-score tone-${toneFor(c.score)}`, text: c.score == null ? 'n/a' : String(c.score) })],
          h('span', { html: CHEVRON, class: 'cat-chev' }),
        ),
      )),
    ),
  );
}

function exploreSection(r) {
  const v = r.agentView;
  const items = [
    ['agent', 'See it as an agent', v ? `About ${v.tokens.toLocaleString()} tokens${v.unnamed ? `, ${v.unnamed} unnamed ${v.unnamed === 1 ? 'control' : 'controls'}` : ''}` : 'The page’s accessibility tree'],
    ['test', 'Test a task', 'Can an agent “add to cart” or “sign up” here?'],
    ['site', 'Scan the whole site', 'Up to 25 pages, free'],
  ];
  return h('section', { class: 'block', 'aria-labelledby': 'explore-h' },
    h('h2', { id: 'explore-h', class: 'block-h', text: 'Explore more' }),
    h('div', { class: 'explore' }, items.map(([id, title, sub]) => h('button', { type: 'button', class: 'explore-item', onclick: () => switchTab(id) },
      icon(TAB_ICON[id], 'tool-ico'),
      h('span', { class: 'tool-text' }, h('strong', { text: title }), h('span', { text: sub })),
      h('span', { html: CHEVRON, class: 'cat-chev' }),
    ))),
  );
}

function issuesView(r) {
  const issueCount = r.counts.fail + r.counts.warn;
  const passCount = r.counts.pass + r.counts.info + r.counts.na;
  const filterBtn = (id, label, count) => h('button', {
    type: 'button', 'aria-pressed': String(state.filter === id),
    onclick: () => { state.filter = id; renderResults(); },
  }, label, count != null ? h('span', { class: 'count', text: count }) : null);
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show checks' },
      filterBtn('issues', 'Issues', issueCount),
      filterBtn('passed', 'Passed', passCount),
      filterBtn('all', 'All', issueCount + passCount),
    ),
    buildExportMenu(),
  );
  const sections = [];
  let firstIssueOpened = false;
  for (const cat of r.categories) {
    const checks = visibleChecks(cat);
    if (!checks.length) continue;
    sections.push(h('section', { class: 'category', id: `cat-${cat.id}`, 'aria-labelledby': `cat-h-${cat.id}` },
      h('div', { class: 'category-head' },
        h('h2', { id: `cat-h-${cat.id}`, text: cat.name }),
        h('span', { class: `cat-score-lg tone-${toneFor(cat.score)}`, text: cat.scored === false ? 'Not scored' : cat.score == null ? 'n/a' : String(cat.score) }),
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
  return [toolbar, ...sections, auditFoot(r)];
}

function auditFoot(r) {
  const when = new Date(r.timestamp);
  return h('p', { class: 'foot' },
    `Audited ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} in ${(r.durationMs / 1000).toFixed(1)} s. `,
    `${r.stats.elements.toLocaleString()} elements, ${r.stats.controls.toLocaleString()} controls and ${r.stats.fields.toLocaleString()} form fields checked in the top frame. Scores are heuristics: use them to find problems, then confirm with a real agent.`,
  );
}

function renderResults() {
  const r = state.report;
  if (!r) return renderEmpty();
  if (!TABS.some(([id]) => id === state.tab)) state.tab = 'overview';
  $pageLabel.textContent = hostOf(r.url);
  $pageLabel.title = r.url;

  let body;
  if (state.tab === 'overview') {
    body = [scoreHeader(r), whatsNewCard(), reviewCard(r), topFixesCard(r), toolsSection(), categoriesSection(r), exploreSection(r), auditFoot(r)];
  } else if (state.tab === 'issues') body = issuesView(r);
  else if (state.tab === 'agent') body = [renderAgentView(r)];
  else if (state.tab === 'test') body = [renderAgentTest(r)];
  else body = [renderSiteScan(r)];

  setView(h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}`, class: `tabpanel tab-${state.tab}` }, body.filter(Boolean)));
  renderTabs(r);
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

// ------------------------------------------------------------- agent test

const VERDICT = {
  pass: ['An agent could likely do this', 'Every step uses a control an agent can find by name.'],
  warn: ['An agent might manage, with problems', 'Some steps rely on guesswork, or part of the task is hidden from agents.'],
  fail: ['An agent would probably get stuck', 'It can’t find the controls this task needs.'],
};

function renderAgentTest(r) {
  const t = state.test;
  const status = h('p', { class: 'ai-status', text: 'Checking for Chrome’s built-in AI…' });
  const input = h('input', {
    type: 'text', id: 'task', class: 'view-search', value: t.task, autocomplete: 'off',
    placeholder: 'For example: Add this product to the cart',
    oninput: (e) => { t.task = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); runTest(); } },
  });
  const runBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (t.running ? t.abort && t.abort.abort() : runTest()) }, t.running ? 'Cancel' : 'Run test');
  const result = h('div', { class: 'test-result', 'aria-live': 'polite' });

  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Suggested tasks' },
    testSuggestions(r).map((s) => h('button', {
      type: 'button', class: 'chip',
      onclick: () => { t.task = s; input.value = s; runTest(); },
    }, s)));

  aiAvailability().then((a) => {
    t.ai = a;
    status.textContent = {
      available: 'Uses Chrome’s built-in AI (Gemini Nano), running on your computer. Nothing leaves your browser.',
      downloadable: 'Uses Chrome’s built-in AI (Gemini Nano). The first test asks Chrome to download the model once; until then, tests use name matching.',
      downloading: 'Chrome is downloading its built-in AI model. Until it’s ready, tests use name matching.',
      unavailable: 'Using name matching. On computers with Chrome’s built-in AI (Gemini Nano), the test plans every step instead.',
    }[a] || '';
  });

  function show(node) { result.replaceChildren(node); }

  async function runTest() {
    const task = t.task.trim();
    if (!task) { input.focus(); return toast('Describe a task first.'); }
    if (t.running) return;
    const targets = testTargets(r);
    const hidden = hiddenControls(r);
    t.running = true;
    t.abort = new AbortController();
    runBtn.textContent = 'Cancel';
    show(h('p', { class: 'test-progress', text: 'Reading the page like an agent…' }));
    let plan;
    let mode = 'match';
    try {
      if (t.ai === 'available' || t.ai === 'downloadable' || t.ai === 'downloading') {
        try {
          plan = await aiPlan(task, r, targets, {
            signal: t.abort.signal,
            onProgress: (p) => show(h('p', { class: 'test-progress', text: `Downloading Chrome’s AI model… ${Math.round(p * 100)}%` })),
          });
          mode = 'ai';
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          plan = null; // fall back to name matching
        }
      }
      if (!plan) plan = matchPlan(task, targets);
      t.result = { task, mode, ...evaluatePlan(task, plan, targets, hidden) };
      show(renderTestResult(r, t.result));
    } catch (e) {
      show(h('p', { class: 'test-progress', text: e && e.name === 'AbortError' ? 'Test cancelled.' : `The test didn’t finish: ${(e && e.message) || e}` }));
    } finally {
      t.running = false;
      runBtn.textContent = 'Run test';
    }
  }

  if (t.result) result.append(renderTestResult(r, t.result));
  return h('section', { class: 'agent-test' },
    h('p', { class: 'view-intro', text: 'Describe something a person would ask an agent to do here. The test reads the page the way agents do, plans the clicks, and shows where an agent would get stuck. Nothing on the page is clicked.' }),
    status,
    h('div', { class: 'test-form' },
      h('label', { for: 'task', class: 'test-label', text: 'Task' }),
      h('div', { class: 'test-row' }, input, runBtn),
      chips,
    ),
    result,
  );
}

function renderTestResult(r, res) {
  const [title, sub] = VERDICT[res.verdict];
  const stepLabel = (s, i) => `${i + 1}. ${s.action === 'type' ? 'Type' : s.action === 'select' ? 'Choose' : 'Click'}${s.text && s.action !== 'click' ? ` “${s.text.slice(0, 40)}” into` : ''} ${describeTarget(s.target)}`;
  const steps = res.steps.map((s, i) => h('li', { class: s.problem ? 'step-problem' : '' },
    h('span', { class: 'step-text', text: stepLabel(s, i) }),
    s.problem ? h('span', { class: 'step-note', text: s.problem }) : null,
    s.target ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => locate({ ref: s.target.ref, selector: '' }, stepLabel(s, i)) },
      h('span', { html: LOCATE_ICON, style: { display: 'inline-flex' } }), 'Show') : null,
  ));
  const checkIds = [...new Set([...res.hidden.map((x) => x.checkId), ...(res.steps.some((s) => s.target && s.target.unnamed) ? ['unnamed-controls'] : [])])]
    .filter((id) => r.categories.some((c) => c.checks.some((k) => k.id === id && (k.status === 'fail' || k.status === 'warn'))));

  return h('div', { class: `test-card tone-border-${res.verdict}` },
    h('div', { class: 'test-verdict' },
      glyph(res.verdict),
      h('div', {}, h('strong', { text: title }), h('span', { text: sub })),
    ),
    res.steps.length ? [h('h3', { text: 'The agent’s plan' }), h('ol', { class: 'test-steps' }, steps)] : null,
    res.missing ? h('p', { class: 'test-note' }, h('b', { text: 'What it couldn’t find: ' }), res.missing) : null,
    res.hidden.length ? [
      h('h3', { text: 'Visible to people, invisible to agents' }),
      h('ul', { class: 'test-hidden' }, res.hidden.slice(0, 4).map((x) => h('li', {},
        h('span', { text: `“${x.text.slice(0, 50)}” looks clickable, but it isn’t a button or link, so agents can’t use it.` }),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => locate({ ref: x.ref, selector: x.selector }, x.text.slice(0, 40)) },
          h('span', { html: LOCATE_ICON, style: { display: 'inline-flex' } }), 'Show'),
      ))),
    ] : null,
    res.alternatives.length ? h('p', { class: 'test-note', text: `Other close matches: ${res.alternatives.map(describeTarget).join(', ')}.` }) : null,
    h('div', { class: 'test-actions' },
      res.steps.some((s) => s.target) ? h('button', {
        class: 'btn btn-quiet btn-small', type: 'button',
        onclick: async () => {
          const items = res.steps.filter((s) => s.target).map((s) => ({ ref: s.target.ref, selector: '', tone: 'step', label: stepLabel(s, res.steps.indexOf(s)) }));
          const out = await pageCall(markAllInPage, [items, r.runId, { steps: true }]);
          if (!out || !out.shown) toast('Couldn’t reach those elements. Run the audit again.');
          else state.marked = true;
        },
      }, 'Show steps on page') : null,
      checkIds.length ? h('button', {
        class: 'btn btn-quiet btn-small', type: 'button',
        onclick: () => copyText(toPrompt(r, checkIds), 'Fix prompt copied'),
      }, 'Copy fix prompt') : null,
    ),
    h('p', { class: 'test-method', text: res.mode === 'ai' ? 'Planned by Gemini Nano on your device. Small models make mistakes; treat this as a quick check, not proof.' : 'Matched by control names. With Chrome’s built-in AI the test plans multi-step tasks.' }),
  );
}

function jumpTo(catId) {
  if (state.tab !== 'issues') { state.tab = 'issues'; renderResults(); }
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
    item('Copy report as Markdown', () => copyText(toMarkdown(state.report), 'Report copied')),
    item('Copy report as prompt', () => copyText(toPrompt(state.report), 'Prompt copied')),
    item('Download Markdown', () => download('md')),
    item('Download shareable report (HTML)', () => download('html')),
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
          L.push(`- \`${tick(f.snippet)}\`${f.note ? `: ${f.note}` : ''}${f.selector ? `  \n  Selector: \`${tick(f.selector)}\`` : ''}${f.fix ? `  \n  Suggested fix: \`${tick(f.fix.replace(/\n/g, ' '))}\`` : ''}`);
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
// until the checklist is done. With `ids` (one id or a list), the prompt
// covers only those checks.
function toPrompt(r, ids) {
  const only = ids == null ? null : [].concat(ids);
  const tick = (s) => String(s).replace(/`/g, 'ˋ');
  const todo = [];
  for (const cat of r.categories) {
    for (const c of cat.checks) {
      if ((c.status === 'fail' || c.status === 'warn') && (!only || only.includes(c.id))) todo.push({ cat, c });
    }
  }
  todo.sort((a, b) => STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status] || (b.c.weight || 0) - (a.c.weight || 0));
  const L = [];
  if (only && todo.length > 1) {
    L.push(`# Task: fix the top ${todo.length} agent-readiness issues on this page`, '');
    L.push(`An audit of **${r.title || 'Untitled'}** (${r.url}) scored **${r.score}/100, ${r.grade}**. `
      + `These ${todo.length} checks are the fixes that would raise the score the most.`, '');
  } else if (only && todo.length) {
    L.push(`# Task: fix “${todo[0].c.title}” on this page`, '');
    L.push(`An audit of **${r.title || 'Untitled'}** (${r.url}) scored **${r.score}/100, ${r.grade}**. `
      + 'This task covers one of its checks, which makes the page hard for AI agents to use.', '');
  } else {
    L.push('# Task: fix every agent-readiness issue on this page', '');
    L.push(`An audit of **${r.title || 'Untitled'}** (${r.url}) scored **${r.score}/100, ${r.grade}**. `
      + `It found ${todo.length} failing or warning ${todo.length === 1 ? 'check that makes' : 'checks that make'} the page hard for AI agents to use.`, '');
  }
  if (!only && r.previous && r.previous.regressed.length) {
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
      L.push(`- \`${tick(f.snippet)}\`${f.note ? `: ${f.note}` : ''}${f.selector ? `  \n  Selector: \`${tick(f.selector)}\`` : ''}${f.fix ? `  \n  Suggested fix (check names marked as guesses): \`${tick(f.fix.replace(/\n/g, ' '))}\`` : ''}`);
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
  const body = kind === 'md' ? toMarkdown(r) : kind === 'html' ? toHtmlReport(r) : JSON.stringify(r, null, 2);
  const type = { md: 'text/markdown', html: 'text/html', json: 'application/json' }[kind];
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = h('a', { href: url, download: `agent-readiness-${host}-${stamp}.${kind}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast({ md: 'Markdown downloaded', html: 'Report downloaded', json: 'JSON downloaded' }[kind]);
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
  await loadUsage();
  saveUsage();
  try {
    const win = await chrome.windows.getCurrent();
    state.windowId = win.id;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    await showTab(tab ? tab.id : null);
    // Opening the panel (icon or shortcut) grants access to this page, so start
    // right away instead of waiting for a second click.
    if (tab && !state.report) runAudit();
  } catch {
    renderEmpty();
  }

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (windowId === state.windowId) showTab(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== state.tabId) return;
    if (state.watch === tabId && info.status === 'complete') {
      let same = false;
      try { same = !!(tab.url && state.report && new URL(tab.url).origin === new URL(state.report.url).origin); } catch { /* ignore */ }
      if (same) { hideBanner(); setTimeout(runAudit, 600); return; }
    }
    if (info.status !== 'loading' || state.watch === tabId) return;
    if (state.report && !state.stale) {
      state.stale = true;
      showBanner('This page has changed since the audit.', 'Run it again', runAudit);
    }
  });
}

init();

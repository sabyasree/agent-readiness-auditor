'use strict';

// Site scan: audit up to 25 pages of one site in a background tab, then show
// which problems repeat across pages. A problem on most pages usually lives
// in a shared template, so one fix there fixes them all.

const SCAN_SIZES = [10, 25];

function scanCsv(scan) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cats = [...new Set(scan.pages.flatMap((p) => (p.result ? Object.keys(p.result.cats) : [])))];
  const rows = [['URL', 'Title', 'Score', 'Grade', ...cats, 'Problems'].map(q).join(',')];
  for (const p of scan.pages) {
    if (!p.result) { rows.push([q(p.url), q(''), q(''), q(p.error || 'Not audited')].join(',')); continue; }
    const r = p.result;
    rows.push([r.url, r.title, r.score, r.grade, ...cats.map((c) => r.cats[c] ?? ''), r.issues.map((i) => i.title).join('; ')].map(q).join(','));
  }
  return rows.join('\n');
}

function scanHtml(scan) {
  const s = summarizeScan(scan.pages);
  const tone = (v) => (v >= 90 ? 'pass' : v >= 70 ? 'warn' : 'fail');
  const host = (() => { try { return new URL(scan.origin).host; } catch { return scan.origin; } })();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent-readiness site report: ${esc(host)}</title>
<style>
  :root { --ink:#172033; --muted:#5A6678; --line:#D6DDE5; --paper:#EEF1F4; --pass:#177245; --warn:#9A5A00; --fail:#B3261E; --accent:#2F4BD0; }
  body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:900px; margin:0 auto; padding:32px 16px 48px; }
  h1, h2 { font-family:Charter,Georgia,serif; font-weight:600; } h1 { margin:0 0 4px; font-size:30px; } h2 { font-size:21px; margin:0 0 10px; }
  .brand { color:var(--accent); font-weight:700; font-size:13px; letter-spacing:.04em; text-transform:uppercase; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin:16px 0; break-inside:avoid-page; }
  .big { font:600 64px/1 Charter,Georgia,serif; } .muted { color:var(--muted); } .small { font-size:13px; }
  table { width:100%; border-collapse:collapse; } td, th { text-align:left; padding:7px 6px; border-top:1px solid var(--line); vertical-align:top; font-size:14px; }
  th { font-size:12px; color:var(--muted); font-weight:600; } td.num { text-align:right; font-weight:700; white-space:nowrap; }
  .pass { color:var(--pass); } .warn { color:var(--warn); } .fail { color:var(--fail); }
  .tag { display:inline-block; font-size:11px; font-weight:700; color:var(--accent); background:#E6EAFB; border-radius:4px; padding:1px 6px; margin-left:6px; }
  a { color:var(--accent); overflow-wrap:anywhere; } footer { text-align:center; color:var(--muted); font-size:13px; margin-top:24px; }
  @media print { body { background:#fff; } }
</style></head><body><div class="wrap">
<div class="brand">Agent-readiness site report</div>
<h1>${esc(host)}</h1>
<div class="muted small">${s.done} pages audited · ${esc(new Date(scan.ts).toLocaleString())}</div>
<section class="card"><div class="big ${tone(s.avg)}">${s.avg}<span class="small muted">/100 average</span></div>
<p class="muted">Lowest: ${s.worst[0] ? `${esc(pathOf(s.worst[0].result.url))} (${s.worst[0].result.score})` : '–'}</p></section>
<section class="card"><h2>Problems shared across pages</h2>
<p class="muted small">A problem on most pages usually comes from a shared template or component. Fix it there once.</p>
<table><tr><th>Problem</th><th>Category</th><th>Pages</th></tr>
${s.shared.map((x) => `<tr><td>${esc(x.title)}${x.pages.length / s.done >= 0.5 && s.done > 2 ? '<span class="tag">Likely a shared template</span>' : ''}</td><td>${esc(x.cat)}</td><td class="num">${x.pages.length} of ${s.done}</td></tr>`).join('')}
</table></section>
<section class="card"><h2>Pages</h2><table><tr><th>Page</th><th>Problems</th><th>Score</th></tr>
${scan.pages.map((p) => (p.result
    ? `<tr><td><a href="${esc(p.result.url)}">${esc(pathOf(p.result.url))}</a><div class="muted small">${esc(p.result.title || '')}</div></td><td class="small">${esc(p.result.issues.map((i) => i.title).join('; ') || 'None')}</td><td class="num ${tone(p.result.score)}">${p.result.score}</td></tr>`
    : `<tr><td>${esc(pathOf(p.url))}</td><td class="small muted">${esc(p.error || 'Not audited')}</td><td></td></tr>`)).join('')}
</table></section>
<footer>Made with <a href="${STORE_URL}">Agent-Readiness Auditor</a>, a free Chrome extension</footer>
</div></body></html>`;
}

/** A coding-agent task covering the problems shared across pages. */
function scanPrompt(scan) {
  const s = summarizeScan(scan.pages);
  const L = [];
  L.push(`# Task: fix the agent-readiness problems shared across ${scan.origin}`, '');
  L.push(`A scan of ${s.done} pages scored an average of **${s.avg}/100**. The problems below repeat across pages, so they almost certainly live in shared templates, layouts or components. Fix each one at that shared source, not page by page.`, '');
  L.push('## Loop', '');
  L.push('For each item, in order: **locate** the shared template or component that renders it on the listed pages; **fix** it there (prefer native HTML: real <button> and <a href>, <label> for fields); **test** it with an automated check that fails before and passes after; **verify** on two or three of the listed pages; **record** the files changed. Repeat until the checklist is done, then run the full test suite. Stop and report if a fix needs a product decision or the code isn’t in this repository.', '');
  L.push('## Checklist', '');
  s.shared.slice(0, 15).forEach((x, i) => {
    L.push(`- [ ] **${i + 1}. ${x.title}** (${x.cat}, \`${x.id}\`): on ${x.pages.length} of ${s.done} pages, ${x.total} ${x.total === 1 ? 'instance' : 'instances'}`);
    L.push(`  Pages: ${x.pages.slice(0, 5).map(pathOf).join(', ')}${x.pages.length > 5 ? ', …' : ''}`);
  });
  L.push('', 'When done, reply with the completed checklist, the files changed and the tests added. The user will scan the site again to confirm.', '');
  L.push('---', 'Generated by Agent-Readiness Auditor.');
  return L.join('\n');
}

// ------------------------------------------------------------------ UI

function renderSiteScan(r) {
  let origin = '';
  try { origin = new URL(r.url).origin; } catch { /* ignore */ }
  if (!/^https?:/.test(origin)) return h('p', { class: 'view-empty', text: 'Site scans work on regular websites.' });
  const host = new URL(origin).host;
  const site = state.site && state.site.origin === origin ? state.site : (state.site = { origin, phase: 'idle', pages: [], source: 'auto', size: 10 });
  const box = h('section', { class: 'site-scan' });

  // The scan keeps running if the person switches tabs; it always redraws the newest view.
  const draw = () => site.redraw && site.redraw();
  site.redraw = () => {
    const parts = site.phase === 'idle' ? idleView() : [...progressView(), ...(site.phase === 'done' ? resultView() : [])];
    box.replaceChildren(...parts.filter(Boolean));
  };

  function idleView() {
    const choice = (key, value, label) => h('button', {
      type: 'button', 'aria-pressed': String(site[key] === value),
      onclick: () => { site[key] = value; draw(); },
    }, label);
    const last = site.saved;
    return [
      h('p', { class: 'view-intro', text: `Audit up to 25 pages of ${host} and find the problems they share. A problem on most pages usually comes from one template, so one fix covers them all.` }),
      h('div', { class: 'scan-form' },
        h('div', { class: 'scan-row' },
          h('span', { class: 'test-label', text: 'Pages from' }),
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Where to find pages' },
            choice('source', 'auto', 'Sitemap'), choice('source', 'links', 'Links on this page')),
        ),
        h('div', { class: 'scan-row' },
          h('span', { class: 'test-label', text: 'How many' }),
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'How many pages' },
            SCAN_SIZES.map((n) => choice('size', n, `${n} pages`))),
        ),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: startScan }, `Scan ${site.size} pages`),
        h('p', { class: 'scan-note', text: 'Pages open one at a time in a background tab, which closes when the scan ends. Keep this panel open. Nothing is sent anywhere.' }),
      ),
      last ? h('div', { class: 'scan-last' },
        h('span', { text: `${last.auto ? 'Last weekly re-scan' : 'Last scan'} ${timeAgo(last.ts)}: ${summarizeScan(last.pages).done} pages, average ${summarizeScan(last.pages).avg}.` }),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { Object.assign(site, { phase: 'done', pages: last.pages, ts: last.ts }); draw(); } }, 'View'),
      ) : null,
    ];
  }

  function progressView() {
    const done = site.pages.filter((p) => p.result || p.error).length;
    const running = site.phase === 'running';
    const icon = (p) => (p.result ? h('span', { class: `scan-score tone-${toneFor(p.result.score)}`, text: String(p.result.score) })
      : p.error ? h('span', { class: 'scan-score tone-na', text: '–', title: p.error })
        : p.running ? h('span', { class: 'scan-spin', 'aria-label': 'Auditing' }) : h('span', { class: 'scan-score tone-na', text: '·' }));
    return [
      h('div', { class: 'scan-head' },
        h('strong', { text: running ? `Auditing ${Math.min(done + 1, site.pages.length)} of ${site.pages.length}…` : `${done} pages scanned` }),
        running
          ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { site.cancel = true; } }, 'Stop')
          : h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { site.phase = 'idle'; draw(); } }, 'New scan'),
      ),
      h('div', { class: 'scan-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(site.pages.length), 'aria-valuenow': String(done) },
        h('b', { style: { width: `${site.pages.length ? (done / site.pages.length) * 100 : 0}%` } })),
      running ? h('ul', { class: 'scan-pages' }, site.pages.map((p) => h('li', {}, icon(p), h('span', { class: 'scan-path', text: pathOf(p.url) })))) : null,
    ];
  }

  function resultView() {
    const s = summarizeScan(site.pages);
    if (!s.done) return [h('p', { class: 'view-empty', text: 'No pages could be audited. They may need a sign-in, or the site blocked the background tab.' })];
    const scan = { origin, ts: site.ts || Date.now(), pages: site.pages };
    const sharedRow = (x) => {
      const share = x.pages.length / s.done;
      return h('li', {},
        h('details', {},
          h('summary', {},
            h('span', { class: `scan-count${share >= 0.5 ? '' : ' scan-count-some'}`, text: `${x.pages.length}/${s.done}` }),
            h('span', { class: 'fix-text' },
              h('strong', { text: x.title }),
              h('span', { text: `${x.cat}${share >= 0.5 && s.done > 2 ? ' · likely a shared template' : ''}` }),
            ),
          ),
          h('ul', { class: 'scan-sub' }, x.pages.map((u) => h('li', {},
            h('button', { type: 'button', class: 'btn-link', onclick: () => openInTab(u) }, pathOf(u))))),
        ),
      );
    };
    return [
      h('div', { class: 'scan-summary' },
        h('div', { class: `score-num tone-${toneFor(s.avg)}` }, String(s.avg), h('small', { text: ' average' })),
        h('p', { class: 'muted', text: `Across ${s.done} pages. Lowest: ${pathOf(s.worst[0].result.url)} (${s.worst[0].result.score}).` }),
      ),
      h('h3', { class: 'scan-h', text: 'Problems shared across pages' }),
      s.shared.length ? h('ul', { class: 'scan-shared' }, s.shared.slice(0, 12).map(sharedRow)) : h('p', { class: 'view-empty', text: 'No problems on any page. Nice.' }),
      h('h3', { class: 'scan-h', text: 'Pages, lowest score first' }),
      h('ul', { class: 'scan-pages' }, s.worst.map((p) => h('li', {},
        h('span', { class: `scan-score tone-${toneFor(p.result.score)}`, text: String(p.result.score) }),
        h('button', { type: 'button', class: 'btn-link scan-path', title: 'Open this page in the current tab', onclick: () => openInTab(p.result.url) }, pathOf(p.result.url)),
      ))),
      monitorTile(),
      h('div', { class: 'test-actions' },
        s.shared.length ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => copyText(scanPrompt(scan), 'Prompt for the shared problems copied') }, 'Copy fix prompt') : null,
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => openBlob(scanHtml(scan), 'text/html') }, 'Open site report'),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => saveBlob(scanCsv(scan), 'text/csv', `agent-readiness-${host}.csv`) }, 'Download CSV'),
      ),
    ];
  }

  // Weekly re-scan of the same pages, run by the background worker; alerts if the site gets worse.
  function monitorTile() {
    const m = site.monitor;
    const on = !!(m && m.enabled);
    const next = on ? Math.max(0, Math.ceil(((m.lastRun || Date.now()) + MONITOR_EVERY_DAYS * 864e5 - Date.now()) / 864e5)) : 0;
    return h('div', { class: 'scan-monitor' },
      h('button', {
        type: 'button', class: `tool${on ? ' is-on' : ''}`, 'aria-pressed': String(on), onclick: toggleMonitor,
      },
      icon(TOOL_ICONS.rerun, 'tool-ico'),
      h('span', { class: 'tool-text' },
        h('strong', { text: on ? 'Weekly re-scan: on' : 'Re-scan every week' }),
        h('span', { text: on ? `Next in ${next === 1 ? '1 day' : `${next} days`}. ${m.alerts ? 'You’ll get an alert if the score drops.' : 'Alerts are off.'}` : 'Get an alert if the score drops or a new problem spreads' }),
      )),
    );
  }

  async function toggleMonitor() {
    if (site.monitor && site.monitor.enabled) {
      site.monitor = { ...site.monitor, enabled: false };
      await chrome.storage.local.set({ [monitorKey(origin)]: site.monitor });
      toast('Weekly re-scan turned off.');
      return draw();
    }
    let alerts = false;
    try { alerts = await chrome.permissions.request({ permissions: ['notifications'] }); } catch { alerts = false; }
    const urls = site.pages.filter((p) => p.result).map((p) => p.url);
    site.monitor = { origin, urls, enabled: true, alerts, lastRun: site.ts || Date.now(), every: MONITOR_EVERY_DAYS };
    await chrome.storage.local.set({ [monitorKey(origin)]: site.monitor });
    toast(alerts ? `These ${urls.length} pages will be re-scanned every week.` : 'Weekly re-scan is on. Allow notifications to get alerts.');
    draw();
  }

  function openInTab(url) {
    chrome.tabs.update(state.tabId, { url });
    toast('Opened in the current tab. Run the audit there for full details.');
  }

  async function startScan() {
    if (site.phase === 'running') return;
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [`${origin}/*`] }); } catch { granted = false; }
    if (!granted) return toast(`The scan needs access to ${host} to open its pages.`);

    site.phase = 'running';
    site.cancel = false;
    site.pages = [];
    draw();
    let links = [];
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: collectLinksInPage });
      links = (res && res.result && res.result.links) || [];
    } catch { /* fall back to the sitemap */ }
    let urls = site.source === 'auto' ? await sitemapUrls(origin) : [];
    if (urls.length < 3) urls = urls.concat(links);
    site.pages = pickPages(pageKey(r.url), [...new Set(urls)], site.size).map((url) => ({ url }));
    draw();

    await runScan({ origin, pages: site.pages, onChange: draw, isCancelled: () => site.cancel });
    site.phase = 'done';
    site.ts = Date.now();
    const pages = site.pages.map(({ url, result, error }) => ({ url, result, error }));
    site.saved = { ts: site.ts, pages };
    try { await chrome.storage.local.set({ [scanKey(origin)]: site.saved }); } catch { /* quota */ }
    draw();
  }

  if (site.saved === undefined) {
    site.saved = null;
    chrome.storage.local.get([scanKey(origin), monitorKey(origin)]).then((got) => {
      site.saved = got[scanKey(origin)] || null;
      site.monitor = got[monitorKey(origin)] || null;
      draw();
    }).catch(() => {});
  }
  draw();
  return box;
}

function openBlob(text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  chrome.tabs.create({ url }).catch(() => window.open(url, '_blank'));
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function saveBlob(text, type, name) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded');
}

'use strict';

// Site scan engine, shared by the side panel and the background service
// worker (for scheduled re-scans). Audits pages one at a time in a
// background tab and summarizes the problems they share. No DOM needed.

const SCAN_LOAD_TIMEOUT_MS = 25000;
const SCAN_SETTLE_MS = 1200;
const scanKey = (origin) => `sitescan:${origin}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialized and run inside the page. Same-site links worth auditing, in page order.
function collectLinksInPage() {
  const out = [];
  const seen = new Set();
  const files = /\.(pdf|jpe?g|png|gif|svg|webp|avif|zip|gz|mp4|mp3|mov|dmg|exe|docx?|xlsx?|pptx?|csv|xml|json|txt)$/i;
  const risky = /log-?out|sign-?out|delete|remove|unsubscribe|cart\/(add|clear|change)|\/api\/|\/admin|\/wp-admin|\/checkout/i;
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
    if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) continue;
    if (files.test(u.pathname) || risky.test(u.pathname + u.search)) continue;
    const key = u.pathname.replace(/\/$/, '') || '/';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.origin + u.pathname);
    if (out.length >= 400) break;
  }
  return { origin: location.origin, url: location.href.split('#')[0], links: out };
}

async function fetchTextFrom(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    return res.ok ? (await res.text()).slice(0, 3000000) : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** Page URLs from the site's sitemaps (robots.txt first, then /sitemap.xml), same origin only. */
async function sitemapUrls(origin) {
  const robots = await fetchTextFrom(`${origin}/robots.txt`);
  const queue = [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]).filter((u) => !/\.gz$/i.test(u)).slice(0, 3);
  if (!queue.length) queue.push(`${origin}/sitemap.xml`);
  const urls = [];
  for (let fetched = 0; queue.length && fetched < 6 && urls.length < 3000; fetched++) {
    const xml = await fetchTextFrom(queue.shift());
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs.filter((u) => !/\.gz$/i.test(u)).slice(0, 5));
    else urls.push(...locs);
  }
  return urls.filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } });
}

/** `n` pages starting with the current one, taken in turn from each top-level section so templates are covered. */
function pickPages(current, urls, n) {
  const groups = new Map();
  for (const u of urls) {
    if (u === current) continue;
    let section;
    try { section = new URL(u).pathname.split('/').filter(Boolean)[0] || ''; } catch { continue; }
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(u);
  }
  const out = [current];
  const lists = [...groups.values()];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < n && !out.includes(l[i])) out.push(l[i]);
  }
  return out;
}

/** Resolves when the tab finishes loading; rejects at once if the tab is closed. */
function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn(v);
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(resolve, 'ok'); };
    const onRemoved = (id) => { if (id === tabId) done(reject, new Error('The background tab was closed')); };
    const timer = setTimeout(() => done(resolve, 'timeout'), SCAN_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/** The parts of a report the site summary needs. */
function compactPage(rep) {
  return {
    url: rep.url,
    title: rep.title,
    score: rep.score,
    grade: rep.grade,
    cats: Object.fromEntries(rep.categories.filter((c) => c.scored !== false && c.score != null).map((c) => [c.name, c.score])),
    issues: rep.categories.flatMap((c) => c.checks
      .filter((k) => (k.status === 'fail' || k.status === 'warn') && c.scored !== false)
      .map((k) => ({ id: k.id, title: k.title, cat: c.name, status: k.status, n: k.issues, weight: k.weight, fix: k.fix }))),
  };
}

/** Average score, and every problem with the pages it appears on, most widespread first. */
function summarizeScan(pages) {
  const done = pages.filter((p) => p.result);
  const avg = done.length ? Math.round(done.reduce((a, p) => a + p.result.score, 0) / done.length) : 0;
  const byId = new Map();
  for (const p of done) {
    for (const i of p.result.issues) {
      if (!byId.has(i.id)) byId.set(i.id, { id: i.id, title: i.title, cat: i.cat, fix: i.fix, weight: i.weight, pages: [], total: 0, fails: 0 });
      const s = byId.get(i.id);
      s.pages.push(p.result.url);
      s.total += i.n || 1;
      if (i.status === 'fail') s.fails++;
    }
  }
  const shared = [...byId.values()].sort((a, b) => b.pages.length - a.pages.length || b.fails - a.fails || (b.weight || 0) - (a.weight || 0));
  return { avg, done: done.length, shared, worst: done.slice().sort((a, b) => a.result.score - b.result.score) };
}

const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search || '/'; } catch { return url; } };


/**
 * Audit `pages` ([{ url }], updated in place with `result` or `error`) of
 * `origin` in one background tab. `onChange` is called as each page starts
 * and ends; `isCancelled()` stops the scan between pages.
 */
async function runScan({ origin, pages, onChange = () => {}, isCancelled = () => false }) {
  let tab;
  const auditPage = async (url) => {
    // The background tab can disappear (closed by the person, or its page crashed): open a fresh one.
    try { await chrome.tabs.get(tab.id); } catch { tab = await chrome.tabs.create({ url: 'about:blank', active: false }); }
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loaded;
    await sleep(SCAN_SETTLE_MS);
    const now = await chrome.tabs.get(tab.id);
    if (now.url && new URL(now.url).origin !== origin) {
      const err = new Error('Went to another site (maybe a sign-in page)');
      err.final = true;
      throw err;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/auditor.js'] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (o) => window.__ARA.run(o), args: [{ siteScan: true }] });
    if (!res || !res.result) throw new Error('No result');
    return compactPage(res.result);
  };
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    for (const p of pages) {
      if (isCancelled()) break;
      p.running = true;
      onChange();
      for (let attempt = 0; attempt < 2 && !p.result && !isCancelled(); attempt++) {
        try {
          p.result = await auditPage(p.url);
          delete p.error;
        } catch (e) {
          p.error = String((e && e.message) || e).slice(0, 120);
          if (e && e.final) break; // retrying won't help
        }
      }
      p.running = false;
      onChange();
    }
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
  return pages;
}

/** What got worse between two scans of the same site: the average, and problems newly on most pages. */
function compareScans(prevPages, nextPages) {
  const a = summarizeScan(prevPages);
  const b = summarizeScan(nextPages);
  const widespread = (s, x) => s.done > 0 && x.pages.length / s.done >= 0.5;
  const newShared = b.shared.filter((x) => widespread(b, x) && !a.shared.some((y) => y.id === x.id && widespread(a, y)));
  const drop = a.avg - b.avg;
  return { before: a.avg, after: b.avg, drop, newShared, worse: (a.done > 0 && drop >= 3) || newShared.length > 0 };
}

const monitorKey = (origin) => `monitor:${origin}`;
const MONITOR_EVERY_DAYS = 7;

// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

// Runs the Agent-Readiness Auditor engine (the same one the Chrome extension
// injects) in a headless browser, for one page or a sample of a site.

const fs = require('fs');
const path = require('path');

/** The engine and scan helpers: packaged copies, or the extension's own files in a checkout. */
function enginePath(name, repoPath) {
  const packaged = path.join(__dirname, '..', 'engine', name);
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', '..', repoPath);
}
const ENGINE = fs.readFileSync(enginePath('auditor.js', 'content/auditor.js'), 'utf8');
const scan = require(enginePath('scan-core.js', 'lib/scan-core.js'));

async function launch() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error('Playwright is missing. Run: npm install playwright && npx playwright install chromium');
  }
  try {
    return await chromium.launch();
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/.test(String(e && e.message))) {
      throw new Error('Chromium isn’t installed for Playwright. Run: npx playwright install chromium');
    }
    throw e;
  }
}

/** Audit one URL and return the engine's JSON report. */
async function auditUrl(browser, url, { settleMs = 1500, siteScan = false, timeoutMs = 45000 } = {}) {
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForTimeout(settleMs);
    await page.evaluate(ENGINE);
    return await page.evaluate((opts) => window.__ARA.run(opts), { siteScan });
  } finally {
    await context.close();
  }
}

/** Pages to scan for a site: its sitemap, else the links on the start page, spread across sections. */
async function discoverPages(browser, startUrl, count) {
  const origin = new URL(startUrl).origin;
  let urls = await scan.sitemapUrls(origin);
  if (urls.length < 3) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(startUrl, { waitUntil: 'load', timeout: 45000 });
      const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
      urls = urls.concat(links.filter((u) => { try { return new URL(u).origin === location.origin; } catch { return false; } }).map((u) => u.split('#')[0]));
    } finally {
      await context.close();
    }
  }
  return scan.pickPages(startUrl.split('#')[0], [...new Set(urls)], count);
}

/** Audit up to `count` pages of the site; returns { origin, pages, summary }. */
async function scanSite(browser, startUrl, count = 10, onPage = () => {}) {
  const origin = new URL(startUrl).origin;
  const urls = await discoverPages(browser, startUrl, Math.min(Math.max(count, 1), 25));
  const pages = [];
  for (const url of urls) {
    try {
      const report = await auditUrl(browser, url, { siteScan: true });
      pages.push({ url, result: scan.compactPage(report) });
    } catch (e) {
      pages.push({ url, error: String((e && e.message) || e).split('\n')[0].slice(0, 160) });
    }
    onPage(pages[pages.length - 1], pages.length, urls.length);
  }
  return { origin, pages, summary: scan.summarizeScan(pages) };
}

module.exports = { launch, auditUrl, scanSite, pathOf: scan.pathOf };

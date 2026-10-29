// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

importScripts('sidepanel/i18n.js', 'lib/scan-core.js');

const SITE_URL = 'https://agent-readiness-auditor.netlify.app';
const MONITOR_ALARM = 'weekly-rescan';

// Clicking the toolbar icon opens the side panel. Clicking also grants
// one-time access (activeTab) to the page, which is all an audit needs.
function enablePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  enablePanelOnClick();
  ensureAlarm();
  // First install: show how to get a first result in under a minute.
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  // A short, optional "why did you leave?" form. Nothing is sent unless the person fills it in.
  chrome.runtime.setUninstallURL(`${SITE_URL}/goodbye.html`).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { enablePanelOnClick(); ensureAlarm(); });

// Saved reports and the score badge belong to one page load. Drop them when
// the tab navigates or closes.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  chrome.storage.session.remove(`report:${tabId}`);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`report:${tabId}`);
});

// ------------------------------------------------------- weekly re-scans
// Sites the person chose to monitor are re-scanned every week, using the
// same pages as their last scan. If the average score drops, or a new
// problem appears on most pages, an alert says so (if they allowed alerts).

function ensureAlarm() {
  chrome.alarms.get(MONITOR_ALARM).then((a) => {
    if (!a) chrome.alarms.create(MONITOR_ALARM, { delayInMinutes: 30, periodInMinutes: 360 });
  }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_ALARM) runDueMonitors();
});

let monitorsRunning = false;

/** Re-scan every monitored site that is due (or all of them with `force`). */
async function runDueMonitors(force = false) {
  if (monitorsRunning) return [];
  monitorsRunning = true;
  const done = [];
  try {
    const all = await chrome.storage.local.get(null);
    for (const [key, m] of Object.entries(all)) {
      if (!key.startsWith('monitor:') || !m || !m.enabled || !m.urls || !m.urls.length) continue;
      if (!force && Date.now() - (m.lastRun || 0) < (m.every || MONITOR_EVERY_DAYS) * 864e5) continue;
      if (!(await chrome.permissions.contains({ origins: [`${m.origin}/*`] }))) continue;
      const prev = all[scanKey(m.origin)];
      const pages = await runScan({ origin: m.origin, pages: m.urls.map((url) => ({ url })) });
      const saved = { ts: Date.now(), auto: true, pages: pages.map(({ url, result, error }) => ({ url, result, error })) };
      await chrome.storage.local.set({ [scanKey(m.origin)]: saved, [key]: { ...m, lastRun: saved.ts } });
      const change = prev ? compareScans(prev.pages, saved.pages) : null;
      if (change && change.worse && m.alerts) await alertRegression(m.origin, change);
      done.push({ origin: m.origin, change });
    }
  } finally {
    monitorsRunning = false;
  }
  return done;
}

async function alertRegression(origin, change) {
  if (!chrome.notifications || !(await chrome.permissions.contains({ permissions: ['notifications'] }))) return;
  const host = new URL(origin).host;
  const parts = [];
  if (change.drop >= 3) parts.push(t('Average score $1 → $2.', change.before, change.after));
  if (change.newShared.length) parts.push(t('New on most pages: $1.', change.newShared.slice(0, 2).map((x) => t(x.title)).join('; ')));
  try {
    await chrome.notifications.create(`rescan:${origin}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: t('Agent-readiness got worse on $1', host),
      message: parts.join(' '),
      contextMessage: t('Weekly re-scan · open the site and the Site scan tab for details'),
    });
  } catch (e) {
    console.warn('Couldn’t show the re-scan alert:', e);
  }
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith('rescan:')) return;
    chrome.tabs.create({ url: id.slice('rescan:'.length) });
    chrome.notifications.clear(id);
  });
}

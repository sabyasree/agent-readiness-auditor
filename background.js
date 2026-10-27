'use strict';

const SITE_URL = 'https://agent-readiness-auditor.netlify.app';

// Clicking the toolbar icon opens the side panel. Clicking also grants
// one-time access (activeTab) to the page, which is all an audit needs.
function enablePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  enablePanelOnClick();
  // First install: show how to get a first result in under a minute.
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  // A short, optional "why did you leave?" form. Nothing is sent unless the person fills it in.
  chrome.runtime.setUninstallURL(`${SITE_URL}/goodbye.html`).catch(() => {});
});
chrome.runtime.onStartup.addListener(enablePanelOnClick);

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

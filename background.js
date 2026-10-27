'use strict';

// Clicking the toolbar icon opens the side panel. Clicking also grants
// one-time access (activeTab) to the page, which is all an audit needs.
function enablePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);

// Saved reports belong to one page load. Drop them when the tab navigates or closes.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.storage.session.remove(`report:${tabId}`);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`report:${tabId}`);
});

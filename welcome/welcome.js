'use strict';

localizePage();
document.title = t('Welcome to Agent-Readiness Auditor');

// Show "Pinned ✓" as soon as the toolbar icon is pinned.
async function checkPinned() {
  try {
    const settings = await chrome.action.getUserSettings();
    document.getElementById('pinned').hidden = !settings.isOnToolbar;
    return settings.isOnToolbar;
  } catch {
    return false;
  }
}

checkPinned().then((pinned) => {
  if (pinned) return;
  const timer = setInterval(async () => { if (await checkPinned()) clearInterval(timer); }, 1500);
});

// Two jobs, both driven purely from chrome.storage because a service worker is
// terminated after a short idle period and keeps no state of its own:
//
// 1. Re-apply the stored host routes, so routing survives an extension reload, a
//    browser restart and a suspended worker. Chrome drops the PAC script
//    whenever the extension is unloaded, and the proxy loses its route table
//    whenever it is restarted, so both have to be set up again from storage.
// 2. Keep the toolbar icon in sync with what is actually in effect per tab.
import {
  DISABLED_DOMAINS_KEY,
  DISABLED_ROUTES_KEY,
  ENABLED_KEY,
  ROUTES_KEY,
  STORAGE_KEY,
} from './core/storage.js';
import { applyAll } from './core/apply.js';
import { refreshAllTabs, updateTabIcon } from './core/icon.js';

// Never rejects: it runs unsupervised from three places, and an unhandled rejection
// in a service worker is surfaced as an install error on the extension card.
async function restoreState() {
  try {
    const { enabled, proxyOk, proxyAsked } = await applyAll();
    await refreshAllTabs();

    console.log('[header-setter] state applied', {
      enabled,
      proxyReachable: proxyAsked ? proxyOk : 'no routes, not asked',
    });
  } catch (error) {
    console.warn('[header-setter] could not restore the stored state', error);
  }
}

chrome.runtime.onInstalled.addListener(restoreState);
chrome.runtime.onStartup.addListener(restoreState);

// Colour the icon for the tab that comes into view.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await updateTabIcon(await chrome.tabs.get(tabId));
  } catch {
    // Tab already gone.
  }
});

// A navigation can change the host without creating a new tab, so the icon has
// to follow the URL rather than the tab.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  if (tab.discarded) return;
  await updateTabIcon(tab);
});

// Editing a rule or a route, or flipping the master switch, changes the state of
// every open tab. The popup applies the change itself; this keeps the icons right
// when the popup is closed before its own work finishes.
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;
  const watched = [
    STORAGE_KEY,
    ROUTES_KEY,
    ENABLED_KEY,
    DISABLED_DOMAINS_KEY,
    DISABLED_ROUTES_KEY,
  ];
  if (!watched.some((key) => changes[key])) return;
  await refreshAllTabs();
});

restoreState();

// Toolbar icon state, three cases:
//   grey  — the master switch is off, nothing is in effect anywhere
//   green — the extension actually changes something for the tab in view
//   blue  — on, but this tab is untouched
// The icon is set per tab, so a window with one routed and one untouched tab
// shows both states correctly.
import { bareHost, hostFromUrl, withoutDisabled } from './domain.js';
import { buildRequestHeaders } from './rules.js';
import {
  getDisabledDomains,
  getDisabledRoutes,
  getDomainRules,
  getEnabled,
  getHostRoutes,
} from './storage.js';

const ICON_IDLE = {
  16: '/icons/icon16.png',
  48: '/icons/icon48.png',
  128: '/icons/icon128.png',
};

const ICON_ACTIVE = {
  16: '/icons/icon-active16.png',
  48: '/icons/icon-active48.png',
  128: '/icons/icon-active128.png',
};

const ICON_OFF = {
  16: '/icons/icon-off16.png',
  48: '/icons/icon-off48.png',
  128: '/icons/icon-off128.png',
};

// isActive mirrors what is really in effect: a domain rule counts only when it
// would produce a declarativeNetRequest rule (see buildRequestHeaders), and a
// route counts only on a host match, because that is what the PAC script compares.
// Matching happens on bare hosts on both sides — www.example.com and example.com are
// the same site — while a subdomain like shop.example.com stays untouched.
export function isActive(host, domainRules, routes) {
  if (!host) return false;

  const hasRule = domainRules.some(
    (group) => bareHost(group.domain?.toLowerCase() || '') === host
      && buildRequestHeaders(group).length > 0
  );

  return hasRule || Object.keys(routes).some((from) => bareHost(from.toLowerCase()) === host);
}

function iconState(enabled, active) {
  if (!enabled) return { path: ICON_OFF, title: 'Header Setter — disabled' };
  if (active) return { path: ICON_ACTIVE, title: 'Header Setter — active on this site' };
  return { path: ICON_IDLE, title: 'Header Setter' };
}

// A tab that is closed or discarded while its icon is being set is a normal race,
// not a failure. Chrome reports it through chrome.runtime.lastError, and for
// setIcon that happens only after the image has been loaded — so it can arrive
// after the promise has already resolved, where no try/catch can see it. Reading
// lastError inside the callback is what marks it as handled and keeps
// "Unchecked runtime.lastError: No tab with id" out of the console.
function callAction(method, details) {
  return new Promise((resolve) => {
    chrome.action[method](details, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// updateTabIcon reads the state from storage on every call instead of caching it,
// because the service worker is terminated after a short idle period.
export async function updateTabIcon(tab) {
  if (!tab?.id) return;

  const [enabled, storedRules, storedRoutes, disabledDomains, disabledRoutes] = await Promise.all([
    getEnabled(),
    getDomainRules(),
    getHostRoutes(),
    getDisabledDomains(),
    getDisabledRoutes(),
  ]);
  // A switched-off block or route changes nothing, so its host must not light the icon up.
  const { domainRules, routes } = withoutDisabled(storedRules, storedRoutes, {
    disabledDomains,
    disabledRoutes,
  });
  const active = isActive(hostFromUrl(tab.url), domainRules, routes);
  const { path, title } = iconState(enabled, active);

  await callAction('setIcon', { tabId: tab.id, path });
  await callAction('setTitle', { tabId: tab.id, title });
}

// refreshAllTabs is for state changes that affect every tab at once: a rule was
// added or removed in the popup, or the worker just started.
export async function refreshAllTabs() {
  const tabs = await chrome.tabs.query({});

  // A discarded tab — Chrome's memory saver unloads background tabs — still has an
  // id but no live page, so a per-tab icon cannot be attached to it at all. Chrome
  // reloads such a tab when it is activated, and onActivated sets the icon then.
  const live = tabs.filter((tab) => !tab.discarded && tab.status !== 'unloaded');

  await Promise.all(live.map((tab) => updateTabIcon(tab)));
}

// Exported so storage.onChanged listeners can name the same keys these setters write.
export const STORAGE_KEY = 'domainRules';
export const ROUTES_KEY = 'hostRoutes';
export const ENABLED_KEY = 'enabled';
export const DISABLED_DOMAINS_KEY = 'disabledDomains';
export const DISABLED_ROUTES_KEY = 'disabledRoutes';
export const PROXY_SEEN_KEY = 'proxySeen';

export const THEME_KEY = 'theme';

const DRAFT_KEY = 'formDraft';

export function getDomainRules() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] || []);
    });
  });
}

export function setDomainRules(domainRules) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: domainRules }, resolve);
  });
}

/** @returns {Promise<Object<string, string>>} host routes as a from/to map */
export function getHostRoutes() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ROUTES_KEY], (result) => {
      resolve(result[ROUTES_KEY] || {});
    });
  });
}

/** @param {Object<string, string>} routes */
export function setHostRoutes(routes) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ROUTES_KEY]: routes }, resolve);
  });
}

// The master switch. A fresh install has nothing stored, and an extension that
// does nothing after being installed would look broken, so absent means enabled.
/** @returns {Promise<boolean>} */
export function getEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ENABLED_KEY], (result) => {
      resolve(result[ENABLED_KEY] !== false);
    });
  });
}

/** @param {boolean} enabled */
export function setEnabled(enabled) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ENABLED_KEY]: enabled }, resolve);
  });
}

// The hosts switched off in their block. This is a list of its own rather than a flag
// inside domainRules, because a block that holds nothing but a route has no
// domainRules entry that could carry it.
/** @returns {Promise<string[]>} */
export function getDisabledDomains() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DISABLED_DOMAINS_KEY], (result) => {
      resolve(result[DISABLED_DOMAINS_KEY] || []);
    });
  });
}

/** @param {string[]} domains */
export function setDisabledDomains(domains) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DISABLED_DOMAINS_KEY]: domains }, resolve);
  });
}

// The from-hosts of the routes switched off in their row, by the same argument as
// disabledDomains: hostRoutes is a flat from/to map with no room for a flag.
/** @returns {Promise<string[]>} */
export function getDisabledRoutes() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DISABLED_ROUTES_KEY], (result) => {
      resolve(result[DISABLED_ROUTES_KEY] || []);
    });
  });
}

/** @param {string[]} froms */
export function setDisabledRoutes(froms) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DISABLED_ROUTES_KEY]: froms }, resolve);
  });
}

// Remembers that the proxy answered at least once on this machine. It is the only
// hint an extension can get about installation, see diagnoseProxy in routing.js.
/** @returns {Promise<boolean>} */
export function getProxySeen() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PROXY_SEEN_KEY], (result) => {
      resolve(result[PROXY_SEEN_KEY] === true);
    });
  });
}

export function setProxySeen() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PROXY_SEEN_KEY]: true }, resolve);
  });
}

// The popup is light until the user asks for dark, so anything unstored is light.
/** @returns {Promise<'light'|'dark'>} */
export function getTheme() {
  return new Promise((resolve) => {
    chrome.storage.local.get([THEME_KEY], (result) => {
      resolve(result[THEME_KEY] === 'dark' ? 'dark' : 'light');
    });
  });
}

/** @param {'light'|'dark'} theme */
export function setTheme(theme) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [THEME_KEY]: theme }, resolve);
  });
}

/** @returns {Promise<Object>} */
export function getDraft() {
  return new Promise((resolve) => {
    chrome.storage.session.get([DRAFT_KEY], (result) => {
      resolve(result[DRAFT_KEY] || {});
    });
  });
}

/** @param {Object} draft */
export function setDraft(draft) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ [DRAFT_KEY]: draft }, resolve);
  });
}

export function clearDraft() {
  return new Promise((resolve) => {
    chrome.storage.session.remove(DRAFT_KEY, resolve);
  });
}

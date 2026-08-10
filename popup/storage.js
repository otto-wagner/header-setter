const STORAGE_KEY = 'domainRules';
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

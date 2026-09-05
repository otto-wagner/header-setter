import { escapeRegex } from './domain.js';

// Exported so the toolbar icon can ask the same question Chrome does: an empty
// result means this domain currently modifies nothing, whatever is stored for it.
export function buildRequestHeaders(group) {
  const headerEntries = (group.headers || [])
    .filter((header) => header.enabled !== false)
    .map((header) => ({
      header: header.name,
      operation: 'set',
      value: header.value,
    }));

  const enabledCookies = (group.cookies || []).filter((cookie) => cookie.enabled !== false);
  const cookieEntry = enabledCookies.length > 0 ? [{
    header: 'Cookie',
    operation: 'set',
    value: enabledCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
  }] : [];

  return [...headerEntries, ...cookieEntry];
}

export function applyRules(domainRules) {
  return new Promise((resolve) => {
    chrome.declarativeNetRequest.getDynamicRules((existingRules) => {
      const oldIds = existingRules.map((rule) => rule.id);

      let nextId = 1;
      const newRules = domainRules
        .map((group) => ({ group, requestHeaders: buildRequestHeaders(group) }))
        // Chrome rejects modifyHeaders rules with an empty requestHeaders array,
        // so skip domains where every header/cookie is currently disabled.
        .filter(({ requestHeaders }) => requestHeaders.length > 0)
        .map(({ group, requestHeaders }) => ({
          id: nextId++,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders,
          },
          condition: {
            // The stored host and its www form, nothing else: no accidental
            // subdomain expansion, but example.com also covers www.example.com.
            regexFilter: `^https?://(www\\.)?${escapeRegex(group.domain)}([:/]|$)`,
            resourceTypes: [
              'main_frame', 'sub_frame', 'xmlhttprequest',
              'script', 'stylesheet', 'image', 'font', 'object', 'other',
            ],
          },
        }));

      chrome.declarativeNetRequest.updateDynamicRules(
        { removeRuleIds: oldIds, addRules: newRules },
        resolve
      );
    });
  });
}

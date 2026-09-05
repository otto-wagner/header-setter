// Single place that pushes the effective state to Chrome and to the proxy, so the
// popup and the service worker can never disagree about what is in effect.
//
// Disabled means really disabled: no dynamic declarativeNetRequest rules, no PAC
// script, and an empty table in the proxy. The stored rules and routes are left
// untouched, so switching back restores exactly what was there before.
import { applyRules } from './rules.js';
import { applyRoutes } from './routing.js';
import { withoutDisabled } from './domain.js';
import {
  getDisabledDomains,
  getDisabledRoutes,
  getDomainRules,
  getEnabled,
  getHostRoutes,
} from './storage.js';

/**
 * proxyAsked is false when there was nothing to push, so proxyOk says nothing
 * about the proxy in that case and must not be reported as "not reachable".
 * @returns {Promise<{enabled: boolean, proxyOk: boolean, proxyAsked: boolean}>}
 */
export async function applyAll() {
  const [enabled, storedRules, storedRoutes, disabledDomains, disabledRoutes] = await Promise.all([
    getEnabled(),
    getDomainRules(),
    getHostRoutes(),
    getDisabledDomains(),
    getDisabledRoutes(),
  ]);
  const { domainRules, routes } = withoutDisabled(storedRules, storedRoutes, {
    disabledDomains,
    disabledRoutes,
  });

  await applyRules(enabled ? domainRules : []);
  const { ok, skipped } = await applyRoutes(enabled ? routes : {});

  return { enabled, proxyOk: ok, proxyAsked: skipped !== true };
}

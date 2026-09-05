export function normalizeDomain(input) {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

/**
 * www is not a site of its own. Nobody means "example.com but not www.example.com",
 * and Chrome even hides the prefix in the address bar, so a rule typed without it
 * looked broken on the very page it was meant for. Both forms are therefore folded
 * onto the bare host: when a host is stored, when a tab is matched, and in the PAC.
 *
 * Only for hosts that are matched, never for a route target — that one is dialled, and
 * www.target.com and target.com can be two different servers.
 */
export function bareHost(host) {
  return host.replace(/^www\./, '');
}

/** normalizeDomain for a host that is matched, so www.example.com is stored as example.com. */
export function normalizeHost(input) {
  return bareHost(normalizeDomain(input));
}

// Both spellings of a routed host, so the PAC script and the proxy table cover
// www.example.com as well when the route was stored as example.com.
/** @param {Object<string, string>} routes @returns {Object<string, string>} */
export function withWwwAliases(routes) {
  const expanded = {};
  Object.entries(routes).forEach(([from, to]) => {
    const bare = bareHost(from);
    expanded[bare] = to;
    expanded[`www.${bare}`] = to;
  });
  return expanded;
}

// Returns the matchable host of a tab URL, or '' when there is nothing to match:
// a missing URL, or a scheme the rules cannot apply to anyway (chrome://,
// about:, file://, extension pages). www is stripped, see bareHost.
export function hostFromUrl(url) {
  if (!url) return '';

  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return bareHost(hostname.toLowerCase());
  } catch {
    return '';
  }
}

function lowerSet(values) {
  return new Set((values || []).map((value) => value.toLowerCase()));
}

/**
 * Drops everything that is switched off, so a disabled block or row is really disabled:
 * no header rule, no cookie, no route. Both stores are filtered in one place because a
 * disabled host suspends the whole block, not one of the two halves, and a disabled
 * route drops out on top of that.
 * @param {Array} domainRules
 * @param {Object<string, string>} routes
 * @param {{disabledDomains?: string[], disabledRoutes?: string[]}} off
 */
export function withoutDisabled(domainRules, routes, { disabledDomains, disabledRoutes } = {}) {
  const offHosts = lowerSet(disabledDomains);
  const offRoutes = lowerSet(disabledRoutes);
  if (offHosts.size === 0 && offRoutes.size === 0) return { domainRules, routes };

  return {
    domainRules: domainRules.filter((group) => !offHosts.has((group.domain || '').toLowerCase())),
    routes: Object.fromEntries(
      Object.entries(routes).filter(([from]) => {
        const host = from.toLowerCase();
        return !offHosts.has(host) && !offRoutes.has(host);
      })
    ),
  };
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

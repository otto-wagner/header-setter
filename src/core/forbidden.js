// Some request headers belong to the browser, not to an extension. Chrome accepts
// a declarativeNetRequest rule for them and then writes its own value anyway, so
// the rule looks saved while it changes nothing. MDN collects them as
// "forbidden request headers".
//
// Only headers that are genuinely out of reach are listed here. Referer, Origin,
// User-Agent and Cookie are on MDN's list because the fetch API refuses them, but
// declarativeNetRequest does modify them, so warning about those would be wrong.
export const MDN_FORBIDDEN_URL =
  'https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header';

export const HOST_HEADER = 'host';

// Owned by the network stack: it derives them from the connection, the body or the
// TLS state, after the rule has already been applied.
const BROWSER_CONTROLLED = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'date',
  'dnt',
  'expect',
  'keep-alive',
  'permissions-policy',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

// Whole namespaces the browser reserves for itself, e.g. Sec-Fetch-Mode.
const RESERVED_PREFIXES = ['proxy-', 'sec-'];

/**
 * @param {string} name
 * @returns {'host'|'browser-controlled'|'ok'} 'host' is the only case with a
 *   workaround, so it is reported separately from the merely futile ones.
 */
export function classifyHeader(name) {
  const header = name.trim().toLowerCase();
  if (!header) return 'ok';
  if (header === HOST_HEADER) return 'host';
  if (BROWSER_CONTROLLED.has(header)) return 'browser-controlled';
  if (RESERVED_PREFIXES.some((prefix) => header.startsWith(prefix))) return 'browser-controlled';
  return 'ok';
}

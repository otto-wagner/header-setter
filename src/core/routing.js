// Host routing: both engines forbid extensions to change the Host header and the
// TLS SNI, so a host can only be redirected on the connection level, through the
// local header-setter-proxy, which tunnels it to the target without touching a
// single byte. Chrome is pointed at the proxy with a PAC script; Firefox has no
// chrome.proxy.settings equivalent and instead calls a per-request listener
// (browser.proxy.onRequest), so it needs its own code path below.
import { withWwwAliases } from './domain.js';
import { getProxySeen, setProxySeen } from './storage.js';

// Firefox is the only engine that exposes browser.proxy.onRequest; Chrome/Chromium
// have no such event and rely on chrome.proxy.settings with a PAC script instead.
const isFirefox = typeof browser !== 'undefined' && !!browser.proxy?.onRequest;

export const PROXY_PORT = 8899;
export const ADMIN_PORT = 8900;

export const INSTALL_COMMAND = 'brew install otto-wagner/tap/header-setter-proxy';
export const START_COMMAND = 'header-setter-proxy serve';

// The proxy's own README: install, run, flags and troubleshooting. A popup has no
// room for any of that, so the notice links there instead of explaining it.
export const PROXY_README_URL =
  'https://github.com/otto-wagner/header-setter/blob/main/proxy/README.md#install';

const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`;

export function buildPacScript(hosts, port = PROXY_PORT) {
  return `function FindProxyForURL(url, host) {
  var routed = ${JSON.stringify(hosts)};
  host = host.toLowerCase();
  for (var i = 0; i < routed.length; i++) {
    if (host === routed[i]) return "PROXY 127.0.0.1:${port}";
  }
  return "DIRECT";
}`;
}

// Firefox has no static PAC hook, so the mapped hosts live in memory for
// firefoxProxyHandler to read on every request instead. The listener is
// registered once at module load — Firefox only keeps an event-page listener
// alive across a suspend if it is added at the top level, not from inside an
// async callback — and is a no-op on Chrome, where it is never registered.
// A cold wake races the listener (present immediately) against restoreState()
// repopulating this cache (async): a request landing in that window falls
// through to "direct", same as Chrome's PAC script needing to be re-applied
// after Chrome drops it on unload (see background.js). Both engines share the
// same accepted limitation, not a Firefox-only gap.
let firefoxRouteCache;

function firefoxProxyHandler(requestInfo) {
  const host = new URL(requestInfo.url).hostname.toLowerCase();
  if (firefoxRouteCache && Object.prototype.hasOwnProperty.call(firefoxRouteCache, host)) {
    return { type: 'http', host: '127.0.0.1', port: PROXY_PORT };
  }
  return { type: 'direct' };
}

if (isFirefox) {
  browser.proxy.onRequest.addListener(firefoxProxyHandler, { urls: ['<all_urls>'] });
}

// applyPac points the browser at the local proxy for the mapped hosts only.
// Without routes the routing is released again, so neither engine keeps
// reporting that the extension controls the connection.
export async function applyPac(routes) {
  if (isFirefox) {
    firefoxRouteCache = routes;
    return;
  }

  const hosts = Object.keys(routes);
  if (hosts.length === 0) {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return;
  }

  await chrome.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: buildPacScript(hosts) } },
    scope: 'regular',
  });
}

// pushRoutes hands the whole table to the proxy. A missing proxy is a normal
// state, not a failure: the PAC is set either way and starts working as soon as
// the proxy runs.
export async function pushRoutes(routes) {
  const isEmpty = Object.keys(routes).length === 0;

  // An empty table on a proxy that has never answered is already the desired
  // state, so there is nothing to clear and no reason to reach out. Without this,
  // a fresh install that only uses headers logs a failed request on every single
  // rule change, which reads like a broken extension.
  if (isEmpty && !(await getProxySeen())) return { ok: false, skipped: true };

  try {
    const response = await fetch(`${ADMIN_URL}/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(routes),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await setProxySeen();
    return { ok: true };
  } catch (error) {
    // An absent proxy is an expected state, never an error: the PAC script is set
    // either way and routing starts the moment the proxy runs. The popup shows the
    // status and the start command, which is where the user can act on it. So this
    // stays at debug level — console.warn and console.error are collected into the
    // extension's error list in chrome://extensions, where it would look like a
    // defect in the extension.
    console.debug('[header-setter] proxy did not take the routes', {
      url: `${ADMIN_URL}/routes`,
      routes: Object.keys(routes).length,
      reason: error.message,
    });
    return { ok: false };
  }
}

// The health payload carries why a routed host could not be reached, keyed by the
// host as the proxy received it. Chrome shows a bare ERR_TUNNEL_CONNECTION_FAILED
// for such a route, so this is the only place the reason can come from.
/** @returns {Promise<{ok: boolean, failures: Record<string, {kind: string, target: string, message: string}>}>} */
export async function checkProxy() {
  try {
    const response = await fetch(`${ADMIN_URL}/health`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    return { ok: true, failures: health.failures ?? {} };
  } catch {
    return { ok: false, failures: {} };
  }
}

// Both host forms are handed on: the PAC script compares the host exactly and the
// proxy looks the route up in an exact map, so www.example.com would go DIRECT if only
// example.com were listed. The target stays as it was typed — it is dialled, not matched.
export async function applyRoutes(routes) {
  const withAliases = withWwwAliases(routes);
  await applyPac(withAliases);
  return pushRoutes(withAliases);
}

// An extension cannot read the file system or ask Homebrew, so "is the proxy
// installed?" has no honest answer. What can be answered is whether it ever replied
// on this machine, and that separates the two situations that need different advice:
// never seen means it most likely still has to be installed, seen before means it is
// most likely installed but not running. Both are guesses, so the UI offers the
// install command and the start command together and only leads with the likelier one.
/** @returns {Promise<{ok: boolean, reason?: 'stopped'|'missing', failures: Record<string, {kind: string, target: string, message: string}>}>} */
export async function diagnoseProxy() {
  const { ok, failures } = await checkProxy();
  if (ok) {
    await setProxySeen();
    return { ok: true, failures };
  }

  return { ok: false, reason: (await getProxySeen()) ? 'stopped' : 'missing', failures: {} };
}

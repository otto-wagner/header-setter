import {
  getDomainRules,
  setDomainRules,
  getHostRoutes,
  setHostRoutes,
  getEnabled,
  setEnabled,
  getDisabledDomains,
  setDisabledDomains,
  getDisabledRoutes,
  setDisabledRoutes,
  getTheme,
  setTheme,
  getDraft,
  setDraft,
} from '../core/storage.js';
import { normalizeDomain, normalizeHost, hostFromUrl } from '../core/domain.js';
import { applyAll } from '../core/apply.js';
import { diagnoseProxy } from '../core/routing.js';
import { classifyHeader } from '../core/forbidden.js';
import {
  renderGroups,
  renderHeaderNotice,
  renderProxyBanner,
  setProxyStatus,
  showError,
} from './view.js';

const els = {
  composer: document.getElementById('composer'),
  typeInputs: [...document.querySelectorAll('input[name="entryType"]')],
  routeFields: document.getElementById('routeFields'),
  domain: document.getElementById('domain'),
  useCurrentSite: document.getElementById('useCurrentSite'),
  cancelPairEdit: document.getElementById('cancelPairEdit'),
  entryName: document.getElementById('entryName'),
  entryValue: document.getElementById('entryValue'),
  nameLabel: document.getElementById('nameLabel'),
  valueLabel: document.getElementById('valueLabel'),
  routeFrom: document.getElementById('routeFrom'),
  routeTo: document.getElementById('routeTo'),
  useCurrentRoute: document.getElementById('useCurrentRoute'),
  cancelRouteEdit: document.getElementById('cancelRouteEdit'),
  submitBtn: document.getElementById('submitBtn'),
  headerNotice: document.getElementById('headerNotice'),
  formError: document.getElementById('formError'),
  groups: document.getElementById('groups'),
  emptyState: document.getElementById('emptyState'),
  proxyStatus: document.getElementById('proxyStatus'),
  proxyBanner: document.getElementById('proxyBanner'),
  enabledToggle: document.getElementById('enabledToggle'),
  enabledLabel: document.getElementById('enabledLabel'),
  themeToggle: document.getElementById('themeToggle'),
};

// The pair fields serve headers and cookies. The labels and placeholders are the only
// things that differ, so they live in one table instead of two separate forms. The
// proxy fields below them belong to no type at all and only appear where they are the
// answer, see renderRouteFields.
const TYPES = {
  header: {
    name: 'Header name',
    value: 'Header value',
    namePlaceholder: 'e.g. User-Agent',
    valuePlaceholder: 'e.g. Mozilla/5.0 (Windows NT 10.0; Win64; x64) App...',
  },
  cookie: {
    name: 'Cookie name',
    value: 'Cookie value',
    namePlaceholder: 'e.g. user_session',
    valuePlaceholder: 'e.g. abc123',
  },
};

const DRAFT_FIELDS = ['domain', 'entryName', 'entryValue', 'routeFrom', 'routeTo'];

// What is stored, mirrored here so a render pass does not have to read it back.
let state = { domainRules: [], routes: {}, disabledDomains: [], disabledRoutes: [] };

// Which entry the composer is currently rewriting, if any. `pair` and `route` are
// independent because both blocks are on screen at the same time.
/** @type {{pair: {type: string, domain: string, name: string}|null, route: {from: string}|null}} */
let editing = { pair: null, route: null };

function currentType() {
  return els.typeInputs.find((input) => input.checked)?.value || 'header';
}

function sameName(one, other) {
  return one.toLowerCase() === other.toLowerCase();
}

function readDraftFromForm() {
  const draft = { entryType: currentType(), editing };
  DRAFT_FIELDS.forEach((field) => {
    draft[field] = els[field].value;
  });
  return draft;
}

function applyDraftToForm(draft) {
  DRAFT_FIELDS.forEach((field) => {
    if (draft[field]) els[field].value = draft[field];
  });
  if (draft.editing) editing = { pair: null, route: null, ...draft.editing };
  if (draft.entryType && TYPES[draft.entryType]) selectType(draft.entryType);
}

async function persistDraft() {
  await setDraft(readDraftFromForm());
}

function selectType(type) {
  els.typeInputs.forEach((input) => { input.checked = input.value === type; });
  renderType();
}

function renderType() {
  const config = TYPES[currentType()];

  els.nameLabel.textContent = config.name;
  els.valueLabel.textContent = config.value;
  els.entryName.placeholder = config.namePlaceholder;
  els.entryValue.placeholder = config.valuePlaceholder;

  renderEditState();
  showError(els, '');
  refreshHeaderNotice();
}

// One button for both blocks, so it says what a click does rather than which of the
// two blocks it means: both are submitted at once anyway.
function renderEditState() {
  els.cancelPairEdit.hidden = editing.pair === null;
  els.cancelRouteEdit.hidden = editing.route === null;
  els.submitBtn.textContent = editing.pair || editing.route ? 'Save changes' : 'Add';
}

/**
 * A Host header name is not an entry, it is the question the proxy answers: no rule
 * for it can ever take effect, so it only switches the proxy fields on.
 */
function isHostAttempt() {
  return currentType() === 'header' && classifyHeader(els.entryName.value) === 'host';
}

// The notice is the only place that tells a user why a Host rule cannot work, so it
// updates while typing rather than waiting for a failed submit.
function refreshHeaderNotice() {
  const name = els.entryName.value.trim();
  const level = currentType() === 'header' ? classifyHeader(name) : 'ok';

  renderHeaderNotice(els, level === 'ok' ? null : { level, name });
  renderHostValue(level === 'host');
  renderRouteFields();
  updateProxyVisibility();
}

// A Host name carries no value of its own: the target is the route's, further down.
// So the field is greyed out and filled with a dash rather than left open for an
// entry that could never be saved.
const HOST_VALUE = '-';

// What stood in the field before the dash took its place, so switching the name back
// to a real header does not silently eat what was typed.
let valueBeforeHost = null;

function renderHostValue(host) {
  if (host) {
    if (valueBeforeHost === null && els.entryValue.value !== HOST_VALUE) {
      valueBeforeHost = els.entryValue.value;
    }
    els.entryValue.value = HOST_VALUE;
  } else {
    if (els.entryValue.value === HOST_VALUE) els.entryValue.value = valueBeforeHost || '';
    valueBeforeHost = null;
  }
  els.entryValue.disabled = host;
}

// A proxy route answers exactly one question: a Host header that no extension can
// set. So the fields stay out of the way until that question comes up — while a Host
// rule is being typed, while a stored route is being edited, or while something is
// still standing in them.
function renderRouteFields() {
  els.routeFields.hidden = !(isHostAttempt()
    || editing.route !== null
    || els.routeFrom.value.trim() !== ''
    || els.routeTo.value.trim() !== '');
}

// Both stores are read again inside the mutation instead of writing the mirrored
// state back: another popup or the service worker may have changed them meanwhile.
async function withDomainRules(mutate) {
  const domainRules = await getDomainRules();
  mutate(domainRules);
  await setDomainRules(domainRules);
  const disabledDomains = await pruneDisabledDomains(domainRules, state.routes);
  await applyAll();
  state = { ...state, domainRules, disabledDomains };
  render();
}

async function withRoutes(mutate) {
  const routes = await getHostRoutes();
  mutate(routes);
  await setHostRoutes(routes);
  const disabledDomains = await pruneDisabledDomains(state.domainRules, routes);
  const disabledRoutes = await pruneDisabledRoutes(routes);
  state = { ...state, routes, disabledDomains, disabledRoutes };
  render();
  await refreshProxy();
}

// A block is switched off by host, and the flag outlives the entries it belongs to.
// Once the last entry and the route of a host are gone, the flag has to go with them:
// otherwise the next rule added for that host would be created switched off, with
// nothing on screen explaining why.
async function pruneDisabledDomains(domainRules, routes) {
  const disabledDomains = await getDisabledDomains();
  const known = new Set([
    ...domainRules.map((group) => group.domain),
    ...Object.keys(routes),
  ]);
  const kept = disabledDomains.filter((domain) => known.has(domain));

  if (kept.length !== disabledDomains.length) await setDisabledDomains(kept);
  return kept;
}

// Same reason as for a host: a flag for a route that is gone would switch off the next
// route created for that host, for no visible reason.
async function pruneDisabledRoutes(routes) {
  const disabledRoutes = await getDisabledRoutes();
  const kept = disabledRoutes.filter((from) => routes[from] !== undefined);

  if (kept.length !== disabledRoutes.length) await setDisabledRoutes(kept);
  return kept;
}

// Suspends everything the host carries — headers, cookies and its route — without
// deleting any of it, the same trade the master switch makes for the whole extension.
async function toggleDomain(domain) {
  const disabledDomains = await getDisabledDomains();
  const off = disabledDomains.includes(domain);
  const next = off
    ? disabledDomains.filter((entry) => entry !== domain)
    : [...disabledDomains, domain];

  await setDisabledDomains(next);
  state = { ...state, disabledDomains: next };
  render();
  await refreshProxy();
}

// Takes the route out of the PAC script and the proxy table while leaving it stored,
// so a host can keep its headers and cookies while the detour is off.
async function toggleRoute(from) {
  const disabledRoutes = await getDisabledRoutes();
  const off = disabledRoutes.includes(from);
  const next = off
    ? disabledRoutes.filter((entry) => entry !== from)
    : [...disabledRoutes, from];

  await setDisabledRoutes(next);
  state = { ...state, disabledRoutes: next };
  render();
  await refreshProxy();
}

function findGroup(domainRules, domain) {
  return domainRules.find((group) => group.domain === domain);
}

function getOrCreateGroup(domainRules, domain) {
  let group = findGroup(domainRules, domain);
  if (!group) {
    group = { domain, headers: [], cookies: [] };
    domainRules.push(group);
  }
  group.headers = group.headers || [];
  group.cookies = group.cookies || [];
  return group;
}

function entryList(group, type) {
  return type === 'cookie' ? group.cookies : group.headers;
}

// A group without a single entry has nothing left to show, and its route lives in
// the route table rather than here, so it is dropped instead of rendered empty.
function pruneEmptyGroups(domainRules) {
  for (let index = domainRules.length - 1; index >= 0; index -= 1) {
    const group = domainRules[index];
    if ((group.headers || []).length === 0 && (group.cookies || []).length === 0) {
      domainRules.splice(index, 1);
    }
  }
}

function removeEntry(domainRules, type, domain, name) {
  const group = findGroup(domainRules, domain);
  if (!group) return;
  const list = entryList(group, type);
  const index = list.findIndex((entry) => sameName(entry.name, name));
  if (index >= 0) list.splice(index, 1);
}

/**
 * What the pair block currently holds. It only counts as filled in when a name or a
 * value is there: the domain is pre-filled with the current site, so it alone would
 * turn every route-only submit into a complaint about a missing header name. A Host
 * name never counts, because it is the trigger for the proxy fields rather than an
 * entry that could be saved.
 */
function readPair() {
  const pair = {
    type: currentType(),
    domain: normalizeHost(els.domain.value),
    name: els.entryName.value.trim(),
    value: els.entryValue.value.trim(),
  };
  return {
    ...pair,
    wanted: !isHostAttempt() && (pair.name !== '' || pair.value !== ''),
  };
}

function readRoute() {
  const route = {
    // from is matched, so it is folded onto the bare host; to is dialled and stays
    // as it was typed, because www.target.com can be a different server.
    from: normalizeHost(els.routeFrom.value),
    to: normalizeDomain(els.routeTo.value),
  };
  return { ...route, wanted: route.from !== '' || route.to !== '' };
}

function pairProblem({ type, domain, name, value }) {
  const label = type === 'cookie' ? 'cookie' : 'header';
  if (!domain || !name || !value) {
    return `Please fill in domain, ${label} name, and ${label} value.`;
  }
  if (type === 'cookie' && (name.includes(';') || value.includes(';'))) {
    return 'A cookie name or value cannot contain a semicolon.';
  }
  return '';
}

function routeProblem({ from, to }) {
  if (!from || !to) return 'Please fill in both the host the browser opens and its target.';
  if (from === to) return 'Both proxy hosts are identical, so there is nothing to route.';
  return '';
}

// One button creates everything that is filled in, so a host that needs a header and
// a route is one submit rather than two. Everything is validated before anything is
// written: a broken half must not leave the other half applied.
async function submitComposer(event) {
  event.preventDefault();
  showError(els, '');

  const hostAttempt = isHostAttempt();
  const pair = readPair();
  const route = readRoute();
  if (!pair.wanted && !route.wanted) {
    showError(els, hostAttempt
      ? `${pair.name} cannot be set by an extension. Fill in the proxy route instead.`
      : `Please fill in a ${currentType()} or a proxy route.`);
    return;
  }

  const problem = (pair.wanted && pairProblem(pair)) || (route.wanted && routeProblem(route));
  if (problem) {
    showError(els, problem);
    refreshHeaderNotice();
    return;
  }

  if (pair.wanted) await savePair(pair);
  if (route.wanted) await saveRoute(route);
  // The Host name was only the way to the proxy fields, so it goes once the route is
  // stored instead of sitting there as a rule that was never saved.
  if (hostAttempt) await clearPairInputs();
}

async function savePair({ type, domain, name, value }) {
  // Renaming while editing has to drop the entry that was loaded, otherwise the old
  // name stays behind next to the new one.
  const previous = editing.pair;
  const moved = previous !== null
    && !(previous.type === type && previous.domain === domain && sameName(previous.name, name));

  await withDomainRules((domainRules) => {
    if (moved) {
      removeEntry(domainRules, previous.type, previous.domain, previous.name);
      pruneEmptyGroups(domainRules);
    }
    const list = entryList(getOrCreateGroup(domainRules, domain), type);
    const existing = list.find((entry) => sameName(entry.name, name));
    if (existing) existing.value = value;
    else list.push({ name, value });
  });

  editing = { ...editing, pair: null };
  await clearPairInputs();
}

async function saveRoute({ from, to }) {
  const previous = editing.route;
  const renamed = previous !== null && previous.from !== from ? previous.from : '';

  await withRoutes((routes) => {
    if (renamed) delete routes[renamed];
    routes[from] = to;
  });

  editing = { ...editing, route: null };
  await clearRouteInputs();
}

async function clearPairInputs() {
  els.entryName.value = '';
  els.entryValue.value = '';
  els.entryName.focus();
  renderEditState();
  refreshHeaderNotice();
  await persistDraft();
}

async function clearRouteInputs() {
  els.routeFrom.value = '';
  els.routeTo.value = '';
  renderEditState();
  renderRouteFields();
  updateProxyVisibility();
  await persistDraft();
}

async function cancelPairEdit() {
  editing = { ...editing, pair: null };
  await clearPairInputs();
}

async function cancelRouteEdit() {
  editing = { ...editing, route: null };
  await clearRouteInputs();
}

// Editing loads the entry back into the composer. The entry itself stays until the
// change is submitted, so an abandoned edit changes nothing.
async function editPair(type, domain, entry) {
  selectType(type);
  els.domain.value = domain;
  els.entryName.value = entry.name;
  els.entryValue.value = entry.value;
  // Only one thing is edited at a time. A proxy edit that was still open is dropped
  // and its fields are emptied, so "Save changes" can only mean this entry.
  editing = { pair: { type, domain, name: entry.name }, route: null };
  els.routeFrom.value = '';
  els.routeTo.value = '';
  renderEditState();
  refreshHeaderNotice();
  els.entryValue.focus();
  await persistDraft();
}

const editHeader = (domain, header) => editPair('header', domain, header);
const editCookie = (domain, cookie) => editPair('cookie', domain, cookie);

// A route is the answer to a Host header, so editing one names that header above the
// fields: Host, with the greyed-out dash for a value. That is also what the composer
// looks like on the way in, when a Host name opened the route fields in the first
// place. Any pair edit is dropped, because its fields are what the stand-in takes.
async function editRoute(route) {
  selectType('header');
  els.entryName.value = 'Host';
  // Whatever stood in the value field belonged to some other header and has nothing
  // to do with the route, so it is dropped rather than kept and handed back later.
  els.entryValue.value = '';
  valueBeforeHost = null;
  els.routeFrom.value = route.from;
  els.routeTo.value = route.to;
  editing = { pair: null, route: { from: route.from } };
  renderEditState();
  refreshHeaderNotice();
  els.routeTo.focus();
  await persistDraft();
}

function removeHeader(domain, name) {
  return withDomainRules((domainRules) => {
    removeEntry(domainRules, 'header', domain, name);
    pruneEmptyGroups(domainRules);
  });
}

function removeCookie(domain, name) {
  return withDomainRules((domainRules) => {
    removeEntry(domainRules, 'cookie', domain, name);
    pruneEmptyGroups(domainRules);
  });
}

function toggleHeader(domain, name) {
  return toggleEntry('header', domain, name);
}

function toggleCookie(domain, name) {
  return toggleEntry('cookie', domain, name);
}

function toggleEntry(type, domain, name) {
  return withDomainRules((domainRules) => {
    const group = findGroup(domainRules, domain);
    if (!group) return;
    const entry = entryList(group, type).find((item) => sameName(item.name, name));
    if (entry) entry.enabled = entry.enabled === false;
  });
}

// The block carries everything that applies to the host, so removing it removes the
// route that starts there as well.
async function removeDomain(domain) {
  await withDomainRules((domainRules) => {
    const index = domainRules.findIndex((group) => group.domain === domain);
    if (index >= 0) domainRules.splice(index, 1);
  });
  if (state.routes[domain] !== undefined) await removeRoute(domain);
}

function removeRoute(from) {
  return withRoutes((routes) => { delete routes[from]; });
}

/**
 * One block per host: its headers, its cookies and the route that starts at it. A
 * route whose host has no rules gets a block of its own, appended in host order.
 */
function buildGroups(domainRules, routes, disabledDomains, disabledRoutes, failures) {
  const off = new Set(disabledDomains);
  const offRoutes = new Set(disabledRoutes);
  // The proxy keys a failure by the host the browser asked for, which is the www
  // spelling for a route stored bare, because both are pushed to the proxy.
  const failureFor = (from) => failures[from] || failures[`www.${from}`];
  const routeFor = (from) => (routes[from] === undefined
    ? null
    : {
      from,
      to: routes[from],
      enabled: !offRoutes.has(from),
      failure: offRoutes.has(from) ? undefined : failureFor(from),
    });

  const groups = domainRules.map((group) => ({
    domain: group.domain,
    enabled: !off.has(group.domain),
    headers: group.headers || [],
    cookies: group.cookies || [],
    route: routeFor(group.domain),
  }));

  const listed = new Set(groups.map((group) => group.domain));
  Object.keys(routes)
    .filter((from) => !listed.has(from))
    .sort()
    .forEach((from) => groups.push({
      domain: from,
      enabled: !off.has(from),
      headers: [],
      cookies: [],
      route: routeFor(from),
    }));

  return groups;
}

function render() {
  const groups = buildGroups(
    state.domainRules,
    state.routes,
    state.disabledDomains,
    state.disabledRoutes,
    proxyState.failures
  );
  renderGroups(els, groups, {
    removeHeader,
    removeCookie,
    removeDomain,
    removeRoute,
    toggleHeader,
    toggleCookie,
    toggleDomain,
    toggleRoute,
    editHeader,
    editCookie,
    editRoute,
  });
  updateProxyVisibility();
}

let proxyState = { ok: false, reason: undefined, checked: false, failures: {} };

// Routes exist, the proxy fields are being filled in, or a Host header just sent the
// user that way. Someone who only sets headers has no proxy, so they are told neither
// its status nor how to install it.
function proxyNeeded() {
  return Object.keys(state.routes).length > 0
    || els.routeFrom.value.trim() !== ''
    || els.routeTo.value.trim() !== ''
    || !els.headerNotice.hidden;
}

function updateProxyVisibility() {
  const needed = proxyNeeded();
  els.proxyStatus.hidden = !needed;
  const show = needed && proxyState.checked && !proxyState.ok;
  renderProxyBanner(els, show ? { reason: proxyState.reason } : null, { recheck: refreshProxy });
}

// The proxy starts with an empty route table, so pushing the whole table again also
// repairs the case where it was started after Chrome.
async function refreshProxy() {
  setProxyStatus(els, 'checking');
  await applyAll();
  const result = await diagnoseProxy();
  proxyState = { ...result, checked: true };
  setProxyStatus(els, result.ok ? 'ok' : 'down');
  // A route that just started failing, or stopped failing, only shows up when the
  // rows are drawn again.
  render();
}

function renderEnabled(enabled) {
  els.enabledToggle.checked = enabled;
  els.enabledLabel.textContent = enabled ? 'On' : 'Off';
  els.enabledLabel.classList.toggle('off', !enabled);
  document.body.classList.toggle('extension-disabled', !enabled);
}

// Turning the switch off tears down the dynamic rules and the PAC script and
// empties the proxy table, so nothing keeps running behind a grey icon.
async function toggleEnabled() {
  const enabled = els.enabledToggle.checked;
  await setEnabled(enabled);
  renderEnabled(enabled);
  await refreshProxy();
}

// One button for both directions: it shows the scheme a click leads to, so the moon
// stands in the light popup and the sun in the dark one.
/** @param {'light'|'dark'} theme */
function renderTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  els.themeToggle.classList.toggle('is-dark', dark);
  els.themeToggle.title = dark ? 'Light mode' : 'Dark mode';
  els.themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}

async function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  renderTheme(theme);
  await setTheme(theme);
}

// Offers the host of the tab the popup was opened from, because "add a header for
// the site I am looking at" is the common case. Reading tab.url needs either the
// tabs permission or a matching host permission; when neither applies the URL is
// undefined and the shortcuts simply stay hidden.
async function setupCurrentSite() {
  let host = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = hostFromUrl(tab?.url);
  } catch {
    host = '';
  }
  if (!host) return;

  els.useCurrentSite.textContent = `Use ${host}`;
  els.useCurrentSite.hidden = false;
  els.useCurrentSite.addEventListener('click', async () => {
    els.domain.value = host;
    els.entryName.focus();
    await persistDraft();
  });

  // The route source is never filled in by itself: a host in there means "send this
  // one somewhere else", which is a decision, not a default.
  els.useCurrentRoute.textContent = `Use ${host}`;
  els.useCurrentRoute.hidden = false;
  els.useCurrentRoute.addEventListener('click', async () => {
    els.routeFrom.value = host;
    els.routeTo.focus();
    updateProxyVisibility();
    await persistDraft();
  });

  if (!els.domain.value) els.domain.value = host;
}

async function init() {
  const [
    domainRules, routes, disabledDomains, disabledRoutes, enabled, theme, draft,
  ] = await Promise.all([
    getDomainRules(),
    getHostRoutes(),
    getDisabledDomains(),
    getDisabledRoutes(),
    getEnabled(),
    getTheme(),
    getDraft(),
  ]);
  // First, so a stored dark theme is in place before anything else is rendered.
  renderTheme(theme);
  state = { domainRules, routes, disabledDomains, disabledRoutes };
  applyDraftToForm(draft);
  renderRouteFields();
  renderEnabled(enabled);
  render();
  await setupCurrentSite();
  await refreshProxy();
}

els.composer.addEventListener('submit', submitComposer);
els.typeInputs.forEach((input) => input.addEventListener('change', async () => {
  renderType();
  await persistDraft();
}));
els.entryName.addEventListener('input', refreshHeaderNotice);
els.routeFrom.addEventListener('input', updateProxyVisibility);
els.routeTo.addEventListener('input', updateProxyVisibility);
els.cancelPairEdit.addEventListener('click', cancelPairEdit);
els.cancelRouteEdit.addEventListener('click', cancelRouteEdit);
DRAFT_FIELDS.forEach((field) => els[field].addEventListener('input', persistDraft));
els.enabledToggle.addEventListener('change', toggleEnabled);
els.themeToggle.addEventListener('click', toggleTheme);
renderType();
init();

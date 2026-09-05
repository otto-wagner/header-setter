import { MDN_FORBIDDEN_URL } from '../core/forbidden.js';
import { ADMIN_PORT, INSTALL_COMMAND, PROXY_README_URL, START_COMMAND } from '../core/routing.js';

export function showError(els, message) {
  els.formError.textContent = message;
  els.formError.hidden = !message;
}

const PROXY_STATUS_TEXT = {
  checking: 'Checking proxy…',
  ok: 'Proxy reachable',
  down: 'Proxy not reachable',
};

/** @param {'checking'|'ok'|'down'} state */
export function setProxyStatus(els, state) {
  els.proxyStatus.className = `proxy-status ${state}`;
  els.proxyStatus.textContent = PROXY_STATUS_TEXT[state];
}

function code(text) {
  const el = document.createElement('code');
  el.textContent = text;
  return el;
}

function externalLink(href, text) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  return link;
}

// A command the user has to run in a terminal, with a copy button, because typing a
// Homebrew tap path by hand from a popup is where this otherwise fails.
function commandRow(command) {
  const row = document.createElement('div');
  row.className = 'command-row';

  const pre = document.createElement('code');
  pre.className = 'command';
  pre.textContent = command;
  row.appendChild(pre);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'link-btn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } catch {
      copy.textContent = 'Press ⌘C';
    }
  });
  row.appendChild(copy);

  return row;
}

/**
 * The yellow notice under the header fields.
 * @param {{level: 'host'|'browser-controlled', name: string}|null} notice
 */
export function renderHeaderNotice(els, notice) {
  els.headerNotice.replaceChildren();
  els.headerNotice.hidden = !notice;
  if (!notice) return;

  const text = document.createElement('p');
  text.appendChild(code(notice.name));
  text.appendChild(document.createTextNode(' is a '));
  text.appendChild(externalLink(MDN_FORBIDDEN_URL, 'forbidden request header'));

  if (notice.level === 'host') {
    // Short on purpose: the route fields it explains open right below it, so the
    // notice only has to say why they are there and link to the install steps.
    text.appendChild(document.createTextNode('. A proxy route gets around it, which needs '));
    text.appendChild(externalLink(PROXY_README_URL, 'header-setter-proxy'));
    text.appendChild(document.createTextNode(' installed.'));
    els.headerNotice.appendChild(text);
    return;
  }

  text.appendChild(document.createTextNode(
    '. The browser derives it from the connection itself, so this rule will most'
    + ' likely have no effect.'
  ));
  els.headerNotice.appendChild(text);
}

/**
 * The proxy banner. Only shown when the proxy is actually needed, so a user who
 * never touches host routing is never asked to install anything.
 * @param {{reason: 'missing'|'stopped'}|null} state
 * @param {{recheck: Function}} actions
 */
export function renderProxyBanner(els, state, actions) {
  els.proxyBanner.replaceChildren();
  els.proxyBanner.hidden = !state;
  if (!state) return;

  const lead = document.createElement('p');
  lead.textContent = state.reason === 'stopped'
    ? `header-setter-proxy answered before but is not responding on 127.0.0.1:${ADMIN_PORT} now,`
      + ' so it is probably not running. Routes stay stored and start working again'
      + ' the moment it is back.'
    : `Host routing needs header-setter-proxy, and nothing is answering on`
      + ` 127.0.0.1:${ADMIN_PORT}. It has never answered on this machine, so it is`
      + ' probably not installed yet.';
  els.proxyBanner.appendChild(lead);

  // Both commands are always offered: the extension cannot see the file system, so
  // "not installed" versus "not running" is a guess, and guessing wrong must not
  // leave the user without the command they need.
  if (state.reason === 'missing') {
    const install = document.createElement('p');
    install.className = 'notice-sub';
    install.textContent = 'Install it:';
    els.proxyBanner.appendChild(install);
    els.proxyBanner.appendChild(commandRow(INSTALL_COMMAND));
    const then = document.createElement('p');
    then.className = 'notice-sub';
    then.textContent = 'Then start it:';
    els.proxyBanner.appendChild(then);
    els.proxyBanner.appendChild(commandRow(START_COMMAND));
  } else {
    // The command is what the notice is for, so it gets its own line to introduce it
    // instead of appearing under the explanation without a word.
    const start = document.createElement('p');
    start.className = 'notice-sub';
    start.textContent = 'Start it again:';
    els.proxyBanner.appendChild(start);
    els.proxyBanner.appendChild(commandRow(START_COMMAND));
    const reinstall = document.createElement('p');
    reinstall.className = 'notice-sub';
    reinstall.textContent = 'Not installed any more?';
    els.proxyBanner.appendChild(reinstall);
    els.proxyBanner.appendChild(commandRow(INSTALL_COMMAND));
  }

  const recheck = document.createElement('button');
  recheck.type = 'button';
  recheck.className = 'notice-action';
  recheck.textContent = 'Check again';
  recheck.addEventListener('click', actions.recheck);
  els.proxyBanner.appendChild(recheck);
}

/**
 * One block per host with everything that applies to it: its headers, its cookies
 * and, since the browser opens the host a route starts at, that route as well.
 * @param {{domain: string, enabled: boolean, headers: Array, cookies: Array,
 *   route: {from: string, to: string, enabled: boolean,
 *     failure?: {kind: string, target: string, message: string}}|null}[]} groups
 */
export function renderGroups(els, groups, actions) {
  els.groups.replaceChildren();
  els.emptyState.classList.toggle('visible', groups.length === 0);

  groups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'group';
    groupEl.classList.toggle('disabled', group.enabled === false);
    groupEl.appendChild(createGroupHeader(group, actions));

    const list = document.createElement('ul');
    list.className = 'header-list';
    if (group.route) {
      list.appendChild(createRouteItem(group.route, actions));
      // The reason belongs under the route it explains, not in the row: it is a
      // sentence, and the row is one line of host, target and three buttons.
      if (group.route.failure) list.appendChild(createRouteFailure(group.route.failure));
    }

    group.headers.forEach((header) => {
      list.appendChild(createRuleItem({
        itemClass: 'header-item',
        type: 'Header',
        name: header.name,
        nameSuffix: ': ',
        value: header.value,
        enabled: header.enabled !== false,
        ariaLabel: `Delete ${header.name}`,
        editAriaLabel: `Edit ${header.name}`,
        toggleAriaLabel: `Enable or disable ${header.name}`,
        onRemove: () => actions.removeHeader(group.domain, header.name),
        onToggle: () => actions.toggleHeader(group.domain, header.name),
        onEdit: () => actions.editHeader(group.domain, header),
      }));
    });
    group.cookies.forEach((cookie) => {
      list.appendChild(createRuleItem({
        itemClass: 'cookie-item',
        type: 'Cookie',
        name: cookie.name,
        nameSuffix: '=',
        value: cookie.value,
        enabled: cookie.enabled !== false,
        ariaLabel: `Delete cookie ${cookie.name}`,
        editAriaLabel: `Edit cookie ${cookie.name}`,
        toggleAriaLabel: `Enable or disable cookie ${cookie.name}`,
        onRemove: () => actions.removeCookie(group.domain, cookie.name),
        onToggle: () => actions.toggleCookie(group.domain, cookie.name),
        onEdit: () => actions.editCookie(group.domain, cookie),
      }));
    });
    groupEl.appendChild(list);
    els.groups.appendChild(groupEl);
  });
}

function createGroupHeader(group, actions) {
  const headerEl = document.createElement('div');
  headerEl.className = 'group-header';

  const domainSpan = document.createElement('span');
  domainSpan.className = 'domain-name';
  domainSpan.textContent = group.domain;
  headerEl.appendChild(domainSpan);

  const groupActions = document.createElement('div');
  groupActions.className = 'group-actions';

  // Suspends the whole block at once. It sits left of the removal for the same reason
  // the row toggles do: switching off is the reversible answer and comes first.
  groupActions.appendChild(toggleSwitch(
    group.enabled !== false,
    `Enable or disable everything for ${group.domain}`,
    () => actions.toggleDomain(group.domain)
  ));

  const removeDomainBtn = document.createElement('button');
  removeDomainBtn.type = 'button';
  removeDomainBtn.className = 'danger';
  removeDomainBtn.textContent = 'Delete';
  removeDomainBtn.setAttribute('aria-label', `Delete everything for ${group.domain}`);
  removeDomainBtn.addEventListener('click', () => actions.removeDomain(group.domain));
  groupActions.appendChild(removeDomainBtn);

  headerEl.appendChild(groupActions);
  return headerEl;
}

function createRouteItem(route, actions) {
  const li = document.createElement('li');
  li.className = 'route-item';
  li.classList.toggle('disabled', route.enabled === false);

  li.appendChild(typeBadge('Proxy'));

  const textSpan = document.createElement('span');
  textSpan.className = 'header-text';
  const fromSpan = document.createElement('span');
  fromSpan.className = 'name';
  fromSpan.textContent = route.from;
  textSpan.appendChild(fromSpan);
  const arrow = document.createElement('span');
  arrow.className = 'route-arrow';
  arrow.textContent = '→';
  textSpan.appendChild(arrow);
  textSpan.appendChild(document.createTextNode(route.to));
  li.appendChild(textSpan);

  // Switched off, the route leaves the PAC script and the proxy table but stays
  // stored, so the host keeps its headers and cookies without the detour.
  li.appendChild(toggleSwitch(
    route.enabled !== false,
    `Enable or disable the proxy for ${route.from}`,
    () => actions.toggleRoute(route.from)
  ));

  li.appendChild(editButton(`Edit the proxy for ${route.from}`, () => actions.editRoute(route)));
  li.appendChild(removeButton(`Delete the proxy for ${route.from}`, () => actions.removeRoute(route.from)));

  return li;
}

// Says why the last attempt to reach the target failed. Chrome cannot: it turns the
// proxy's 502 into ERR_TUNNEL_CONNECTION_FAILED, which names no reason at all.
function createRouteFailure(failure) {
  const li = document.createElement('li');
  li.className = 'route-failure';
  li.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'route-failure-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '\u26A0';
  li.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'route-failure-text';
  text.textContent = failure.message;
  li.appendChild(text);

  return li;
}

function createRuleItem({
  itemClass, type, name, nameSuffix, value, enabled,
  ariaLabel, editAriaLabel, toggleAriaLabel, onRemove, onToggle, onEdit,
}) {
  const li = document.createElement('li');
  li.className = itemClass;
  li.classList.toggle('disabled', !enabled);

  li.appendChild(typeBadge(type));

  const textSpan = document.createElement('span');
  textSpan.className = 'header-text';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name';
  nameSpan.textContent = `${name}${nameSuffix}`;
  textSpan.appendChild(nameSpan);
  textSpan.appendChild(document.createTextNode(value));
  li.appendChild(textSpan);

  // The three row actions run from reversible to final: switch off, edit, remove.
  li.appendChild(toggleSwitch(enabled, toggleAriaLabel, onToggle));
  li.appendChild(editButton(editAriaLabel, onEdit));
  li.appendChild(removeButton(ariaLabel, onRemove));

  return li;
}

function toggleSwitch(checked, ariaLabel, onToggle) {
  const label = document.createElement('label');
  label.className = 'toggle-switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', onToggle);
  label.appendChild(input);

  const slider = document.createElement('span');
  slider.className = 'toggle-slider';
  label.appendChild(slider);

  return label;
}

function typeBadge(type) {
  const badge = document.createElement('span');
  badge.className = 'item-type';
  badge.textContent = type;
  return badge;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// The pencil everyone reads as "edit", so the button needs no label of its own next
// to the ✕. Built through createElementNS: createElement would produce an unknown
// HTML element that renders nothing.
const PENCIL_PATH = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21'
  + 'a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z';

function pencilIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'btn-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PENCIL_PATH);
  svg.appendChild(path);

  return svg;
}

// Editing loads the entry back into the composer instead of opening a second form,
// so there is only ever one place where a rule is written.
function editButton(ariaLabel, onEdit) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'edit';
  button.appendChild(pencilIcon());
  button.setAttribute('aria-label', ariaLabel);
  button.title = ariaLabel;
  button.addEventListener('click', onEdit);
  return button;
}

function removeButton(ariaLabel, onRemove) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'danger';
  button.textContent = '✕';
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onRemove);
  return button;
}

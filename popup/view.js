export function showError(els, message) {
  els.formError.textContent = message;
  els.formError.hidden = !message;
}

export function renderGroups(els, domainRules, actions) {
  els.groups.innerHTML = '';
  els.emptyState.classList.toggle('visible', domainRules.length === 0);

  domainRules.forEach((group, groupIndex) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'group';

    const headerEl = document.createElement('div');
    headerEl.className = 'group-header';

    const domainSpan = document.createElement('span');
    domainSpan.className = 'domain-name';
    domainSpan.textContent = group.domain;
    headerEl.appendChild(domainSpan);

    const removeDomainBtn = document.createElement('button');
    removeDomainBtn.type = 'button';
    removeDomainBtn.className = 'danger';
    removeDomainBtn.textContent = 'Remove domain';
    removeDomainBtn.addEventListener('click', () => actions.removeDomain(groupIndex));
    headerEl.appendChild(removeDomainBtn);
    groupEl.appendChild(headerEl);

    const list = document.createElement('ul');
    list.className = 'header-list';
    group.headers.forEach((header, headerIndex) => {
      list.appendChild(createRuleItem({
        itemClass: 'header-item',
        type: 'Header',
        name: header.name,
        nameSuffix: ': ',
        value: header.value,
        enabled: header.enabled !== false,
        ariaLabel: `Remove ${header.name}`,
        toggleAriaLabel: `Enable or disable ${header.name}`,
        onRemove: () => actions.removeHeader(groupIndex, headerIndex),
        onToggle: () => actions.toggleHeader(groupIndex, headerIndex),
      }));
    });
    (group.cookies || []).forEach((cookie, cookieIndex) => {
      list.appendChild(createRuleItem({
        itemClass: 'cookie-item',
        type: 'Cookie',
        name: cookie.name,
        nameSuffix: '=',
        value: cookie.value,
        enabled: cookie.enabled !== false,
        ariaLabel: `Remove cookie ${cookie.name}`,
        toggleAriaLabel: `Enable or disable cookie ${cookie.name}`,
        onRemove: () => actions.removeCookie(groupIndex, cookieIndex),
        onToggle: () => actions.toggleCookie(groupIndex, cookieIndex),
      }));
    });
    groupEl.appendChild(list);
    els.groups.appendChild(groupEl);
  });
}

function createRuleItem({
  itemClass, type, name, nameSuffix, value, enabled,
  ariaLabel, toggleAriaLabel, onRemove, onToggle,
}) {
  const li = document.createElement('li');
  li.className = itemClass;
  li.classList.toggle('disabled', !enabled);

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'toggle-switch';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.checked = enabled;
  toggleInput.setAttribute('aria-label', toggleAriaLabel);
  toggleInput.addEventListener('change', onToggle);
  const toggleSlider = document.createElement('span');
  toggleSlider.className = 'toggle-slider';
  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(toggleSlider);
  li.appendChild(toggleLabel);

  const typeLabel = document.createElement('span');
  typeLabel.className = 'item-type';
  typeLabel.textContent = type;
  li.appendChild(typeLabel);

  const textSpan = document.createElement('span');
  textSpan.className = 'header-text';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name';
  nameSpan.textContent = `${name}${nameSuffix}`;
  textSpan.appendChild(nameSpan);
  textSpan.appendChild(document.createTextNode(value));
  li.appendChild(textSpan);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.textContent = '✕';
  removeBtn.setAttribute('aria-label', ariaLabel);
  removeBtn.addEventListener('click', onRemove);
  li.appendChild(removeBtn);

  return li;
}

import {
  getDomainRules,
  setDomainRules,
  getDraft,
  setDraft,
} from './storage.js';
import { normalizeDomain } from './domain.js';
import { applyRules } from './rules.js';
import { renderGroups, showError } from './view.js';

const els = {
  form: document.getElementById('addForm'),
  domain: document.getElementById('domain'),
  headerName: document.getElementById('headerName'),
  headerValue: document.getElementById('headerValue'),
  cookieName: document.getElementById('cookieName'),
  cookieValue: document.getElementById('cookieValue'),
  addCookieBtn: document.getElementById('addCookieBtn'),
  formError: document.getElementById('formError'),
  groups: document.getElementById('groups'),
  emptyState: document.getElementById('emptyState'),
  infoDetails: document.querySelector('.info-details'),
};

const DRAFT_FIELDS = ['domain', 'headerName', 'headerValue', 'cookieName', 'cookieValue'];

function readDraftFromForm() {
  const draft = {};
  DRAFT_FIELDS.forEach((field) => {
    draft[field] = els[field].value;
  });
  return draft;
}

function applyDraftToForm(draft) {
  DRAFT_FIELDS.forEach((field) => {
    if (draft[field]) els[field].value = draft[field];
  });
}

async function persistDraft() {
  await setDraft(readDraftFromForm());
}

function setupDraftPersistence() {
  DRAFT_FIELDS.forEach((field) => {
    els[field].addEventListener('input', persistDraft);
  });
}

function setupInfoToggle() {
  document.addEventListener('click', (event) => {
    if (els.infoDetails.open && !els.infoDetails.contains(event.target)) {
      els.infoDetails.open = false;
    }
  });
}

async function saveAndApply(domainRules) {
  await setDomainRules(domainRules);
  await applyRules(domainRules);
}

function getOrCreateGroup(domainRules, domain) {
  let group = domainRules.find((item) => item.domain === domain);
  if (!group) {
    group = { domain, headers: [], cookies: [] };
    domainRules.push(group);
  }
  group.cookies = group.cookies || [];
  return group;
}

async function addHeader(event) {
  event.preventDefault();
  showError(els, '');

  const domain = normalizeDomain(els.domain.value);
  const name = els.headerName.value.trim();
  const value = els.headerValue.value.trim();
  if (!domain || !name || !value) {
    showError(els, 'Please fill in domain, header name, and header value.');
    return;
  }

  const domainRules = await getDomainRules();
  const group = getOrCreateGroup(domainRules, domain);
  const existing = group.headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.value = value;
  else group.headers.push({ name, value });

  await saveAndApply(domainRules);
  render(domainRules);
  els.headerName.value = '';
  els.headerValue.value = '';
  els.headerName.focus();
  await persistDraft();
}

async function addCookie() {
  showError(els, '');

  const domain = normalizeDomain(els.domain.value);
  const name = els.cookieName.value.trim();
  const value = els.cookieValue.value.trim();
  if (!domain || !name || !value || name.includes(';') || value.includes(';')) {
    showError(els, 'Please fill in a valid domain, cookie name, and cookie value.');
    return;
  }

  const domainRules = await getDomainRules();
  const group = getOrCreateGroup(domainRules, domain);
  const existing = group.cookies.find((cookie) => cookie.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.value = value;
  else group.cookies.push({ name, value });

  await saveAndApply(domainRules);
  render(domainRules);
  els.cookieName.value = '';
  els.cookieValue.value = '';
  els.cookieName.focus();
  await persistDraft();
}

async function removeHeader(groupIndex, headerIndex) {
  const domainRules = await getDomainRules();
  const group = domainRules[groupIndex];
  group.headers.splice(headerIndex, 1);
  removeEmptyGroup(domainRules, groupIndex);
  await saveAndApply(domainRules);
  render(domainRules);
}

async function removeCookie(groupIndex, cookieIndex) {
  const domainRules = await getDomainRules();
  const group = domainRules[groupIndex];
  group.cookies.splice(cookieIndex, 1);
  removeEmptyGroup(domainRules, groupIndex);
  await saveAndApply(domainRules);
  render(domainRules);
}

function removeEmptyGroup(domainRules, groupIndex) {
  const group = domainRules[groupIndex];
  if (group.headers.length === 0 && group.cookies.length === 0) {
    domainRules.splice(groupIndex, 1);
  }
}

async function toggleHeader(groupIndex, headerIndex) {
  const domainRules = await getDomainRules();
  const header = domainRules[groupIndex].headers[headerIndex];
  header.enabled = header.enabled === false;
  await saveAndApply(domainRules);
  render(domainRules);
}

async function toggleCookie(groupIndex, cookieIndex) {
  const domainRules = await getDomainRules();
  const cookie = domainRules[groupIndex].cookies[cookieIndex];
  cookie.enabled = cookie.enabled === false;
  await saveAndApply(domainRules);
  render(domainRules);
}

async function removeDomain(groupIndex) {
  const domainRules = await getDomainRules();
  domainRules.splice(groupIndex, 1);
  await saveAndApply(domainRules);
  render(domainRules);
}

function render(domainRules) {
  renderGroups(els, domainRules, {
    removeHeader,
    removeCookie,
    removeDomain,
    toggleHeader,
    toggleCookie,
  });
}

async function init() {
  const [domainRules, draft] = await Promise.all([getDomainRules(), getDraft()]);
  applyDraftToForm(draft);
  render(domainRules);
  await applyRules(domainRules);
}

els.form.addEventListener('submit', addHeader);
els.addCookieBtn.addEventListener('click', addCookie);
setupInfoToggle();
setupDraftPersistence();
init();

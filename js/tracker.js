// Page 1: the delay tracker. Fetches live trains, lets the user log a delay
// per train via the bottom sheet, and persists it with js/storage.js.

import { fetchTrains } from './api.js';
import { DIRECTIONS, DIRECTION_IDS } from './config.js';
import {
  toHHMM,
  actualArrival,
  actualDurationMin,
  extraTimeInTrainMin,
  entryFromTrain,
  formatMinutes,
  formatDelay,
  delaySeverity,
} from './model.js';
import { getEntry, saveEntry, deleteEntry } from './storage.js';
import { syncInBackground } from './sync.js';
import { initAuthGate } from './auth-gate.js';

const QUICK_PICKS = [0, 2, 5, 10, 15, 20, 30, 45, 60];
const REFRESH_MS = 60000;

const els = {
  freshness: document.getElementById('freshness'),
  refreshBtn: document.getElementById('refreshBtn'),
  directionControl: document.getElementById('directionControl'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('noticeText'),
  skeletonWrap: document.getElementById('skeletonWrap'),
  emptyState: document.getElementById('emptyState'),
  listRoot: document.getElementById('trainListRoot'),

  sheet: document.getElementById('entrySheet'),
  sheetBackdrop: document.getElementById('sheetBackdrop'),
  sheetPanel: document.getElementById('sheetPanel'),
  sheetTitle: document.getElementById('sheetTitle'),
  sheetSub: document.getElementById('sheetSub'),

  arrInput: document.getElementById('arrInput'),
  arrMinus: document.getElementById('arrMinus'),
  arrPlus: document.getElementById('arrPlus'),
  arrChips: document.getElementById('arrChips'),

  detailsToggle: document.getElementById('detailsToggle'),
  departureField: document.getElementById('departureField'),
  depInput: document.getElementById('depInput'),
  depMinus: document.getElementById('depMinus'),
  depPlus: document.getElementById('depPlus'),

  cancelledCheckbox: document.getElementById('cancelledCheckbox'),
  noteTextarea: document.getElementById('noteTextarea'),
  previewText: document.getElementById('previewText'),

  cancelBtn: document.getElementById('cancelBtn'),
  saveBtn: document.getElementById('saveBtn'),
  deleteBtn: document.getElementById('deleteBtn'),

  toast: document.getElementById('toast'),
};

const state = {
  trains: [],
  source: null,
  degraded: false,
  error: null,
  fetchedAt: null,
  loading: true,
  filter: 'ALL',
  sheetOpen: false,
};

const sheet = {
  train: null,
  hasExisting: false,
};

let toastTimer = null;
let refreshTimer = null;

// The page stays locked until a session exists; init() runs once, on unlock.
initAuthGate({ onSignedIn: init });

async function init() {
  wireStaticEvents();
  buildQuickPickChips();
  await loadTrains();

  refreshTimer = setInterval(() => {
    if (!state.sheetOpen) loadTrains();
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.sheetOpen) loadTrains();
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadTrains() {
  state.loading = true;
  render();
  try {
    const result = await fetchTrains();
    state.trains = Array.isArray(result?.trains) ? result.trains : [];
    state.source = result?.source ?? null;
    state.degraded = Boolean(result?.degraded);
    state.error = result?.error ?? null;
    state.fetchedAt = result?.fetchedAt ?? new Date().toISOString();
  } catch (err) {
    console.error('[tracker] fetchTrains failed', err);
    state.trains = [];
    state.degraded = true;
    state.error = 'Live-Daten konnten nicht geladen werden.';
    state.fetchedAt = new Date().toISOString();
  } finally {
    state.loading = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderFreshness();
  renderNotice();
  renderList();
}

function renderFreshness() {
  if (state.loading && !state.fetchedAt) {
    els.freshness.textContent = 'wird geladen…';
    return;
  }
  const parts = [];
  if (state.fetchedAt) {
    parts.push(`aktualisiert ${toHHMM(state.fetchedAt)}`);
  }
  if (state.source === 'dbf' || state.source === 'static') {
    parts.push('Ankunftszeiten geschätzt');
  }
  els.freshness.textContent = parts.length ? parts.join(' · ') : ' ';
}

function renderNotice() {
  // Note: .notice sets `display: flex` in app.css, which (per the cascade)
  // overrides the UA default `[hidden] { display: none }`, so the `hidden`
  // attribute alone would not visually hide it -- toggle inline style too.
  if (state.degraded && state.error) {
    els.noticeText.textContent = state.error;
    els.notice.hidden = false;
    els.notice.style.display = '';
  } else {
    els.notice.hidden = true;
    els.notice.style.display = 'none';
  }
}

function getFilteredTrains() {
  if (state.filter === 'ALL') return state.trains;
  return state.trains.filter((t) => t.direction === state.filter);
}

function renderList() {
  const filtered = getFilteredTrains();
  const showSkeleton = state.loading && state.trains.length === 0;

  els.skeletonWrap.hidden = !showSkeleton;
  els.emptyState.hidden = showSkeleton || filtered.length > 0;
  els.listRoot.hidden = showSkeleton;

  els.listRoot.replaceChildren();
  if (showSkeleton || filtered.length === 0) return;

  const now = Date.now();
  for (const dirId of DIRECTION_IDS) {
    if (state.filter !== 'ALL' && state.filter !== dirId) continue;
    const groupTrains = filtered.filter((t) => t.direction === dirId);
    if (groupTrains.length === 0) continue;
    els.listRoot.appendChild(buildGroup(dirId, groupTrains, now));
  }
}

function buildGroup(dirId, groupTrains, now) {
  const section = document.createElement('div');
  section.className = 'train-group';

  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = DIRECTIONS[dirId].label;
  section.appendChild(title);

  const card = document.createElement('div');
  card.className = 'card';
  const ul = document.createElement('ul');
  ul.className = 'train-list';

  for (const train of groupTrains) {
    const li = document.createElement('li');
    li.appendChild(buildTrainItem(train, now));
    ul.appendChild(li);
  }

  card.appendChild(ul);
  section.appendChild(card);
  return section;
}

function buildTrainItem(train, now) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'train-item';
  btn.dataset.trainId = train.id;

  const isPast = new Date(train.scheduledDeparture).getTime() < now;
  const entry = getEntry(train.id);
  if (isPast) btn.classList.add('is-past');
  if (entry) btn.classList.add('is-logged');

  // --- time column ---
  const timeCol = document.createElement('div');
  const timeEl = document.createElement('span');
  timeEl.className = 'train-time';
  timeEl.textContent = toHHMM(train.scheduledDeparture);
  timeCol.appendChild(timeEl);

  const depDelayText = formatDelay(train.departureDelayMin);
  if (depDelayText) {
    const sub = document.createElement('span');
    sub.className = 'train-time-sub';
    sub.textContent = depDelayText;
    timeCol.appendChild(sub);
  }
  btn.appendChild(timeCol);

  // --- main column ---
  const main = document.createElement('div');
  main.className = 'train-main';

  const headline = document.createElement('div');
  const lineBadge = document.createElement('span');
  lineBadge.className = 'train-line';
  lineBadge.textContent = train.line;
  headline.appendChild(lineBadge);

  const route = document.createElement('span');
  route.className = 'train-route';
  route.textContent = `${train.fromName} → ${train.toName}`;
  headline.appendChild(route);
  main.appendChild(headline);

  const meta = document.createElement('div');
  meta.className = 'train-meta';
  const isEstimate = train.source === 'dbf' || train.source === 'static';
  const metaParts = [
    `an ${toHHMM(actualArrival(train))}`,
    formatMinutes(train.scheduledDurationMin),
  ];
  if (train.platform) metaParts.push(`Gleis ${train.platform}`);
  if (isEstimate) metaParts.push('geschätzt');
  meta.textContent = metaParts.join(' · ');
  main.appendChild(meta);

  btn.appendChild(main);

  // --- aside: live delay + logged badge ---
  const aside = document.createElement('div');
  aside.className = 'train-aside';

  const liveBadge = document.createElement('span');
  if (train.cancelled) {
    liveBadge.className = 'badge badge--bad';
    liveBadge.textContent = 'Ausfall';
  } else {
    const severity = delaySeverity(train.arrivalDelayMin);
    liveBadge.className = `badge badge--${severity}`;
    const text = formatDelay(train.arrivalDelayMin);
    liveBadge.textContent = text || '–';
  }
  aside.appendChild(liveBadge);

  if (entry) {
    const loggedBadge = document.createElement('span');
    loggedBadge.className = 'badge badge--muted';
    loggedBadge.textContent = entry.cancelled ? 'Erfasst: Ausfall' : `Erfasst: ${formatDelay(entry.arrivalDelayMin)}`;
    aside.appendChild(loggedBadge);
  }

  btn.appendChild(aside);

  return btn;
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

function buildQuickPickChips() {
  els.arrChips.replaceChildren();
  for (const value of QUICK_PICKS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.value = String(value);
    chip.textContent = value === 0 ? 'pünktlich' : `+${value}`;
    chip.addEventListener('click', () => {
      els.arrInput.value = String(value);
      updateChipActiveState();
      updatePreview();
    });
    els.arrChips.appendChild(chip);
  }
}

function updateChipActiveState() {
  const current = Number(els.arrInput.value) || 0;
  for (const chip of els.arrChips.children) {
    chip.classList.toggle('is-active', Number(chip.dataset.value) === current);
  }
}

function openSheet(train) {
  sheet.train = train;
  const existing = getEntry(train.id);
  sheet.hasExisting = Boolean(existing);

  els.sheetTitle.textContent = `${train.line} ${train.trainNumber}`.trim();
  els.sheetSub.textContent =
    `${DIRECTIONS[train.direction].label} · ${toHHMM(train.scheduledDeparture)} → ${toHHMM(train.scheduledArrival)}`;

  const defaultArrival = existing ? existing.arrivalDelayMin : (train.arrivalDelayMin ?? 0);
  const defaultDeparture = existing ? existing.departureDelayMin : (train.departureDelayMin ?? 0);
  const defaultCancelled = existing ? existing.cancelled : Boolean(train.cancelled);
  const defaultNote = existing ? existing.note : '';

  els.arrInput.value = String(Math.round(defaultArrival) || 0);
  els.depInput.value = String(Math.round(defaultDeparture) || 0);
  els.cancelledCheckbox.checked = defaultCancelled;
  els.noteTextarea.value = defaultNote || '';
  // .btn--block sets `display: block`, which likewise overrides the UA
  // `[hidden]` default -- toggle inline style alongside the attribute.
  els.deleteBtn.hidden = !existing;
  els.deleteBtn.style.display = existing ? '' : 'none';

  // Reveal the details section automatically if there is a non-zero
  // departure delay to show, otherwise keep it collapsed.
  const showDetails = Number(els.depInput.value) !== 0;
  els.departureField.hidden = !showDetails;
  els.detailsToggle.setAttribute('aria-expanded', String(showDetails));

  updateChipActiveState();
  updatePreview();

  els.sheet.hidden = false;
  state.sheetOpen = true;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onSheetKeydown);
  els.sheetPanel.focus();
}

function closeSheet() {
  els.sheet.hidden = true;
  state.sheetOpen = false;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onSheetKeydown);
  sheet.train = null;
  sheet.hasExisting = false;
}

function onSheetKeydown(event) {
  if (event.key === 'Escape') closeSheet();
}

function currentFormValues() {
  return {
    departureDelayMin: Number(els.depInput.value) || 0,
    arrivalDelayMin: Number(els.arrInput.value) || 0,
    cancelled: els.cancelledCheckbox.checked,
    note: els.noteTextarea.value,
  };
}

function updatePreview() {
  const train = sheet.train;
  if (!train) return;
  const values = currentFormValues();

  if (values.cancelled) {
    els.previewText.textContent = 'Zug fällt aus – keine Ankunft erfasst.';
    return;
  }

  const merged = { ...train, ...values };
  const arrival = actualArrival(merged);
  const duration = actualDurationMin(merged);
  const extra = extraTimeInTrainMin(merged);

  let extraText;
  if (extra > 0) extraText = `${formatMinutes(extra)} länger im Zug als geplant`;
  else if (extra < 0) extraText = `${formatMinutes(Math.abs(extra))} kürzer im Zug als geplant`;
  else extraText = 'Fahrzeit wie geplant';

  els.previewText.textContent = `Ankunft ca. ${toHHMM(arrival)} · ${formatMinutes(duration)} im Zug (${extraText})`;
}

function handleSave() {
  const train = sheet.train;
  if (!train) return;
  const values = currentFormValues();
  const entry = entryFromTrain(train, values);
  saveEntry(entry);
  closeSheet();
  showToast('Gespeichert');
  render();
  syncInBackground(); // fire-and-forget: saving must never wait on the network
}

function handleDelete() {
  const train = sheet.train;
  if (!train) return;
  deleteEntry(train.id);
  closeSheet();
  showToast('Gelöscht');
  render();
  syncInBackground();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 1800);
}

// ---------------------------------------------------------------------------
// Static event wiring (attached once)
// ---------------------------------------------------------------------------

function wireStaticEvents() {
  els.refreshBtn.addEventListener('click', () => loadTrains());

  els.directionControl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    state.filter = btn.dataset.value;
    for (const b of els.directionControl.children) {
      b.classList.toggle('is-active', b === btn);
    }
    renderList();
  });

  els.listRoot.addEventListener('click', (event) => {
    const btn = event.target.closest('.train-item');
    if (!btn) return;
    const train = state.trains.find((t) => t.id === btn.dataset.trainId);
    if (train) openSheet(train);
  });

  els.sheetBackdrop.addEventListener('click', closeSheet);
  els.cancelBtn.addEventListener('click', closeSheet);
  els.saveBtn.addEventListener('click', handleSave);
  els.deleteBtn.addEventListener('click', handleDelete);

  els.detailsToggle.addEventListener('click', () => {
    const expanded = !els.departureField.hidden;
    els.departureField.hidden = expanded;
    els.detailsToggle.setAttribute('aria-expanded', String(!expanded));
  });

  els.arrMinus.addEventListener('click', () => stepInput(els.arrInput, -1));
  els.arrPlus.addEventListener('click', () => stepInput(els.arrInput, 1));
  els.depMinus.addEventListener('click', () => stepInput(els.depInput, -1));
  els.depPlus.addEventListener('click', () => stepInput(els.depInput, 1));

  els.arrInput.addEventListener('input', () => {
    updateChipActiveState();
    updatePreview();
  });
  els.depInput.addEventListener('input', updatePreview);
  els.cancelledCheckbox.addEventListener('change', updatePreview);
  els.noteTextarea.addEventListener('input', updatePreview);
}

function stepInput(input, delta) {
  const next = (Number(input.value) || 0) + delta;
  input.value = String(next);
  if (input === els.arrInput) updateChipActiveState();
  updatePreview();
}

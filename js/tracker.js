// Page 1: the delay tracker. Fetches live trains, lets the user log a delay
// per train via the shared bottom sheet (js/entry-sheet.js), and persists it
// with js/storage.js.
//
// The list normally sits on "now", but it can be anchored to a past date/time so
// a forgotten trip can be logged after the fact -- see the anchor section below.

import { fetchTrains } from './api.js';
import { DIRECTIONS, DIRECTION_IDS, directionMatches, WINDOW_HOURS } from './config.js';
import {
  toHHMM,
  actualArrival,
  toServiceDate,
  formatMinutes,
  formatDelay,
  delaySeverity,
  MS_MIN,
} from './model.js';
import { getEntry } from './storage.js';
import { startAutoSync, onSyncStateChange } from './sync.js';
import { openEntrySheet, isEntrySheetOpen } from './entry-sheet.js';
import { initAuthGate } from './auth-gate.js';

const REFRESH_MS = 60000;

// How far back the date picker will go. Long enough to catch up on a holiday's
// worth of forgotten trips, short enough that the picker cannot be pointed at a
// date no timetable source could possibly still answer for.
const MAX_BACKDATE_DAYS = 400;

// ---------------------------------------------------------------------------
// Preferences (persisted): which axis/hub the train list is filtered to.
// ---------------------------------------------------------------------------

const PREFS_KEY = 'dbt.tracker.prefs.v1';

const DEFAULT_PREFS = {
  axis: 'ALL', // 'ALL' | 'TO_MUC' | 'TO_RO'
  hub: 'ALL', // 'ALL' | 'HBF' | 'OST'
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (err) {
    console.warn('[tracker] could not read prefs, using defaults', err);
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[tracker] could not persist prefs', err);
  }
}

let prefs = loadPrefs();

const els = {
  freshness: document.getElementById('freshness'),
  refreshBtn: document.getElementById('refreshBtn'),
  directionControl: document.getElementById('directionControl'),
  hubControl: document.getElementById('hubControl'),
  anchorBar: document.getElementById('anchorBar'),
  anchorText: document.getElementById('anchorText'),
  anchorResetBtn: document.getElementById('anchorResetBtn'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('noticeText'),
  skeletonWrap: document.getElementById('skeletonWrap'),
  emptyState: document.getElementById('emptyState'),
  emptyText: document.getElementById('emptyText'),
  listRoot: document.getElementById('trainListRoot'),

  pastToggle: document.getElementById('pastToggle'),
  pastPanel: document.getElementById('pastPanel'),
  pastDate: document.getElementById('pastDate'),
  pastTime: document.getElementById('pastTime'),
  pastShowBtn: document.getElementById('pastShowBtn'),
  pastCancelBtn: document.getElementById('pastCancelBtn'),

  toast: document.getElementById('toast'),
};

const state = {
  trains: [],
  source: null,
  degraded: false,
  error: null,
  fetchedAt: null,
  loading: true,
  // When set, the list shows the window around this moment instead of "now".
  // Transient by design: a reload always lands back on the live view.
  anchor: null,
};

let toastTimer = null;
let refreshTimer = null;

/** The moment the list is centred on -- the anchor if one is set, else now. */
function referenceTime() {
  return state.anchor ? state.anchor.getTime() : Date.now();
}

// The page stays locked until a session exists; init() runs once, on unlock.
initAuthGate({ onSignedIn: init });

async function init() {
  wireStaticEvents();
  await loadTrains();

  // A back-dated view is a fixed snapshot -- polling it would only re-fetch the
  // same past window, so the auto-refresh pauses until the user returns to now.
  refreshTimer = setInterval(() => {
    if (!isEntrySheetOpen() && !state.anchor) loadTrains();
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isEntrySheetOpen() && !state.anchor) loadTrains();
  });

  // Trips logged on another device should turn up here on their own.
  startAutoSync();
  onSyncStateChange((event) => {
    // Only when the merge actually brought something in, and never while the
    // user is mid-edit in the sheet.
    if (event.status === 'ok' && event.result?.changed && !isEntrySheetOpen()) render();
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadTrains() {
  state.loading = true;
  render();
  // The user can switch to another date -- or back to now -- while this is in
  // flight. Everything below is discarded if that happened, so a slow response
  // for the old view cannot overwrite the newer one (including its loading flag).
  const anchor = state.anchor;
  try {
    // dbf only ever serves today's live board, so it must not be consulted for a
    // back-dated window -- see the note on fetchTrains().
    const result = await fetchTrains(
      anchor ? { now: anchor, useDepartureBoard: false } : {}
    );
    if (state.anchor !== anchor) return;
    state.trains = Array.isArray(result?.trains) ? result.trains : [];
    state.source = result?.source ?? null;
    state.degraded = Boolean(result?.degraded);
    state.error = result?.error ?? null;
    state.fetchedAt = result?.fetchedAt ?? new Date().toISOString();
  } catch (err) {
    if (state.anchor !== anchor) return;
    console.error('[tracker] fetchTrains failed', err);
    state.trains = [];
    state.degraded = true;
    state.error = 'Live-Daten konnten nicht geladen werden.';
    state.fetchedAt = new Date().toISOString();
  } finally {
    if (state.anchor === anchor) {
      state.loading = false;
      render();
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderAnchorBar();
  renderFreshness();
  renderNotice();
  renderList();
}

/** "Fr., 07.08.2026" -- the long form, used where the date is the whole point. */
function formatAnchorDate(date) {
  return date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderAnchorBar() {
  if (!state.anchor) {
    els.anchorBar.hidden = true;
    return;
  }
  els.anchorText.textContent = `Nachtragen: ${formatAnchorDate(state.anchor)}, ${toHHMM(state.anchor)}`;
  els.anchorBar.hidden = false;
}

function renderFreshness() {
  if (state.anchor) {
    els.freshness.textContent = `Rückblick · ${formatAnchorDate(state.anchor)}`;
    return;
  }
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

function noticeMessage() {
  // Anchored on a past date, "Live-Fahrplandaten nicht verfügbar" (api.js's
  // wording for the live view) reads as a fault. It usually is not one -- the
  // journey planner simply does not keep itineraries for that day any more --
  // so name the actual consequence instead.
  if (state.anchor && state.source === 'static') {
    return (
      'Für dieses Datum liegen keine Fahrplandaten mehr vor. Angezeigt wird der ' +
      'hinterlegte Ersatzfahrplan – Zeiten können von der tatsächlichen Fahrt abweichen.'
    );
  }
  return state.degraded && state.error ? state.error : null;
}

function renderNotice() {
  const message = noticeMessage();
  // Note: .notice sets `display: flex` in app.css, which (per the cascade)
  // overrides the UA default `[hidden] { display: none }`, so the `hidden`
  // attribute alone would not visually hide it -- toggle inline style too.
  if (message) {
    els.noticeText.textContent = message;
    els.notice.hidden = false;
    els.notice.style.display = '';
  } else {
    els.notice.hidden = true;
    els.notice.style.display = 'none';
  }
}

function getFilteredTrains() {
  return state.trains.filter((t) => directionMatches(t.direction, { axis: prefs.axis, hub: prefs.hub }));
}

function renderList() {
  const filtered = getFilteredTrains();
  const showSkeleton = state.loading && state.trains.length === 0;

  els.skeletonWrap.hidden = !showSkeleton;
  els.emptyState.hidden = showSkeleton || filtered.length > 0;
  els.listRoot.hidden = showSkeleton;
  els.emptyText.textContent = state.anchor
    ? `Für ${formatAnchorDate(state.anchor)} liegen um diese Uhrzeit keine Züge vor. `
      + 'Wähl eine andere Uhrzeit oder ein anderes Datum.'
    : 'Aktuell liegen keine Züge innerhalb der nächsten bzw. letzten 2 Stunden vor. '
      + 'Zieh zum Aktualisieren oder komm später wieder.';

  els.listRoot.replaceChildren();
  if (showSkeleton || filtered.length === 0) return;

  // Dimming "past" departures is relative to whatever the list is centred on,
  // so an anchored view greys out the trains before the chosen time rather than
  // the whole list.
  const reference = referenceTime();
  for (const dirId of DIRECTION_IDS) {
    const groupTrains = filtered.filter((t) => t.direction === dirId);
    if (groupTrains.length === 0) continue;
    els.listRoot.appendChild(buildGroup(dirId, groupTrains, reference));
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
// Sheet (markup + behaviour live in js/entry-sheet.js, shared with the stats page)
// ---------------------------------------------------------------------------

function openSheet(train) {
  openEntrySheet({
    train,
    onSaved: (_entry, { wasExisting }) => {
      showToast(wasExisting ? 'Aktualisiert' : 'Gespeichert');
      render();
    },
    onDeleted: () => {
      showToast('Gelöscht');
      render();
    },
  });
}

// ---------------------------------------------------------------------------
// Back-dated lookup ("Frühere Fahrt nachtragen")
// ---------------------------------------------------------------------------

/** Local "HH:MM" rounded down to the nearest five minutes, for the time input. */
function toStepValue(date) {
  const d = new Date(date);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return toHHMM(d);
}

function setPastPanelOpen(open) {
  els.pastPanel.hidden = !open;
  els.pastToggle.setAttribute('aria-expanded', String(open));
  if (!open) return;

  // Seed with whatever the list currently shows, so reopening the panel to
  // nudge the time by an hour does not mean re-entering the date as well.
  const seed = state.anchor ?? new Date();
  els.pastDate.value = toServiceDate(seed);
  els.pastTime.value = toStepValue(seed);
  els.pastPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  els.pastDate.focus();
}

/** Read the two inputs into one local Date, or null if they are not usable. */
function readPastInputs() {
  const [y, m, d] = (els.pastDate.value || '').split('-').map(Number);
  const [hh, mm] = (els.pastTime.value || '').split(':').map(Number);
  if (!y || !m || !d || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function applyAnchor(date) {
  state.anchor = date;
  state.trains = [];
  state.source = null;
  state.degraded = false;
  state.error = null;
  setPastPanelOpen(false);
  loadTrains();
}

function clearAnchor() {
  if (!state.anchor) return;
  state.anchor = null;
  state.trains = [];
  state.source = null;
  state.degraded = false;
  state.error = null;
  loadTrains();
}

function wirePastLookup() {
  // The date input caps itself at today: the live list already covers the next
  // two hours, and anything beyond that has no delay to log yet.
  const today = new Date();
  const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - MAX_BACKDATE_DAYS);
  els.pastDate.max = toServiceDate(today);
  els.pastDate.min = toServiceDate(earliest);

  els.pastToggle.addEventListener('click', () => setPastPanelOpen(els.pastPanel.hidden));
  els.pastCancelBtn.addEventListener('click', () => setPastPanelOpen(false));
  els.anchorResetBtn.addEventListener('click', clearAnchor);

  els.pastShowBtn.addEventListener('click', () => {
    const picked = readPastInputs();
    if (!picked) {
      showToast('Bitte Datum und Uhrzeit angeben');
      return;
    }
    if (picked.getTime() < earliest.getTime()) {
      showToast(`Nur bis ${formatAnchorDate(earliest)} zurück möglich`);
      return;
    }
    // Anything at or after "now" is just the live view -- no anchor needed, and
    // pinning one would only freeze the auto-refresh for no reason.
    if (picked.getTime() >= Date.now() - WINDOW_HOURS * 60 * MS_MIN) {
      setPastPanelOpen(false);
      clearAnchor();
      return;
    }
    applyAnchor(picked);
  });
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

function updateFilterControlStates() {
  for (const b of els.directionControl.children) {
    b.classList.toggle('is-active', b.dataset.value === prefs.axis);
  }
  for (const b of els.hubControl.children) {
    b.classList.toggle('is-active', b.dataset.value === prefs.hub);
  }
}

function wireStaticEvents() {
  updateFilterControlStates();
  els.refreshBtn.addEventListener('click', () => loadTrains());

  els.directionControl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    prefs.axis = btn.dataset.value;
    savePrefs(prefs);
    updateFilterControlStates();
    renderList();
  });

  els.hubControl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn) return;
    prefs.hub = btn.dataset.value;
    savePrefs(prefs);
    updateFilterControlStates();
    renderList();
  });

  els.listRoot.addEventListener('click', (event) => {
    const btn = event.target.closest('.train-item');
    if (!btn) return;
    const train = state.trains.find((t) => t.id === btn.dataset.trainId);
    if (train) openSheet(train);
  });

  wirePastLookup();
}

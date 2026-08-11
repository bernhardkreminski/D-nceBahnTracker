// Statistics page: configurable, grouped evaluation of logged delays.
// No dependencies, no external requests -- everything derives from storage.js
// via the shared helpers in model.js so the numbers always match the tracker page.

import { DIRECTIONS, DIRECTION_IDS, directionMatches } from './config.js';
import {
  toServiceDate,
  toHHMM,
  actualDurationMin,
  extraTimeInTrainMin,
  lostTimeMin,
  formatMinutes,
  formatDelay,
  delaySeverity,
} from './model.js';
import { listEntries, deleteEntry, clearAll, exportJSON, importJSON, STORAGE_WRITE_ERROR } from './storage.js';
import { openEntrySheet, isEntrySheetOpen } from './entry-sheet.js';
import {
  isSupabaseConfigured,
  getSession,
  isSignedIn,
  onAuthChange,
  signOut,
  sync,
  getSyncMeta,
  startAutoSync,
  onSyncStateChange,
} from './sync.js';
import { initAuthGate } from './auth-gate.js';

// ---------------------------------------------------------------------------
// Preferences (persisted)
// ---------------------------------------------------------------------------

const PREFS_KEY = 'dbt.stats.prefs.v1';

const DEFAULT_PREFS = {
  grouping: 'day', // 'day' | 'week' | 'month' | 'year'
  range: '30d', // '7d' | '30d' | '3m' | '12m' | 'all'
  axis: 'ALL', // 'ALL' | 'TO_MUC' | 'TO_RO'
  hub: 'ALL', // 'ALL' | 'HBF' | 'OST'
  metric: 'arrivalDelay', // 'arrivalDelay' | 'extraTime' | 'actualDuration' | 'count'
  cancelledMode: 'include', // 'include' | 'exclude'
};

/**
 * Older versions stored a single `direction` field holding a direction id
 * ('RO_MU' | 'MU_RO' | 'ALL') rather than today's axis/hub pair. Map it
 * forward so a pref saved before the second commuter connection was added
 * still loads correctly.
 */
function migrateLegacyPrefs(parsed) {
  if (!parsed || typeof parsed !== 'object' || !('direction' in parsed)) return parsed;
  const { direction, ...rest } = parsed;
  const migrated = { ...rest };
  if (migrated.axis === undefined) {
    if (direction === 'RO_MU') migrated.axis = 'TO_MUC';
    else if (direction === 'MU_RO') migrated.axis = 'TO_RO';
    else migrated.axis = 'ALL';
  }
  if (migrated.hub === undefined) migrated.hub = 'ALL';
  return migrated;
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = migrateLegacyPrefs(JSON.parse(raw));
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (err) {
    console.warn('[stats] could not read prefs, using defaults', err);
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[stats] could not persist prefs', err);
  }
}

let prefs = loadPrefs();

// ---------------------------------------------------------------------------
// Device sync UI state (transient -- never persisted, so an unrelated
// re-render never wipes a half-typed e-mail or code)
// ---------------------------------------------------------------------------

/**
 * Signing in is the auth gate's job (js/auth-gate.js); this card only covers the
 * signed-in state, so it just tracks which action is in flight and the last
 * error. `busy` is false or one of 'sync' | 'signout', which lets the button
 * that triggered it show the right German loading label while all of them stay
 * disabled.
 */
const syncUi = {
  busy: false,
  error: '',
};

// ---------------------------------------------------------------------------
// Static option lists
// ---------------------------------------------------------------------------

const RANGE_OPTIONS = [
  { value: '7d', label: 'Letzte 7 Tage', days: 7 },
  { value: '30d', label: 'Letzte 30 Tage', days: 30 },
  { value: '3m', label: 'Letzte 3 Monate', months: 3 },
  { value: '12m', label: 'Letzte 12 Monate', months: 12 },
  { value: 'all', label: 'Gesamt' },
];

const METRIC_OPTIONS = [
  { value: 'arrivalDelay', label: 'Verspätung (Ankunft)' },
  { value: 'extraTime', label: 'Zusätzliche Zeit im Zug' },
  { value: 'actualDuration', label: 'Reisezeit (tatsächlich)' },
  { value: 'count', label: 'Anzahl Fahrten' },
];

const GROUPING_LABELS = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' };

const MAX_FILLED_BUCKETS = 60; // beyond this, stop zero-filling empty periods

// ---------------------------------------------------------------------------
// Small DOM + math helpers
// ---------------------------------------------------------------------------

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.title !== undefined) node.title = opts.title;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function average(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** "+6 Min." / "pünktlich" / "-2 Min." */
function formatSignedMinutes(mins) {
  const r = Math.round(mins);
  return r === 0 ? 'pünktlich' : `${formatDelay(r)} Min.`;
}

/** Parse a "YYYY-MM-DD" service date as a LOCAL date (never via UTC parsing). */
function parseServiceDate(serviceDate) {
  const [y, m, d] = serviceDate.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function isoWeekInfo(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Monday=1..Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { isoYear, week };
}

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay() || 7;
  d.setDate(d.getDate() - (dow - 1));
  return d;
}

function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.remove('is-visible'), 2400);
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

function bucketFor(serviceDate, grouping) {
  const d = parseServiceDate(serviceDate);
  if (grouping === 'day') {
    return { key: serviceDate, sortKey: serviceDate, date: d };
  }
  if (grouping === 'week') {
    const monday = mondayOf(d);
    const { isoYear, week } = isoWeekInfo(monday);
    const key = `${isoYear}-W${String(week).padStart(2, '0')}`;
    return { key, sortKey: key, date: monday, isoYear, week };
  }
  if (grouping === 'month') {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return { key, sortKey: key, date: new Date(d.getFullYear(), d.getMonth(), 1) };
  }
  // year
  const key = String(d.getFullYear());
  return { key, sortKey: key, date: new Date(d.getFullYear(), 0, 1) };
}

function labelFor(bucket, grouping, ambiguousWeekYears) {
  if (grouping === 'day') {
    const weekday = bucket.date.toLocaleDateString('de-DE', { weekday: 'short' });
    const dm = bucket.date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    return `${weekday} ${dm}.`;
  }
  if (grouping === 'week') {
    return ambiguousWeekYears ? `KW ${bucket.week} '${String(bucket.isoYear).slice(-2)}` : `KW ${bucket.week}`;
  }
  if (grouping === 'month') {
    return bucket.date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  }
  return bucket.key; // year
}

/** Enumerate every bucket key between start and end (inclusive) for zero-filling. */
function enumerateBuckets(grouping, start, end) {
  const out = [];
  if (grouping === 'day') {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (d <= end) {
      out.push(bucketFor(toServiceDate(d), 'day'));
      d.setDate(d.getDate() + 1);
    }
  } else if (grouping === 'week') {
    const d = mondayOf(start);
    const last = mondayOf(end);
    while (d <= last) {
      out.push(bucketFor(toServiceDate(d), 'week'));
      d.setDate(d.getDate() + 7);
    }
  } else if (grouping === 'month') {
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(end.getFullYear(), end.getMonth(), 1);
    while (d <= last) {
      out.push(bucketFor(toServiceDate(d), 'month'));
      d.setMonth(d.getMonth() + 1);
    }
  } else {
    const d = new Date(start.getFullYear(), 0, 1);
    const last = new Date(end.getFullYear(), 0, 1);
    while (d <= last) {
      out.push(bucketFor(toServiceDate(d), 'year'));
      d.setFullYear(d.getFullYear() + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function rangeStartDate(rangeValue) {
  if (rangeValue === 'all') return null;
  const opt = RANGE_OPTIONS.find((o) => o.value === rangeValue);
  const today = new Date();
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (opt.days) d.setDate(d.getDate() - (opt.days - 1));
  else if (opt.months) d.setMonth(d.getMonth() - opt.months);
  return d;
}

function metricValue(entry, metric) {
  if (metric === 'arrivalDelay') return lostTimeMin(entry);
  if (metric === 'extraTime') return extraTimeInTrainMin(entry);
  if (metric === 'actualDuration') return actualDurationMin(entry);
  return 1; // count
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const els = {};

function cacheEls() {
  const ids = [
    'appbarSub', 'emptySection', 'statsContent', 'kpiGrid',
    'chartTitle', 'periodChart', 'periodChartHint', 'histogramChart',
    'directionChart', 'worstTableBody', 'worstHint', 'tripsTableBody',
    'tripsEmptyHint', 'outOfRangeHint', 'cancelledHint', 'dataHint', 'importFile',
    'syncSection', 'syncCard',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function buildBarRow({ label, displayValue, value, maxAbs, severity }) {
  // An empty bucket (value 0, e.g. a month with no logged trips) must read as
  // visually empty. Omit the fill entirely rather than sizing it to 0 -- the
  // .bar-fill CSS min-width would otherwise still paint a coloured hairline
  // that looks like a small delay.
  const isEmpty = !(maxAbs > 0) || value === 0;
  const track = el('div', { className: 'bar-track' });
  if (!isEmpty) {
    const fill = el('div', { className: severity ? `bar-fill bar-fill--${severity}` : 'bar-fill' });
    fill.style.width = `${Math.max(2, Math.round((Math.abs(value) / maxAbs) * 100))}%`;
    track.appendChild(fill);
  }
  return el('div', { className: 'bar-row' }, [
    el('div', { className: 'bar-label', title: label, text: label }),
    track,
    el('div', { className: 'bar-value', text: displayValue }),
  ]);
}

function renderEmptyHint(container, text) {
  clear(container);
  container.appendChild(el('p', { className: 'hint', text }));
}

function stat(value, label, note) {
  const children = [
    el('div', { className: 'stat-value', text: value }),
    el('div', { className: 'stat-label', text: label }),
  ];
  if (note) children.push(el('div', { className: 'stat-note', text: note }));
  return el('div', { className: 'stat' }, children);
}

function directionLabel(id) {
  return DIRECTIONS[id]?.shortLabel || id;
}

function render() {
  const all = listEntries();

  // Independent of the trips data below, so it stays current even in the
  // empty state (and after a sync that pulls in the very first entries).
  renderSyncCard();

  if (all.length === 0) {
    els.emptySection.hidden = false;
    els.statsContent.hidden = true;
    els.appbarSub.textContent = 'Keine Daten erfasst';
    return;
  }
  els.emptySection.hidden = true;
  els.statsContent.hidden = false;

  updateControlStates();

  // --- Filtering stages -----------------------------------------------
  const rangeOpt = RANGE_OPTIONS.find((o) => o.value === prefs.range) || RANGE_OPTIONS[1];
  const startDate = rangeStartDate(prefs.range);
  const startService = startDate ? toServiceDate(startDate) : null;

  const rangeFiltered = all.filter((e) => !startService || e.serviceDate >= startService);
  const directionFiltered = rangeFiltered.filter((e) =>
    directionMatches(e.direction, { axis: prefs.axis, hub: prefs.hub })
  );
  const baseFiltered = directionFiltered; // range + direction, cancellations still included
  const statsFiltered =
    prefs.cancelledMode === 'exclude' ? baseFiltered.filter((e) => !e.cancelled) : baseFiltered;

  els.appbarSub.textContent = `${statsFiltered.length} Fahrten · ${rangeOpt.label}`;

  renderKpis(baseFiltered, statsFiltered);
  renderPeriodChart(statsFiltered, startDate);
  renderHistogram(statsFiltered);
  renderDirectionChart(rangeFiltered);
  renderWorstTrains(statsFiltered);
  renderTripsTable(statsFiltered);
  renderOutOfRangeHint(all.length - rangeFiltered.length);

  els.cancelledHint.textContent =
    prefs.cancelledMode === 'include'
      ? 'Ausgefallene Fahrten zählen mit ihrer erfassten Verspätung in alle Auswertungen -- nur bei der Pünktlichkeitsquote gelten sie als unpünktlich.'
      : 'Ausgefallene Fahrten werden aus allen Auswertungen, Diagrammen und der Tabelle entfernt (die Kennzahl „Ausfälle" berücksichtigt sie trotzdem).';
}

function renderKpis(baseFiltered, statsFiltered) {
  const grid = els.kpiGrid;
  clear(grid);

  const n = statsFiltered.length;
  const delays = statsFiltered.map(lostTimeMin);
  const extras = statsFiltered.map(extraTimeInTrainMin);
  const actualDurations = statsFiltered.map(actualDurationMin);
  const scheduledDurations = statsFiltered.map((e) => e.scheduledDurationMin || 0);

  const cancelledCount = baseFiltered.filter((e) => e.cancelled).length;
  const onTimeCount = statsFiltered.filter((e) => !e.cancelled && lostTimeMin(e) < 5).length;
  const punctuality = n ? Math.round((onTimeCount / n) * 100) : null;

  const lostSum = delays.reduce((a, b) => a + b, 0);
  const extraSum = extras.reduce((a, b) => a + b, 0);

  let worst = null;
  for (const e of statsFiltered) {
    if (!worst || lostTimeMin(e) > lostTimeMin(worst)) worst = e;
  }

  grid.appendChild(stat(String(n), 'Fahrten gesamt'));
  grid.appendChild(
    stat(n ? formatSignedMinutes(average(delays)) : '–', 'Ø Ankunftsverspätung')
  );
  grid.appendChild(stat(n ? formatMinutes(lostSum) : '–', 'Gesamte verlorene Zeit'));
  grid.appendChild(
    stat(
      punctuality === null ? '–' : `${punctuality} %`,
      'Pünktlichkeitsquote',
      '< 5 Min. Ankunftsverspätung, DB-Definition'
    )
  );
  grid.appendChild(stat(n ? formatSignedMinutes(median(delays)) : '–', 'Median-Verspätung'));
  grid.appendChild(
    stat(
      worst ? formatDelay(lostTimeMin(worst)) : '–',
      'Schlimmste Einzelverspätung',
      worst ? `${worst.line} ${worst.trainNumber} am ${parseServiceDate(worst.serviceDate).toLocaleDateString('de-DE')}` : ''
    )
  );
  grid.appendChild(
    stat(
      n ? formatMinutes(average(actualDurations)) : '–',
      'Ø tatsächliche Reisezeit',
      n ? `planmäßig ${formatMinutes(average(scheduledDurations))}` : ''
    )
  );
  grid.appendChild(stat(n ? formatMinutes(extraSum) : '–', 'Zusätzliche Zeit im Zug gesamt'));
  grid.appendChild(
    stat(
      String(cancelledCount),
      'Ausfälle',
      baseFiltered.length ? `${Math.round((cancelledCount / baseFiltered.length) * 100)} % aller Fahrten` : ''
    )
  );
}

function renderPeriodChart(entries, startDate) {
  const container = els.periodChart;
  clear(container);
  const metricOpt = METRIC_OPTIONS.find((o) => o.value === prefs.metric) || METRIC_OPTIONS[0];
  document.getElementById('chartTitle').textContent = `Verlauf: ${metricOpt.label}`;

  if (!entries.length) {
    renderEmptyHint(container, 'Keine Fahrten im gewählten Zeitraum.');
    els.periodChartHint.textContent = '';
    return;
  }

  const grouping = prefs.grouping;
  const sums = new Map(); // key -> { bucket, sum, count }
  for (const e of entries) {
    const b = bucketFor(e.serviceDate, grouping);
    const rec = sums.get(b.key) || { bucket: b, sum: 0, count: 0 };
    rec.sum += metricValue(e, prefs.metric);
    rec.count += 1;
    sums.set(b.key, rec);
  }

  // Determine the bucket range to (maybe) zero-fill: for a bounded range
  // (7d/30d/3m/12m) always extend to today so trailing gaps stay visible;
  // for "Gesamt" span exactly the logged data.
  const dataDates = entries.map((e) => parseServiceDate(e.serviceDate));
  const today = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const rangeStart = startDate || new Date(Math.min(...dataDates.map((d) => d.getTime())));
  const rangeEnd = startDate ? todayLocal : new Date(Math.max(...dataDates.map((d) => d.getTime())));

  const enumerated = enumerateBuckets(grouping, rangeStart, rangeEnd);
  let bucketList;
  let filledGaps = true;
  if (enumerated.length > 0 && enumerated.length <= MAX_FILLED_BUCKETS) {
    bucketList = enumerated.map((b) => ({ bucket: b, sum: (sums.get(b.key) || {}).sum || 0, count: (sums.get(b.key) || {}).count || 0 }));
  } else {
    filledGaps = false;
    bucketList = [...sums.values()];
  }
  bucketList.sort((a, b) => (a.bucket.sortKey < b.bucket.sortKey ? -1 : a.bucket.sortKey > b.bucket.sortKey ? 1 : 0));

  const ambiguousWeekYears = grouping === 'week' && new Set(bucketList.map((r) => r.bucket.isoYear)).size > 1;

  const values = bucketList.map((r) => (prefs.metric === 'count' ? r.count : r.count ? r.sum / r.count : 0));
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const useSeverity = prefs.metric === 'arrivalDelay' || prefs.metric === 'extraTime';

  bucketList.forEach((r, i) => {
    const value = values[i];
    const label = labelFor(r.bucket, grouping, ambiguousWeekYears);
    let displayValue;
    if (prefs.metric === 'count') displayValue = String(r.count);
    else if (prefs.metric === 'actualDuration') displayValue = r.count ? formatMinutes(value) : '–';
    else displayValue = r.count ? formatSignedMinutes(value) : '–';
    const severity = useSeverity && r.count ? delaySeverity(value) : undefined;
    container.appendChild(buildBarRow({ label, displayValue, value, maxAbs, severity }));
  });

  const groupingLabel = GROUPING_LABELS[grouping];
  els.periodChartHint.textContent = filledGaps
    ? `Gruppiert nach ${groupingLabel} · ${bucketList.length} Perioden, auch ohne Fahrten dargestellt.`
    : `Gruppiert nach ${groupingLabel} · ${bucketList.length} Perioden mit Fahrten (bei diesem Zeitraum werden leere Perioden ausgeblendet).`;
}

function renderHistogram(entries) {
  const container = els.histogramChart;
  clear(container);
  const running = entries.filter((e) => !e.cancelled);
  if (!running.length) {
    renderEmptyHint(container, 'Keine ausgewerteten Fahrten (ohne Ausfälle) im gewählten Zeitraum.');
    return;
  }

  const buckets = [
    { label: 'pünktlich (<5 Min.)', min: -Infinity, max: 5 },
    { label: '5-9 Min.', min: 5, max: 10 },
    { label: '10-14 Min.', min: 10, max: 15 },
    { label: '15-29 Min.', min: 15, max: 30 },
    { label: '30-59 Min.', min: 30, max: 60 },
    { label: '60+ Min.', min: 60, max: Infinity },
  ];
  const counts = buckets.map(() => 0);
  for (const e of running) {
    const d = lostTimeMin(e);
    const idx = buckets.findIndex((b) => d >= b.min && d < b.max);
    counts[idx >= 0 ? idx : 0] += 1;
  }
  const maxAbs = Math.max(1, ...counts);
  const repValues = [0, 5, 10, 15, 30, 60];
  buckets.forEach((b, i) => {
    container.appendChild(
      buildBarRow({
        label: b.label,
        displayValue: String(counts[i]),
        value: counts[i],
        maxAbs,
        severity: counts[i] ? delaySeverity(repValues[i]) : undefined,
      })
    );
  });

  const cancelledCount = entries.length - running.length;
  if (cancelledCount > 0) {
    container.appendChild(
      el('p', { className: 'hint', text: `${cancelledCount} ausgefallene Fahrt(en) sind hier nicht enthalten.` })
    );
  }
}

function renderDirectionChart(rangeFiltered) {
  const container = els.directionChart;
  clear(container);
  // Deliberately ignores the Richtung/Bahnhof filters -- this chart always
  // compares all four directions against each other, honouring only the
  // range and the cancellation toggle.
  const entries = prefs.cancelledMode === 'exclude' ? rangeFiltered.filter((e) => !e.cancelled) : rangeFiltered;
  if (!entries.length) {
    renderEmptyHint(container, 'Keine Fahrten im gewählten Zeitraum.');
    return;
  }
  const rows = DIRECTION_IDS.map((id) => {
    const group = entries.filter((e) => e.direction === id);
    const avg = group.length ? average(group.map(lostTimeMin)) : 0;
    return { id, count: group.length, avg };
  }).filter((r) => r.count > 0); // drop directions with zero trips rather than showing empty bars

  if (!rows.length) {
    renderEmptyHint(container, 'Keine Fahrten im gewählten Zeitraum.');
    return;
  }

  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.avg)));
  for (const r of rows) {
    const label = `${directionLabel(r.id)} (${r.count})`;
    const displayValue = formatSignedMinutes(r.avg);
    container.appendChild(
      buildBarRow({ label, displayValue, value: r.avg, maxAbs, severity: delaySeverity(r.avg) })
    );
  }
}

function renderWorstTrains(entries) {
  const tbody = els.worstTableBody;
  clear(tbody);
  const running = entries; // cancellations already resolved by the toggle upstream

  const groups = new Map();
  for (const e of running) {
    const key = `${e.direction}|${e.trainNumber}`;
    const rec = groups.get(key) || { line: e.line, trainNumber: e.trainNumber, direction: e.direction, delays: [] };
    rec.delays.push(lostTimeMin(e));
    groups.set(key, rec);
  }
  let list = [...groups.values()].map((g) => ({ ...g, count: g.delays.length, avg: average(g.delays) }));

  let note = '';
  const withEnough = list.filter((g) => g.count >= 2);
  if (withEnough.length) {
    list = withEnough;
  } else {
    note = 'Zu wenige Fahrten pro Verbindung für eine verlässliche Rangliste -- alle Einträge werden trotzdem gezeigt.';
  }
  list.sort((a, b) => b.avg - a.avg);
  list = list.slice(0, 6);

  if (!list.length) {
    tbody.appendChild(el('tr', {}, [el('td', { attrs: { colspan: '4' }, className: 'empty-text', text: 'Keine Daten.' })]));
  }

  for (const g of list) {
    const badge = el('span', {
      className: `badge badge--${delaySeverity(g.avg)}`,
      text: formatSignedMinutes(g.avg),
    });
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: `${g.line} ${g.trainNumber}` }),
        el('td', { text: directionLabel(g.direction) }),
        el('td', { className: 'num', text: String(g.count) }),
        el('td', { className: 'num' }, [badge]),
      ])
    );
  }
  els.worstHint.textContent = note;
}

function renderTripsTable(entries) {
  const tbody = els.tripsTableBody;
  clear(tbody);
  els.tripsEmptyHint.style.display = entries.length ? 'none' : '';

  for (const e of entries) {
    const dateText = parseServiceDate(e.serviceDate).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
    const delayCell = e.cancelled
      ? el('span', { className: 'badge badge--bad', text: 'Ausfall' })
      : el('span', { className: `badge badge--${delaySeverity(lostTimeMin(e))}`, text: formatDelay(lostTimeMin(e)) });

    // A stored Entry carries every field the sheet needs, so a trip stays
    // editable here long after it has dropped out of the tracker's live window.
    const editBtn = rowButton('✎', 'Verspätung ändern');
    editBtn.addEventListener('click', () => {
      openEntrySheet({
        train: e,
        onSaved: (_entry, { wasExisting }) => {
          toast(wasExisting ? 'Fahrt aktualisiert' : 'Fahrt gespeichert');
          render();
        },
        onDeleted: () => {
          toast('Fahrt gelöscht');
          render();
        },
        onError: (err) => toast(err.message),
      });
    });

    const delBtn = rowButton('✕', 'Fahrt löschen');
    delBtn.addEventListener('click', () => {
      if (!window.confirm(`Fahrt ${e.line} ${e.trainNumber} vom ${dateText} wirklich löschen?`)) return;
      try {
        deleteEntry(e.id);
      } catch (err) {
        toast(err.message);
        return;
      }
      toast('Fahrt gelöscht');
      render();
    });

    const noteCell = el('td', { text: e.note || '' });
    noteCell.style.maxWidth = '140px';
    noteCell.style.overflow = 'hidden';
    noteCell.style.textOverflow = 'ellipsis';
    noteCell.style.whiteSpace = 'nowrap';
    if (e.note) noteCell.title = e.note;

    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: dateText }),
        el('td', { text: directionLabel(e.direction) }),
        el('td', { text: `${e.line} ${e.trainNumber}` }),
        el('td', { text: toHHMM(e.scheduledDeparture) }),
        el('td', { className: 'num' }, [delayCell]),
        el('td', { className: 'num', text: e.cancelled ? '–' : formatMinutes(actualDurationMin(e)) }),
        noteCell,
        el('td', {}, [el('div', { className: 'row-actions' }, [editBtn, delBtn])]),
      ])
    );
  }
}

/**
 * Say so when the selected range is hiding trips. A trip logged via "Frühere
 * Fahrt nachtragen" can be older than the default „Letzte 30 Tage", and it is
 * not in the tracker's live window either -- without this it is stored and
 * synced but visible nowhere, which reads exactly like it was never saved.
 */
function renderOutOfRangeHint(hiddenCount) {
  const node = els.outOfRangeHint;
  if (!hiddenCount) {
    node.hidden = true;
    return;
  }
  node.textContent = hiddenCount === 1
    ? 'Eine weitere erfasste Fahrt liegt außerhalb des gewählten Zeitraums. Wähl „Gesamt", um sie zu sehen.'
    : `${hiddenCount} weitere erfasste Fahrten liegen außerhalb des gewählten Zeitraums. Wähl „Gesamt", um sie zu sehen.`;
  node.hidden = false;
}

/** A compact icon button sized for a table cell. */
function rowButton(glyph, label) {
  return el('button', {
    className: 'icon-btn icon-btn--sm',
    text: glyph,
    attrs: { type: 'button', 'aria-label': label, title: label },
  });
}

// ---------------------------------------------------------------------------
// Device sync card
// ---------------------------------------------------------------------------

function syncNotice(message) {
  return el('div', { className: 'notice' }, [
    el('span', { attrs: { 'aria-hidden': 'true' }, text: '⚠️' }),
    el('span', { text: message }),
  ]);
}

function syncButton(className, label, busyLabel, onClick) {
  const btn = el('button', {
    className,
    text: syncUi.busy ? busyLabel || label : label,
    attrs: { type: 'button' },
  });
  if (syncUi.busy) btn.disabled = true;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderSyncSignedIn(card) {
  const meta = getSyncMeta();
  const lastSync = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('de-DE') : 'noch nie';

  card.appendChild(
    el('div', { className: 'row-between' }, [
      el('div', { text: getSession()?.email || '' }),
      el('span', { className: 'badge badge--ok', text: 'angemeldet' }),
    ])
  );
  card.appendChild(el('p', { className: 'hint', text: `Letzte Synchronisierung: ${lastSync}` }));

  const btnRow = el('div', { className: 'btn-row' });
  btnRow.appendChild(syncButton('btn', 'Jetzt synchronisieren', 'Synchronisiere …', () => handleSync()));
  btnRow.appendChild(syncButton('btn btn--danger', 'Abmelden', 'Melde ab …', () => handleSignOut()));
  card.appendChild(btnRow);
}

function renderSyncCard() {
  const section = els.syncSection;
  const card = els.syncCard;
  if (!section || !card) return;

  if (!isSupabaseConfigured()) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  // Signing in happens at the auth gate, which covers the page whenever there
  // is no session -- so this card only ever has a signed-in state to show.
  if (!isSignedIn()) {
    section.hidden = true;
    return;
  }

  clear(card);
  if (syncUi.error) card.appendChild(syncNotice(syncUi.error));
  renderSyncSignedIn(card);
}

async function handleSync() {
  syncUi.error = '';
  syncUi.busy = 'sync';
  renderSyncCard();
  try {
    const result = await sync();
    toast(`Synchronisiert · ${result.count} Fahrten`);
    render(); // a pull can bring in entries logged on another device
  } catch (err) {
    syncUi.error = err.message;
  } finally {
    syncUi.busy = false;
    renderSyncCard();
  }
}

async function handleSignOut() {
  if (
    !window.confirm(
      'Wirklich abmelden? Lokal gespeicherte Fahrten bleiben erhalten, werden aber nicht mehr synchronisiert.'
    )
  ) {
    return;
  }
  syncUi.error = '';
  syncUi.busy = 'signout';
  renderSyncCard();
  try {
    await signOut(); // keeps dbt.entries.v1 -- the gate takes over from here
  } catch (err) {
    syncUi.error = err.message;
  } finally {
    syncUi.busy = false;
    renderSyncCard();
  }
}

// ---------------------------------------------------------------------------
// Controls wiring
// ---------------------------------------------------------------------------

function wireSegmented(containerId, prefsKey) {
  const container = document.getElementById(containerId);
  container.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-value]');
    if (!btn) return;
    prefs[prefsKey] = btn.dataset.value;
    savePrefs(prefs);
    render();
  });
}

function buildChips(containerId, options, prefsKey) {
  const container = document.getElementById(containerId);
  clear(container);
  for (const opt of options) {
    const btn = el('button', {
      className: 'chip',
      text: opt.label,
      attrs: { type: 'button', 'data-value': opt.value },
    });
    container.appendChild(btn);
  }
  container.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-value]');
    if (!btn) return;
    prefs[prefsKey] = btn.dataset.value;
    savePrefs(prefs);
    render();
  });
}

function updateActive(containerId, prefsKey, activeClass) {
  const container = document.getElementById(containerId);
  for (const btn of container.querySelectorAll('button[data-value]')) {
    btn.classList.toggle(activeClass, btn.dataset.value === prefs[prefsKey]);
  }
}

function updateControlStates() {
  updateActive('groupingControl', 'grouping', 'is-active');
  updateActive('rangeControl', 'range', 'is-active');
  updateActive('directionControl', 'axis', 'is-active');
  updateActive('hubControl', 'hub', 'is-active');
  updateActive('metricControl', 'metric', 'is-active');
  updateActive('cancelledControl', 'cancelledMode', 'is-active');
}

function wireDataManagement() {
  document.getElementById('exportBtn').addEventListener('click', () => {
    const text = exportJSON();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { attrs: { href: url, download: `dbt-export-${toServiceDate(new Date())}.json` } });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    els.dataHint.textContent = 'Export wurde als Download gestartet.';
  });

  document.getElementById('importBtn').addEventListener('click', () => {
    els.importFile.click();
  });

  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const count = importJSON(String(reader.result || ''));
        els.dataHint.textContent = `${count} Fahrt(en) importiert.`;
        toast('Import erfolgreich');
        render();
      } catch (err) {
        els.dataHint.textContent = err?.name === STORAGE_WRITE_ERROR
          ? `Import fehlgeschlagen: ${err.message}`
          : 'Import fehlgeschlagen: Datei hat ein unerwartetes Format.';
        console.error('[stats] import failed', err);
      } finally {
        els.importFile.value = '';
      }
    };
    reader.onerror = () => {
      els.dataHint.textContent = 'Import fehlgeschlagen: Datei konnte nicht gelesen werden.';
      els.importFile.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if (!window.confirm('Wirklich alle gespeicherten Fahrten löschen? Dies kann nicht rückgängig gemacht werden.')) return;
    try {
      clearAll();
    } catch (err) {
      toast(err.message);
      return;
    }
    toast('Alle Daten gelöscht');
    render();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  cacheEls();
  buildChips('rangeControl', RANGE_OPTIONS, 'range');
  buildChips('metricControl', METRIC_OPTIONS, 'metric');
  wireSegmented('groupingControl', 'grouping');
  wireSegmented('directionControl', 'axis');
  wireSegmented('hubControl', 'hub');
  wireSegmented('cancelledControl', 'cancelledMode');
  wireDataManagement();
  // A session ending (sign-out, or a refresh token the server rejected) raises
  // the auth gate over the page; clear the stale error so the card is clean if
  // the same user signs back in.
  onAuthChange((nextSession) => {
    if (!nextSession) syncUi.error = '';
    renderSyncCard();
  });

  // Trips logged on another device should turn up here on their own.
  startAutoSync();
  onSyncStateChange((event) => {
    if (event.status !== 'ok') return;
    // Re-rendering the trips table would rebuild the row the sheet was opened
    // from; the sheet holds its own copy of the entry, but the redraw is
    // pointless mid-edit and the save that follows triggers one anyway.
    if (event.result?.changed && !isEntrySheetOpen()) render();
    else renderSyncCard(); // otherwise just refresh the "last sync" line
  });
  render();
}

// The page stays locked until a session exists; init() runs once, on unlock.
initAuthGate({ onSignedIn: init });

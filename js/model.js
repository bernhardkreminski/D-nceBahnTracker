// Shared data model + pure helpers. Both pages and the API layer depend on this
// file for the exact shape of a Train and a logged Entry -- keep it in sync.

import { DIRECTIONS } from './config.js';

/**
 * @typedef {Object} Train  A concrete departure on a concrete day (not a template).
 * @property {string} id                  stable: `${direction}|${serviceDate}|${trainNumber}|${HH:MM}`
 * @property {string} line                e.g. "RE5"
 * @property {string} trainNumber         e.g. "79038"
 * @property {'RO_MU'|'MU_RO'} direction
 * @property {string} fromName
 * @property {string} toName
 * @property {string} serviceDate         "YYYY-MM-DD" (local)
 * @property {string} scheduledDeparture  ISO 8601
 * @property {string} scheduledArrival    ISO 8601
 * @property {number} scheduledDurationMin
 * @property {number|null} departureDelayMin  live delay, if the source reported one
 * @property {number|null} arrivalDelayMin    live delay, if the source reported one
 * @property {boolean} cancelled
 * @property {string|null} platform
 * @property {'transitous'|'dbf'|'static'} source
 */

/**
 * @typedef {Object} Entry  A delay the user logged for a Train. Persisted.
 * @property {string} id                  same id as the Train it belongs to
 * @property {string} line
 * @property {string} trainNumber
 * @property {'RO_MU'|'MU_RO'} direction
 * @property {string} fromName
 * @property {string} toName
 * @property {string} serviceDate
 * @property {string} scheduledDeparture
 * @property {string} scheduledArrival
 * @property {number} scheduledDurationMin
 * @property {number} departureDelayMin   minutes late leaving (0 = on time)
 * @property {number} arrivalDelayMin     minutes late arriving (0 = on time)
 * @property {boolean} cancelled
 * @property {string} note
 * @property {string} createdAt           ISO
 * @property {string} updatedAt           ISO
 */

export const MS_MIN = 60 * 1000;

/** Local "YYYY-MM-DD" for a Date (never UTC -- service days are local days). */
export function toServiceDate(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local "HH:MM". */
export function toHHMM(date) {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The one place a Train id is built. Every data source must call this so that
 * the same physical train always maps onto the same stored Entry.
 */
export function buildTrainId({ direction, serviceDate, trainNumber, scheduledDeparture }) {
  return `${direction}|${serviceDate}|${trainNumber || 'x'}|${toHHMM(scheduledDeparture)}`;
}

export function minutesBetween(fromIso, toIso) {
  return Math.round((new Date(toIso) - new Date(fromIso)) / MS_MIN);
}

/** Scheduled departure shifted by the live/logged departure delay. */
export function actualDeparture(item) {
  return new Date(new Date(item.scheduledDeparture).getTime() + (item.departureDelayMin || 0) * MS_MIN);
}

export function actualArrival(item) {
  return new Date(new Date(item.scheduledArrival).getTime() + (item.arrivalDelayMin || 0) * MS_MIN);
}

/** Minutes actually spent on board. */
export function actualDurationMin(item) {
  const scheduled = item.scheduledDurationMin ?? minutesBetween(item.scheduledDeparture, item.scheduledArrival);
  return scheduled + (item.arrivalDelayMin || 0) - (item.departureDelayMin || 0);
}

/** Extra minutes on board vs. the timetable (can be negative if time was made up). */
export function extraTimeInTrainMin(item) {
  return (item.arrivalDelayMin || 0) - (item.departureDelayMin || 0);
}

/** How much later than planned the user arrived -- the number that hurts. */
export function lostTimeMin(item) {
  return item.arrivalDelayMin || 0;
}

export function directionOf(item) {
  return DIRECTIONS[item.direction] || null;
}

/** Build a fresh Entry from a Train plus the user's input. */
export function entryFromTrain(train, { departureDelayMin = 0, arrivalDelayMin = 0, cancelled = false, note = '' } = {}) {
  const now = new Date().toISOString();
  return {
    id: train.id,
    line: train.line,
    trainNumber: train.trainNumber,
    direction: train.direction,
    fromName: train.fromName,
    toName: train.toName,
    serviceDate: train.serviceDate,
    scheduledDeparture: train.scheduledDeparture,
    scheduledArrival: train.scheduledArrival,
    scheduledDurationMin:
      train.scheduledDurationMin ?? minutesBetween(train.scheduledDeparture, train.scheduledArrival),
    departureDelayMin: Number(departureDelayMin) || 0,
    arrivalDelayMin: Number(arrivalDelayMin) || 0,
    cancelled: Boolean(cancelled),
    note: String(note || ''),
    createdAt: now,
    updatedAt: now,
  };
}

/** "12 Min." / "1 Std. 5 Min." */
export function formatMinutes(mins) {
  const m = Math.round(mins);
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(m);
  if (abs < 60) return `${sign}${abs} Min.`;
  const h = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest === 0 ? `${sign}${h} Std.` : `${sign}${h} Std. ${rest} Min.`;
}

/** Signed delay for display: "+5", "pünktlich", "-1". */
export function formatDelay(mins) {
  if (mins === null || mins === undefined) return '';
  const m = Math.round(mins);
  if (m === 0) return 'pünktlich';
  return m > 0 ? `+${m}` : `${m}`;
}

/** Severity bucket driving the colour of delay badges. */
export function delaySeverity(mins) {
  if (mins === null || mins === undefined) return 'muted';
  if (mins <= 0) return 'ok';
  if (mins < 5) return 'ok';
  if (mins < 15) return 'warn';
  return 'bad';
}

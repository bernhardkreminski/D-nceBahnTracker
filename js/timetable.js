// Offline fallback timetable for the RE5 (Meridian/BRB), Rosenheim <-> München Hbf.
// This is the last resort in the fetchTrains() cascade (see api.js) -- it never
// touches the network, so it always works even if both live sources are down.
//
// The times below are an approximate, hand-maintained clock-face pattern (NOT live
// data): RE5 runs roughly hourly all day in each direction, with a scheduled
// journey time of about 40-45 minutes. Real-world minutes drift a little through
// the day (peak-hour extra stops, crew changes, etc.) -- this is a plausible
// stand-in, not a scrape of the real timetable.

import { DIRECTIONS, WINDOW_HOURS } from './config.js';
import { buildTrainId, toServiceDate, minutesBetween, MS_MIN } from './model.js';

/**
 * Approximate hourly clock-face departures, local "HH:MM", no live data.
 *
 * The Ost variants are the same physical trains as the Hbf ones. Towards Munich
 * they leave Rosenheim at the same minute and simply reach Ost first, so the
 * departures are identical and only the runtime differs. Coming back they are a
 * separate departure roughly nine minutes after Hbf, because the train has to
 * travel Hbf -> Ost first.
 *
 * RB54 is the stopping service on the same corridor, so it takes a few minutes
 * longer than RE5 and carries its own runtime.
 */
const HOURS = ['04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14',
  '15', '16', '17', '18', '19', '20', '21', '22', '23'];

/** Hourly departures at a fixed minute, e.g. everyHour('33', 'RB54', 48). */
function everyHour(minute, line, durationMin) {
  return HOURS.map((h) => ({ time: `${h}:${minute}`, line, durationMin }));
}

export const STATIC_TIMETABLE = {
  RO_MU: [
    ...['04:35', '05:35', '06:32', '07:33', '08:32', '09:32', '10:32', '11:32',
      '12:32', '13:32', '14:32', '15:32', '16:32', '17:33', '18:32', '19:33',
      '20:32', '21:32', '22:32', '23:35'].map((time) => ({ time, line: 'RE5', durationMin: 45 })),
    ...everyHour('33', 'RB54', 48),
  ],
  RO_MO: [
    ...['04:35', '05:35', '06:32', '07:33', '08:32', '09:32', '10:32', '11:32',
      '12:32', '13:32', '14:32', '15:32', '16:32', '17:33', '18:32', '19:33',
      '20:32', '21:32', '22:32', '23:35'].map((time) => ({ time, line: 'RE5', durationMin: 37 })),
    ...everyHour('33', 'RB54', 39),
  ],
  MU_RO: [
    ...everyHour('39', 'RE5', 45),
    ...everyHour('36', 'RB54', 48),
  ],
  MO_RO: [
    ...everyHour('48', 'RE5', 37),
    ...everyHour('46', 'RB54', 39),
  ],
};

/** Local Date for `hh:mm` on the same calendar day as `baseDate`. */
function dateAtLocalTime(baseDate, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), h, m, 0, 0);
}

/**
 * Materialise the static timetable into concrete Train objects around `now`.
 * Every scheduled clock-face departure (either direction, or only `direction`
 * if given) with |departure - now| <= windowHours is returned. Pure, synchronous,
 * never throws -- this is the guaranteed-available fallback.
 *
 * @returns {import('./model.js').Train[]} sorted ascending by scheduledDeparture
 */
export function buildStaticTrains({ now = new Date(), windowHours = WINDOW_HOURS, direction = null } = {}) {
  const directions = direction ? [direction] : Object.keys(STATIC_TIMETABLE);
  const windowMs = windowHours * 60 * MS_MIN;
  const windowStart = now.getTime() - windowMs;
  const windowEnd = now.getTime() + windowMs;
  // Materialise yesterday/today/tomorrow's clock-face so departures near midnight
  // are still found when the +/- window straddles a day boundary.
  const dayOffsets = [-1, 0, 1];
  const trains = [];

  for (const dir of directions) {
    const dirInfo = DIRECTIONS[dir];
    const times = STATIC_TIMETABLE[dir] || [];
    if (!dirInfo) continue;
    for (const offset of dayOffsets) {
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      for (const entry of times) {
        const departureDate = dateAtLocalTime(base, entry.time);
        const departureTime = departureDate.getTime();
        if (departureTime < windowStart || departureTime > windowEnd) continue;

        const scheduledDeparture = departureDate.toISOString();
        const durationMin = entry.durationMin ?? dirInfo.typicalDurationMin ?? 45;
        const scheduledArrival = new Date(departureTime + durationMin * MS_MIN).toISOString();
        const serviceDate = toServiceDate(departureDate);

        trains.push({
          // No train number offline, so the line stands in for it -- otherwise
          // two lines leaving at the same minute would collide on one id.
          id: buildTrainId({ direction: dir, serviceDate, trainNumber: entry.line, scheduledDeparture }),
          line: entry.line,
          trainNumber: '',
          direction: dir,
          fromName: dirInfo.from.name,
          toName: dirInfo.to.name,
          serviceDate,
          scheduledDeparture,
          scheduledArrival,
          scheduledDurationMin: minutesBetween(scheduledDeparture, scheduledArrival),
          departureDelayMin: null,
          arrivalDelayMin: null,
          cancelled: false,
          platform: null,
          source: 'static',
        });
      }
    }
  }

  return trains.sort((a, b) => new Date(a.scheduledDeparture) - new Date(b.scheduledDeparture));
}

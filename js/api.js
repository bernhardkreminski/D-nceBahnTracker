// Live train data for the RE5 (Meridian/BRB), Rosenheim <-> München Hbf, with a
// three-tier fallback: transitous (journey planner, best) -> dbf.finalrewind.org
// (departure board, no destination arrival) -> js/timetable.js (offline, no
// network at all). fetchTrains() NEVER throws; it always resolves to a usable
// result and reports what happened via `degraded`/`error`.
//
// Per-train `source` tells the UI which tier that specific train came from (used
// to badge estimated arrival times). The top-level `source` reports the weakest
// tier contributing to the whole result ("worst source wins"), so the UI can show
// one global notice when any part of the picture is degraded.

import { STATIONS, DIRECTIONS, DIRECTION_IDS, WINDOW_HOURS, LINE_FILTER, FALLBACK_DURATION_MIN } from './config.js';
import { buildTrainId, toServiceDate, minutesBetween, MS_MIN } from './model.js';
import { buildStaticTrains } from './timetable.js';

const TRANSITOUS_BASE = 'https://api.transitous.org/api/v1';
const DBF_BASE = 'https://dbf.finalrewind.org';
const FETCH_TIMEOUT_MS = 10_000;
const TRANSITOUS_ITINERARIES_PER_PAGE = 20;
const TRANSITOUS_MAX_PAGES = 3; // per direction; one page normally covers the whole window

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** fetch() with a hard timeout, rejecting instead of hanging forever. */
async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a normalised "RE<n>" line name out of whatever a source calls it:
 * "BRB RE5" -> "RE5", "RE5 (79038)" -> "RE5", "RE RE1" -> "RE1", "RB54" -> null.
 */
function normaliseLine(raw) {
  const m = /RE\s?\d+/i.exec(raw || '');
  return m ? m[0].replace(/\s+/, '').toUpperCase() : null;
}

/** Merge several Train arrays, de-duplicate by id, sort ascending by departure. */
function mergeTrains(groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const train of group) {
      if (!byId.has(train.id)) byId.set(train.id, train);
    }
  }
  return Array.from(byId.values()).sort((a, b) => new Date(a.scheduledDeparture) - new Date(b.scheduledDeparture));
}

// ---------------------------------------------------------------------------
// Tier 1: transitous / MOTIS journey planner
// ---------------------------------------------------------------------------

/**
 * routeShortName like "RE5 (79038)" -> { line: "RE5", trainNumber: "79038" }.
 */
function parseTransitousRoute(routeShortName) {
  const raw = (routeShortName || '').trim();
  const numberMatch = /\((\d+)\)/.exec(raw);
  return { line: normaliseLine(raw), trainNumber: numberMatch ? numberMatch[1] : null };
}

/**
 * Fetch one direction's itineraries from transitous, keep only direct
 * (no-transfer) single-leg REGIONAL_RAIL journeys whose line passes LINE_FILTER,
 * and turn them into Train objects. Pages forward with pageCursor if the first
 * page doesn't yet reach the end of the window.
 */
async function fetchTransitousDirection(direction, now, windowHours) {
  const dir = DIRECTIONS[direction];
  const windowMs = windowHours * 60 * MS_MIN;
  const windowStart = now.getTime() - windowMs;
  const windowEnd = now.getTime() + windowMs;
  const anchorIso = new Date(windowStart).toISOString();

  const trains = [];
  const seenTripIds = new Set();
  let cursor = null;

  for (let page = 0; page < TRANSITOUS_MAX_PAGES; page += 1) {
    const url = cursor
      ? `${TRANSITOUS_BASE}/plan?fromPlace=${dir.from.lat},${dir.from.lon}&toPlace=${dir.to.lat},${dir.to.lon}` +
        `&pageCursor=${encodeURIComponent(cursor)}&numItineraries=${TRANSITOUS_ITINERARIES_PER_PAGE}`
      : `${TRANSITOUS_BASE}/plan?fromPlace=${dir.from.lat},${dir.from.lon}&toPlace=${dir.to.lat},${dir.to.lon}` +
        `&time=${encodeURIComponent(anchorIso)}&numItineraries=${TRANSITOUS_ITINERARIES_PER_PAGE}`;

    // eslint-disable-next-line no-await-in-loop -- pages must be fetched in order
    const data = await fetchJSON(url);
    const itineraries = Array.isArray(data.itineraries) ? data.itineraries : [];

    for (const itinerary of itineraries) {
      const railLegs = (itinerary.legs || []).filter((leg) => leg.mode !== 'WALK');
      // Only direct, single-train journeys: exactly one non-walking leg.
      if (railLegs.length !== 1) continue;
      const leg = railLegs[0];
      if (leg.mode !== 'REGIONAL_RAIL') continue; // excludes ICE/IC/EC/RJ/RJX/S-Bahn/subway/bus
      if (!leg.scheduledStartTime || !leg.scheduledEndTime) continue;

      const { line, trainNumber } = parseTransitousRoute(leg.routeShortName);
      if (!line || !LINE_FILTER.test(line)) continue;

      const scheduledDeparture = leg.scheduledStartTime;
      const departureTime = new Date(scheduledDeparture).getTime();
      if (departureTime < windowStart || departureTime > windowEnd) continue;

      const dedupeKey = leg.tripId || `${trainNumber}|${scheduledDeparture}`;
      if (seenTripIds.has(dedupeKey)) continue;
      seenTripIds.add(dedupeKey);

      const serviceDate = toServiceDate(scheduledDeparture);
      trains.push({
        id: buildTrainId({ direction, serviceDate, trainNumber, scheduledDeparture }),
        line,
        trainNumber: trainNumber || '',
        direction,
        fromName: dir.from.name,
        toName: dir.to.name,
        serviceDate,
        scheduledDeparture,
        scheduledArrival: leg.scheduledEndTime,
        scheduledDurationMin: minutesBetween(scheduledDeparture, leg.scheduledEndTime),
        departureDelayMin: leg.realTime ? minutesBetween(scheduledDeparture, leg.startTime) : null,
        arrivalDelayMin: leg.realTime ? minutesBetween(leg.scheduledEndTime, leg.endTime) : null,
        cancelled: Boolean(leg.cancelled),
        platform: leg.from?.track || leg.from?.scheduledTrack || null,
        source: 'transitous',
      });
    }

    const lastStart = itineraries.length ? new Date(itineraries[itineraries.length - 1].startTime).getTime() : null;
    cursor = data.nextPageCursor || null;
    if (!cursor || itineraries.length === 0) break;
    if (lastStart !== null && lastStart > windowEnd) break; // already past the window, no need for more pages
  }

  return trains;
}

/** Fetch both directions from transitous concurrently. Never throws. */
async function fetchTransitousBoth(now, windowHours) {
  const settled = await Promise.allSettled(
    DIRECTION_IDS.map((direction) => fetchTransitousDirection(direction, now, windowHours))
  );
  const byDirection = {};
  DIRECTION_IDS.forEach((direction, i) => {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      byDirection[direction] = result.value;
    } else {
      byDirection[direction] = [];
      console.warn(`[api] transitous fehlgeschlagen für ${direction}`, result.reason);
    }
  });
  return byDirection;
}

// ---------------------------------------------------------------------------
// Tier 2: dbf.finalrewind.org departure board
// ---------------------------------------------------------------------------

// Which substring in `destination`/`via` marks a departure as heading the right
// way. via lists only the stops still ahead, so this correctly excludes trains
// that already passed through the counterpart station earlier in their journey.
const COUNTERPART_NEEDLE = { RO_MU: 'münchen', MU_RO: 'rosenheim' };

function boardEntryMatchesDirection(dep, direction) {
  const needle = COUNTERPART_NEEDLE[direction];
  const haystack = [dep.destination, ...(Array.isArray(dep.via) ? dep.via : [])]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  return haystack.includes(needle);
}

/** Reconstruct a full local Date from dbf's date-less "HH:MM", handling midnight rollover. */
function reconstructLocalTime(now, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  const halfDayMs = 12 * 60 * MS_MIN;
  const diffMs = candidate.getTime() - now.getTime();
  if (diffMs < -halfDayMs) candidate.setDate(candidate.getDate() + 1);
  else if (diffMs > halfDayMs) candidate.setDate(candidate.getDate() - 1);
  return candidate;
}

/** Parse one station's departure board into Train objects for the given direction. */
function parseDbfBoard(data, direction, now, windowHours) {
  const dir = DIRECTIONS[direction];
  const departures = Array.isArray(data?.departures) ? data.departures : [];
  const windowMs = windowHours * 60 * MS_MIN;
  const windowStart = now.getTime() - windowMs;
  const windowEnd = now.getTime() + windowMs;
  const trains = [];

  for (const dep of departures) {
    if (!dep.scheduledDeparture) continue; // train terminates here, no onward departure to report
    const line = normaliseLine(dep.train);
    if (!line || !LINE_FILTER.test(line)) continue;
    if (!boardEntryMatchesDirection(dep, direction)) continue;

    const departureDate = reconstructLocalTime(now, dep.scheduledDeparture);
    const departureTime = departureDate.getTime();
    if (departureTime < windowStart || departureTime > windowEnd) continue;

    const scheduledDeparture = departureDate.toISOString();
    // The board has no arrival time at the destination station -- only estimate it.
    const scheduledArrival = new Date(departureTime + FALLBACK_DURATION_MIN * MS_MIN).toISOString();
    const serviceDate = toServiceDate(departureDate);
    const trainNumber = dep.trainNumber ? String(dep.trainNumber) : null;

    trains.push({
      id: buildTrainId({ direction, serviceDate, trainNumber, scheduledDeparture }),
      line,
      trainNumber: trainNumber || '',
      direction,
      fromName: dir.from.name,
      toName: dir.to.name,
      serviceDate,
      scheduledDeparture,
      scheduledArrival,
      scheduledDurationMin: FALLBACK_DURATION_MIN,
      departureDelayMin: typeof dep.delayDeparture === 'number' ? dep.delayDeparture : null,
      arrivalDelayMin: null, // unknown -- scheduledArrival above is only an estimate
      cancelled: Boolean(dep.isCancelled),
      platform: dep.platform || dep.scheduledPlatform || null,
      source: 'dbf',
    });
  }

  return trains;
}

/** Fetch both stations' boards concurrently and turn them into {RO_MU, MU_RO} trains. */
async function fetchDbfBoth(now, windowHours) {
  const [rosenheim, muenchen] = await Promise.allSettled([
    fetchJSON(`${DBF_BASE}/${STATIONS.ROSENHEIM.eva}.json`),
    fetchJSON(`${DBF_BASE}/${STATIONS.MUENCHEN_HBF.eva}.json`),
  ]);

  const byDirection = { RO_MU: [], MU_RO: [] };
  if (rosenheim.status === 'fulfilled') {
    byDirection.RO_MU = parseDbfBoard(rosenheim.value, 'RO_MU', now, windowHours);
  } else {
    console.warn('[api] dbf Rosenheim fehlgeschlagen', rosenheim.reason);
  }
  if (muenchen.status === 'fulfilled') {
    byDirection.MU_RO = parseDbfBoard(muenchen.value, 'MU_RO', now, windowHours);
  } else {
    console.warn('[api] dbf München fehlgeschlagen', muenchen.reason);
  }
  return byDirection;
}

// ---------------------------------------------------------------------------
// Error messages (German, human-readable)
// ---------------------------------------------------------------------------

function buildErrorMessage(sourcesUsed, missingDirections) {
  const dirLabels = missingDirections.map((d) => DIRECTIONS[d]?.shortLabel || d).join(' und ');
  if (sourcesUsed.has('static') && sourcesUsed.has('dbf')) {
    return (
      `Live-Reiseplaner (transitous) teilweise nicht verfügbar. Für ${dirLabels} werden Ersatzdaten ` +
      'verwendet, Ankunftszeiten dort sind geschätzt.'
    );
  }
  if (sourcesUsed.has('static')) {
    return `Live-Fahrplandaten nicht verfügbar. Für ${dirLabels} wird der hinterlegte Ersatzfahrplan angezeigt.`;
  }
  return (
    `Live-Reiseplaner (transitous) für ${dirLabels} nicht verfügbar -- Abfahrtstafel (dbf) wird ` +
    'verwendet, Ankunftszeiten dort sind geschätzt.'
  );
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Fetch upcoming RE5 trains for both directions within +/- windowHours of `now`.
 * Tries transitous first, fills any gap from dbf.finalrewind.org, and finally
 * falls back to the offline static timetable. Never throws.
 *
 * @returns {Promise<{trains: import('./model.js').Train[], source: 'transitous'|'dbf'|'static', degraded: boolean, error: string|null, fetchedAt: string}>}
 */
export async function fetchTrains({ now = new Date(), windowHours = WINDOW_HOURS } = {}) {
  const fetchedAt = new Date().toISOString();

  try {
    const transitousByDirection = await fetchTransitousBoth(now, windowHours);
    const missingDirections = DIRECTION_IDS.filter((d) => transitousByDirection[d].length === 0);

    if (missingDirections.length === 0) {
      return {
        trains: mergeTrains(DIRECTION_IDS.map((d) => transitousByDirection[d])),
        source: 'transitous',
        degraded: false,
        error: null,
        fetchedAt,
      };
    }

    // At least one direction came back empty from transitous -- try to fill the
    // gap from the departure-board fallback before resorting to the static plan.
    let dbfByDirection = { RO_MU: [], MU_RO: [] };
    try {
      dbfByDirection = await fetchDbfBoth(now, windowHours);
    } catch (err) {
      console.warn('[api] dbf-Fallback fehlgeschlagen', err);
    }

    const byDirection = {};
    const sourcesUsed = new Set();
    for (const d of DIRECTION_IDS) {
      if (transitousByDirection[d].length > 0) {
        byDirection[d] = transitousByDirection[d];
        sourcesUsed.add('transitous');
      } else if (dbfByDirection[d]?.length > 0) {
        byDirection[d] = dbfByDirection[d];
        sourcesUsed.add('dbf');
      } else {
        byDirection[d] = [];
      }
    }

    const stillMissing = DIRECTION_IDS.filter((d) => byDirection[d].length === 0);
    if (stillMissing.length > 0) {
      // Both live sources failed for at least one direction -- guarantee a
      // usable result from the offline timetable.
      for (const d of stillMissing) {
        byDirection[d] = buildStaticTrains({ now, windowHours, direction: d });
        sourcesUsed.add('static');
      }
    }

    const worstSource = ['static', 'dbf', 'transitous'].find((s) => sourcesUsed.has(s)) || 'static';
    return {
      trains: mergeTrains(DIRECTION_IDS.map((d) => byDirection[d])),
      source: worstSource,
      degraded: true,
      error: buildErrorMessage(sourcesUsed, missingDirections),
      fetchedAt,
    };
  } catch (err) {
    // Should be unreachable -- every branch above already catches its own
    // errors -- but fetchTrains() must never throw, so fall back completely.
    console.error('[api] unerwarteter Fehler, verwende Ersatzfahrplan', err);
    return {
      trains: buildStaticTrains({ now, windowHours }),
      source: 'static',
      degraded: true,
      error: 'Unerwarteter Fehler beim Laden der Fahrplandaten. Es wird der hinterlegte Ersatzfahrplan angezeigt.',
      fetchedAt,
    };
  }
}

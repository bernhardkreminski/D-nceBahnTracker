// Optional multi-device sync: localStorage stays the write path and the source
// of truth for rendering; Supabase is a sync target, never a read dependency.
// Logging a trip must never require a network round-trip or a session.
//
// Conflict model: entries are keyed by the stable train id from buildTrainId(),
// so per-id last-write-wins on `updatedAt` is well defined. `updatedAt` stays
// client-supplied so an offline edit keeps the time it was actually made.

import {
  loadEntries,
  listTombstones,
  pruneTombstones,
  listDirty,
  clearDirty,
  markAllDirty,
  replaceAll,
} from './storage.js';
import {
  isSupabaseConfigured,
  getSession,
  isSignedIn,
  onAuthChange,
  signUp as signUpRaw,
  signIn as signInRaw,
  signOut as signOutRaw,
  MIN_PASSWORD_LENGTH,
  selectRows,
  upsertRows,
  patchRows,
} from './supabase.js';

const TABLE = 'entries';
const META_KEY = 'dbt.sync.v1';
const PUSH_CHUNK = 500;
const PAGE_SIZE = 1000; // PostgREST's default ceiling

// Re-exported so the UI only ever imports from this module.
export { isSupabaseConfigured, getSession, isSignedIn, onAuthChange, MIN_PASSWORD_LENGTH };

// ---------------------------------------------------------------------------
// Sync metadata
// ---------------------------------------------------------------------------

function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMeta(patch) {
  const next = { ...readMeta(), ...patch };
  try {
    localStorage.setItem(META_KEY, JSON.stringify(next));
  } catch (err) {
    console.error('[sync] could not persist sync metadata', err);
  }
  return next;
}

export function getSyncMeta() {
  return readMeta();
}

// ---------------------------------------------------------------------------
// Auth wrappers
// ---------------------------------------------------------------------------

/**
 * A history logged before sync existed has nothing marking it dirty, so it would
 * silently never reach the server. Seed the whole set once on first sign-in.
 */
function seedDirtyOnce() {
  if (!readMeta().seeded) {
    markAllDirty();
    writeMeta({ seeded: true });
  }
}

export async function signUp(email, password) {
  const session = await signUpRaw(email, password);
  seedDirtyOnce();
  return session;
}

export async function signIn(email, password) {
  const session = await signInRaw(email, password);
  seedDirtyOnce();
  return session;
}

/** Signing out keeps local trips; it only stops them syncing. */
export async function signOut() {
  await signOutRaw();
  // Force a full pull next time: a different account must not inherit this
  // account's incremental cursor.
  writeMeta({ lastPulledAt: null, seeded: false });
}

// ---------------------------------------------------------------------------
// Row <-> Entry mapping
// ---------------------------------------------------------------------------

function rowToEntry(row) {
  return {
    id: row.id,
    line: row.line ?? '',
    trainNumber: row.train_number ?? '',
    direction: row.direction,
    fromName: row.from_name ?? '',
    toName: row.to_name ?? '',
    serviceDate: row.service_date,
    scheduledDeparture: row.scheduled_departure,
    scheduledArrival: row.scheduled_arrival,
    scheduledDurationMin: row.scheduled_duration_min ?? 0,
    departureDelayMin: row.departure_delay_min ?? 0,
    arrivalDelayMin: row.arrival_delay_min ?? 0,
    cancelled: Boolean(row.cancelled),
    note: row.note ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function entryToRow(entry, userId) {
  return {
    user_id: userId,
    id: entry.id,
    line: entry.line ?? '',
    train_number: entry.trainNumber ?? '',
    direction: entry.direction,
    from_name: entry.fromName ?? '',
    to_name: entry.toName ?? '',
    service_date: entry.serviceDate,
    scheduled_departure: entry.scheduledDeparture,
    scheduled_arrival: entry.scheduledArrival,
    scheduled_duration_min: entry.scheduledDurationMin ?? 0,
    departure_delay_min: entry.departureDelayMin ?? 0,
    arrival_delay_min: entry.arrivalDelayMin ?? 0,
    cancelled: Boolean(entry.cancelled),
    note: entry.note ?? '',
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    deleted_at: null,
  };
}

// ---------------------------------------------------------------------------
// Merge (unchanged from the original design -- the rule this app depends on)
// ---------------------------------------------------------------------------

/**
 * Merge two sides. Entries are keyed by train id, so a per-id last-write-wins on
 * `updatedAt` is well defined; a tombstone removes an entry only when the
 * deletion happened after that entry's last edit (so re-logging a deleted train
 * on another device still wins).
 */
export function mergeState(local, remote) {
  const deleted = {};
  for (const [id, when] of [...Object.entries(local.deleted || {}), ...Object.entries(remote.deleted || {})]) {
    if (!deleted[id] || new Date(when) > new Date(deleted[id])) deleted[id] = when;
  }

  const entries = {};
  const ids = new Set([...Object.keys(local.entries || {}), ...Object.keys(remote.entries || {})]);
  for (const id of ids) {
    const a = local.entries?.[id];
    const b = remote.entries?.[id];
    const winner = !a ? b : !b ? a : new Date(b.updatedAt || 0) > new Date(a.updatedAt || 0) ? b : a;
    if (!winner) continue;
    const tomb = deleted[id];
    if (tomb && new Date(tomb) >= new Date(winner.updatedAt || 0)) continue; // deletion is newer
    entries[id] = winner;
  }

  return { entries, deleted };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pullRemote(since) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const filters = [
      'select=*',
      'order=updated_at.asc',
      `limit=${PAGE_SIZE}`,
      `offset=${offset}`,
      ...(since ? [`updated_at=gt.${encodeURIComponent(since)}`] : []),
    ];
    // eslint-disable-next-line no-await-in-loop -- pages must be walked in order
    const page = await selectRows(TABLE, filters.join('&'));
    const batch = Array.isArray(page) ? page : [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const entries = {};
  const deleted = {};
  let maxUpdatedAt = since || null;
  for (const row of rows) {
    if (row.deleted_at) deleted[row.id] = row.deleted_at;
    else entries[row.id] = rowToEntry(row);
    if (!maxUpdatedAt || new Date(row.updated_at) > new Date(maxUpdatedAt)) maxUpdatedAt = row.updated_at;
  }
  return { entries, deleted, maxUpdatedAt };
}

// ---------------------------------------------------------------------------
// Public sync
// ---------------------------------------------------------------------------

async function runSync() {
  if (!isSupabaseConfigured()) throw new Error('Supabase ist in dieser Installation nicht konfiguriert.');
  const session = getSession();
  if (!session) throw new Error('Nicht angemeldet.');

  const meta = readMeta();
  const remote = await pullRemote(meta.lastPulledAt || null);

  const local = { entries: loadEntries(), deleted: pruneTombstones() };
  const merged = mergeState(local, remote);

  const localCount = Object.keys(local.entries).length;
  const pulled = Object.keys(remote.entries).length + Object.keys(remote.deleted).length;

  // Whether the merge actually altered what the pages render. Drives the
  // re-render after a background sync, so an automatic round that changed
  // nothing does not churn the UI.
  const changed = JSON.stringify(local.entries) !== JSON.stringify(merged.entries);

  replaceAll(merged.entries, merged.deleted);

  // Push only what is genuinely unsent, and only where the local side actually
  // won the merge -- re-sending a row the remote just supplied is a no-op write.
  const dirty = listDirty();
  const rowsToUpsert = [];
  const tombstonesToPush = [];
  for (const id of dirty) {
    const mergedEntry = merged.entries[id];
    const localEntry = local.entries[id];
    if (mergedEntry && localEntry && mergedEntry.updatedAt === localEntry.updatedAt) {
      rowsToUpsert.push(entryToRow(mergedEntry, session.userId));
    } else if (!mergedEntry && merged.deleted[id] && local.deleted[id]) {
      tombstonesToPush.push({ id, at: merged.deleted[id] });
    }
  }

  for (let i = 0; i < rowsToUpsert.length; i += PUSH_CHUNK) {
    // eslint-disable-next-line no-await-in-loop -- keep request sizes bounded
    await upsertRows(TABLE, rowsToUpsert.slice(i, i + PUSH_CHUNK));
  }

  // Soft deletes patch the existing row: once deleted locally the full row is
  // gone, and a row that never reached the server needs no deletion anyway.
  for (const { id, at } of tombstonesToPush) {
    // eslint-disable-next-line no-await-in-loop -- one small request per deletion
    await patchRows(TABLE, `id=eq.${encodeURIComponent(id)}`, { deleted_at: at, updated_at: at });
  }

  clearDirty(dirty);

  const at = new Date().toISOString();
  writeMeta({
    lastSyncAt: at,
    // The max updated_at actually seen, never Date.now(): a row written during
    // this round would otherwise be skipped forever.
    lastPulledAt: remote.maxUpdatedAt || meta.lastPulledAt || null,
  });

  return {
    count: Object.keys(merged.entries).length,
    pulled,
    pushed: rowsToUpsert.length + tombstonesToPush.length > 0,
    changed,
    at,
  };
}

// ---------------------------------------------------------------------------
// Coalescing + listeners
// ---------------------------------------------------------------------------

let inFlight = null;
const syncListeners = new Set();

/**
 * Subscribe to sync activity. Called with
 * `{ status: 'start' }`, `{ status: 'ok', result }` or `{ status: 'error', error }`.
 * Returns an unsubscribe function.
 */
export function onSyncStateChange(cb) {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}

function emit(event) {
  for (const cb of syncListeners) {
    try {
      cb(event);
    } catch (err) {
      console.warn('[sync] listener failed', err);
    }
  }
}

/**
 * Pull, merge, push. Safe to call repeatedly: concurrent callers share one
 * round rather than racing each other into duplicate writes. Any failure leaves
 * the dirty set intact so the next round retries.
 *
 * @returns {Promise<{count: number, pulled: number, pushed: boolean, changed: boolean, at: string}>}
 */
export function sync() {
  if (inFlight) return inFlight;
  emit({ status: 'start' });
  inFlight = runSync()
    .then((result) => {
      emit({ status: 'ok', result });
      return result;
    })
    .catch((err) => {
      emit({ status: 'error', error: err });
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Fire-and-forget sync used after a save; never rejects, never blocks the UI. */
export function syncInBackground() {
  if (!isSupabaseConfigured() || !isSignedIn()) return Promise.resolve(null);
  return sync().catch((err) => {
    console.warn('[sync] Hintergrund-Synchronisierung fehlgeschlagen', err);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Automatic background syncing
// ---------------------------------------------------------------------------

const AUTO_INTERVAL_MS = 3 * 60 * 1000;
const AUTO_MAX_BACKOFF_MS = 30 * 60 * 1000;
const AUTO_MIN_GAP_MS = 15 * 1000; // floor between rounds, whatever triggers them

let autoTimer = null;
let autoStarted = false;
let consecutiveFailures = 0;
let lastAttemptAt = 0;

function nextDelay() {
  // Back off after repeated failures so a device that is simply offline stops
  // retrying every few minutes, but recover immediately once one round works.
  const factor = Math.min(2 ** consecutiveFailures, AUTO_MAX_BACKOFF_MS / AUTO_INTERVAL_MS);
  return Math.min(AUTO_INTERVAL_MS * factor, AUTO_MAX_BACKOFF_MS);
}

function scheduleNext() {
  clearTimeout(autoTimer);
  if (!autoStarted) return;
  autoTimer = setTimeout(() => attemptAutoSync('interval'), nextDelay());
}

async function attemptAutoSync(reason) {
  if (!autoStarted || !isSupabaseConfigured() || !isSignedIn()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    scheduleNext(); // nothing to do until the 'online' event
    return;
  }
  if (Date.now() - lastAttemptAt < AUTO_MIN_GAP_MS && reason !== 'manual') {
    scheduleNext();
    return;
  }
  lastAttemptAt = Date.now();
  try {
    await sync();
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures += 1; // sync() already emitted the error to listeners
  } finally {
    scheduleNext();
  }
}

function handleVisibility() {
  if (document.visibilityState === 'visible') attemptAutoSync('visible');
}

function handleOnline() {
  consecutiveFailures = 0; // connectivity is back; drop the backoff
  attemptAutoSync('online');
}

/**
 * Keep this tab in step with the other devices: sync on start, whenever the tab
 * becomes visible again, when connectivity returns, and periodically while the
 * tab is open. Idempotent.
 */
export function startAutoSync() {
  if (autoStarted || !isSupabaseConfigured()) return;
  autoStarted = true;
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('online', handleOnline);
  attemptAutoSync('start');
}

export function stopAutoSync() {
  autoStarted = false;
  clearTimeout(autoTimer);
  document.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('online', handleOnline);
}

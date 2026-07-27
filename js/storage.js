// localStorage-backed persistence for logged delays.
// Single source of truth for saved Entries; both pages go through this module.

const KEY = 'dbt.entries.v1';

// Deleting locally must survive a sync round-trip: without a record of the
// deletion, a remote copy that still has the entry would resurrect it on the
// next merge. Tombstones (id -> ISO deletion time) let the merge compare a
// deletion against the entry's own updatedAt.
const DELETED_KEY = 'dbt.deleted.v1';

// Which local rows have not reached the server yet. This cannot be derived by
// comparing updatedAt against the last sync: saveEntry() stamps updatedAt = now,
// so everything the merge just pulled in would look unsent too.
const DIRTY_KEY = 'dbt.dirty.v1';

// Long enough that every device has realistically synced once, short enough that
// the tombstone list cannot grow without bound.
const TOMBSTONE_TTL_DAYS = 180;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('[storage] could not read entries, starting empty', err);
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
    return true;
  } catch (err) {
    console.error('[storage] could not persist entries', err);
    return false;
  }
}

/** @returns {Record<string, import('./model.js').Entry>} */
export function loadEntries() {
  return readAll();
}

/** All entries, newest scheduled departure first. */
export function listEntries() {
  return Object.values(readAll()).sort(
    (a, b) => new Date(b.scheduledDeparture) - new Date(a.scheduledDeparture)
  );
}

export function getEntry(id) {
  return readAll()[id] || null;
}

export function hasEntry(id) {
  return Boolean(readAll()[id]);
}

/** Insert or update. Preserves the original createdAt on update. */
export function saveEntry(entry) {
  const map = readAll();
  const existing = map[entry.id];
  map[entry.id] = {
    ...entry,
    createdAt: existing?.createdAt || entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeAll(map);
  markDirty([entry.id]);
  return map[entry.id];
}

export function deleteEntry(id) {
  const map = readAll();
  delete map[id];
  writeAll(map);
  recordTombstones([id]);
  markDirty([id]);
}

export function clearAll() {
  const ids = Object.keys(readAll());
  writeAll({});
  // The deletions still have to reach the server, so tombstone and dirty-mark
  // every removed id rather than silently dropping them.
  recordTombstones(ids);
  markDirty(ids);
}

export function exportJSON() {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries: readAll() }, null, 2);
}

/** Merge an exported file back in. Returns the number of entries imported. */
export function importJSON(text) {
  const parsed = JSON.parse(text);
  const incoming = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : parsed;
  if (!incoming || typeof incoming !== 'object') throw new Error('Unerwartetes Format');
  const map = readAll();
  const imported = [];
  for (const [id, entry] of Object.entries(incoming)) {
    if (entry && typeof entry === 'object' && entry.scheduledDeparture) {
      map[id] = entry;
      imported.push(id);
    }
  }
  writeAll(map);
  markDirty(imported); // imported trips still have to reach the server
  return imported.length;
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

function readMap(key, label) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`[storage] could not read ${label}`, err);
    return {};
  }
}

function writeMap(key, map, label) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch (err) {
    console.error(`[storage] could not persist ${label}`, err);
  }
}

function recordTombstones(ids) {
  if (!ids.length) return;
  const stones = readMap(DELETED_KEY, 'tombstones');
  const now = new Date().toISOString();
  for (const id of ids) stones[id] = now;
  writeMap(DELETED_KEY, stones, 'tombstones');
}

/** @returns {Record<string, string>} id -> ISO deletion time */
export function listTombstones() {
  return readMap(DELETED_KEY, 'tombstones');
}

/** Drop tombstones older than the TTL so the list cannot grow forever. */
export function pruneTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const stones = readMap(DELETED_KEY, 'tombstones');
  let changed = false;
  for (const [id, when] of Object.entries(stones)) {
    if (!(new Date(when).getTime() > cutoff)) {
      delete stones[id];
      changed = true;
    }
  }
  if (changed) writeMap(DELETED_KEY, stones, 'tombstones');
  return stones;
}

// ---------------------------------------------------------------------------
// Dirty set (ids not yet pushed to the server)
// ---------------------------------------------------------------------------

function markDirty(ids) {
  if (!ids || !ids.length) return;
  const dirty = readMap(DIRTY_KEY, 'dirty set');
  for (const id of ids) dirty[id] = true;
  writeMap(DIRTY_KEY, dirty, 'dirty set');
}

/** @returns {string[]} ids waiting to be pushed */
export function listDirty() {
  return Object.keys(readMap(DIRTY_KEY, 'dirty set'));
}

/** Mark ids as sent. Only ever called after a confirmed successful push. */
export function clearDirty(ids) {
  if (!ids || !ids.length) return;
  const dirty = readMap(DIRTY_KEY, 'dirty set');
  for (const id of ids) delete dirty[id];
  writeMap(DIRTY_KEY, dirty, 'dirty set');
}

/**
 * Mark everything currently stored as unsent. Used once on first sign-in so a
 * history logged before sync existed still reaches the server.
 */
export function markAllDirty() {
  markDirty(Object.keys(readAll()));
}

/**
 * Overwrite the whole local state at once. This is the merge write path, so it
 * deliberately does NOT touch the dirty set.
 */
export function replaceAll(entries, tombstones) {
  writeAll(entries && typeof entries === 'object' ? entries : {});
  if (tombstones && typeof tombstones === 'object') writeMap(DELETED_KEY, tombstones, 'tombstones');
}

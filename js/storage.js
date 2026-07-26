// localStorage-backed persistence for logged delays.
// Single source of truth for saved Entries; both pages go through this module.

const KEY = 'dbt.entries.v1';

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
  return map[entry.id];
}

export function deleteEntry(id) {
  const map = readAll();
  delete map[id];
  writeAll(map);
}

export function clearAll() {
  writeAll({});
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
  let count = 0;
  for (const [id, entry] of Object.entries(incoming)) {
    if (entry && typeof entry === 'object' && entry.scheduledDeparture) {
      map[id] = entry;
      count += 1;
    }
  }
  writeAll(map);
  return count;
}

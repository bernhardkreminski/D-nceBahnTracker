// Static configuration: stations, directions, tuning knobs.
// Station facts verified against dbf.finalrewind.org and api.transitous.org.

export const STATIONS = {
  ROSENHEIM: {
    key: 'ROSENHEIM',
    name: 'Rosenheim',
    short: 'Rosenheim',
    eva: '8000320',
    lat: 47.8558,
    lon: 12.1225,
  },
  MUENCHEN_HBF: {
    key: 'MUENCHEN_HBF',
    name: 'München Hbf',
    short: 'München Hbf',
    eva: '8000261',
    lat: 48.1402,
    lon: 11.5581,
  },
  MUENCHEN_OST: {
    key: 'MUENCHEN_OST',
    name: 'München Ost',
    short: 'München Ost',
    eva: '8000262',
    lat: 48.128,
    lon: 11.6036,
  },
};

// The two axes a connection can be filtered on: which way you are travelling,
// and which Munich station you use. RE5 calls at München Ost on its way to and
// from Hbf, so the same physical train serves both hubs -- but the journeys are
// genuinely different (Ost is ~8 minutes closer to Rosenheim), which is why each
// is its own direction with its own times and its own logged entries.
export const AXES = {
  TO_MUC: { id: 'TO_MUC', label: 'nach München' },
  TO_RO: { id: 'TO_RO', label: 'nach Rosenheim' },
};

export const HUBS = {
  HBF: { id: 'HBF', label: 'Hbf', station: STATIONS.MUENCHEN_HBF },
  OST: { id: 'OST', label: 'Ost', station: STATIONS.MUENCHEN_OST },
};

export const DIRECTIONS = {
  RO_MU: {
    id: 'RO_MU',
    label: 'Rosenheim → München Hbf',
    shortLabel: 'nach München Hbf',
    from: STATIONS.ROSENHEIM,
    to: STATIONS.MUENCHEN_HBF,
    axis: 'TO_MUC',
    hub: 'HBF',
    typicalDurationMin: 45,
  },
  RO_MO: {
    id: 'RO_MO',
    label: 'Rosenheim → München Ost',
    shortLabel: 'nach München Ost',
    from: STATIONS.ROSENHEIM,
    to: STATIONS.MUENCHEN_OST,
    axis: 'TO_MUC',
    hub: 'OST',
    typicalDurationMin: 37,
  },
  MU_RO: {
    id: 'MU_RO',
    label: 'München Hbf → Rosenheim',
    shortLabel: 'ab München Hbf',
    from: STATIONS.MUENCHEN_HBF,
    to: STATIONS.ROSENHEIM,
    axis: 'TO_RO',
    hub: 'HBF',
    typicalDurationMin: 45,
  },
  MO_RO: {
    id: 'MO_RO',
    label: 'München Ost → Rosenheim',
    shortLabel: 'ab München Ost',
    from: STATIONS.MUENCHEN_OST,
    to: STATIONS.ROSENHEIM,
    axis: 'TO_RO',
    hub: 'OST',
    typicalDurationMin: 37,
  },
};

export const DIRECTION_IDS = ['RO_MU', 'RO_MO', 'MU_RO', 'MO_RO'];

/** Direction ids matching an axis filter ('ALL' | 'TO_MUC' | 'TO_RO'). */
export function directionsForAxis(axis) {
  if (!axis || axis === 'ALL') return [...DIRECTION_IDS];
  return DIRECTION_IDS.filter((id) => DIRECTIONS[id].axis === axis);
}

/** Direction ids matching a hub filter ('ALL' | 'HBF' | 'OST'). */
export function directionsForHub(hub) {
  if (!hub || hub === 'ALL') return [...DIRECTION_IDS];
  return DIRECTION_IDS.filter((id) => DIRECTIONS[id].hub === hub);
}

/** Does a direction pass both filters? */
export function directionMatches(directionId, { axis = 'ALL', hub = 'ALL' } = {}) {
  const dir = DIRECTIONS[directionId];
  if (!dir) return false;
  if (axis !== 'ALL' && dir.axis !== axis) return false;
  if (hub !== 'ALL' && dir.hub !== hub) return false;
  return true;
}

// Trains are shown when |departure - now| <= WINDOW_HOURS.
export const WINDOW_HOURS = 2;

// Only Regional Express services are relevant for this commute.
export const LINE_FILTER = /^RE/i;

// Typical scheduled runtime, used only where a source gives no arrival time.
// Prefer DIRECTIONS[id].typicalDurationMin; this is the last-resort default.
export const FALLBACK_DURATION_MIN = 45;

export const APP_NAME = 'DänceBahnTracker';

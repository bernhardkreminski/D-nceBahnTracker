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
};

export const DIRECTIONS = {
  RO_MU: {
    id: 'RO_MU',
    label: 'Rosenheim → München Hbf',
    shortLabel: 'nach München',
    from: STATIONS.ROSENHEIM,
    to: STATIONS.MUENCHEN_HBF,
  },
  MU_RO: {
    id: 'MU_RO',
    label: 'München Hbf → Rosenheim',
    shortLabel: 'nach Rosenheim',
    from: STATIONS.MUENCHEN_HBF,
    to: STATIONS.ROSENHEIM,
  },
};

export const DIRECTION_IDS = ['RO_MU', 'MU_RO'];

// Trains are shown when |departure - now| <= WINDOW_HOURS.
export const WINDOW_HOURS = 2;

// Only Regional Express services are relevant for this commute.
export const LINE_FILTER = /^RE/i;

// Typical scheduled runtime, used only by the offline fallback timetable.
export const FALLBACK_DURATION_MIN = 45;

export const APP_NAME = 'DänceBahnTracker';

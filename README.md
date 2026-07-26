# DänceBahnTracker

Mobile-first web app to track commuter train delays on the **RE5** between
**Rosenheim** and **München Hbf**, and to see what those delays add up to.

Static site, no build step, no backend, no dependencies — plain HTML, CSS and
ES modules, hosted on GitHub Pages.

## Pages

**`index.html` — Fahrten (tracker)**
Lists RE trains in both directions that depart within ±2 hours of the current
time, with live delay information. Tapping a train opens a sheet to log the
delay: arrival delay (stepper plus one-tap quick picks), optional departure
delay, a cancellation flag and a note. Entries are saved immediately and
already-logged trains are marked in the list.

**`stats.html` — Statistik**
Evaluates the logged trips. Configurable by grouping (day / week / month /
year), time range, direction, chart metric and how cancellations are counted;
every setting is remembered. Shows KPIs (average and median delay, total lost
time, punctuality rate by DB's <5 min definition, worst single delay, actual vs.
scheduled travel time, extra time on board, cancellations), a per-period trend
chart, a delay histogram, a breakdown by direction, a ranking of the connections
that are late most often, and the individual trips. Data can be exported,
imported and deleted.

## Data sources

Live timetable and real-time data is fetched client-side, with a three-tier
fallback so the page is never empty:

1. **[transitous](https://transitous.org/)** (`api.transitous.org`, MOTIS) —
   journey planning with scheduled *and* real-time times. Preferred, because it
   yields true arrival times per train.
2. **[dbf.finalrewind.org](https://dbf.finalrewind.org/)** — departure board with
   live delays. Arrival times are estimated from the typical runtime, which the
   UI labels as `geschätzt`.
3. **`js/timetable.js`** — a hardcoded approximate RE5 timetable, used only when
   both live sources are unreachable. No delay data.

Both live services are free community projects without an SLA, so the fallback
chain matters in practice. When anything below tier 1 is in use, the page shows
a notice explaining what is degraded.

## Storage

Logged trips live in `localStorage` under `dbt.entries.v1` (stats preferences
under `dbt.stats.prefs.v1`). Nothing is sent to a server — the data stays in the
browser, so it is per-device. Use Export/Import on the statistics page to move it.

## Development

No toolchain required. Serve the directory over HTTP (ES modules do not work
from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

### Layout

| File | Purpose |
| --- | --- |
| `index.html`, `js/tracker.js` | Tracker page |
| `stats.html`, `js/stats.js` | Statistics page |
| `js/api.js` | Live data with the three-tier fallback |
| `js/timetable.js` | Offline fallback timetable |
| `js/model.js` | Shared `Train`/`Entry` shapes and derived metrics |
| `js/storage.js` | `localStorage` persistence |
| `js/config.js` | Stations, directions, time window |
| `css/app.css` | Design system shared by both pages |

`js/model.js` is the single source of truth for the data shapes and for derived
values (`actualDurationMin`, `extraTimeInTrainMin`, `lostTimeMin`); both pages
and the API layer depend on it, so change it deliberately.

# DänceBahnTracker

Mobile-first web app to track commuter train delays between **Rosenheim** and
Munich, and to see what those delays add up to.

Two lines are tracked, both run by BRB:

- **RE5** — the fast service, continuing to Salzburg
- **RB54** — the stopping service on the same corridor, continuing to Kufstein
  (a few minutes slower)

`RB58` also calls at Rosenheim but runs to Holzkirchen on a different corridor,
so it is deliberately excluded — `TRACKED_LINES` in
[js/config.js](js/config.js) is an explicit allowlist rather than a pattern.

Four connections are tracked: Rosenheim ↔ **München Hbf** and Rosenheim ↔
**München Ost**, each way. Both lines call at Ost on the way to and from Hbf, so
the same physical train serves both — but the journeys genuinely differ (Ost is
~8 minutes closer to Rosenheim, and coming back the Ost departure is ~9 minutes
after the Hbf one). Each is therefore its own connection with its own times and
its own logged trips, and both the tracker and the statistics can be filtered by
**Richtung** (nach München / nach Rosenheim) and **Bahnhof** (Hbf / Ost).

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
3. **`js/timetable.js`** — a hardcoded approximate RE5/RB54 timetable, used only when
   both live sources are unreachable. No delay data.

Both live services are free community projects without an SLA, so the fallback
chain matters in practice. When anything below tier 1 is in use, the page shows
a notice explaining what is degraded.

## Storage and sync

Logged trips live in `localStorage` and that stays the write path and the source
of truth for rendering — logging a trip never waits on the network, so the app
works on a train with no reception.

| Key | Contents |
| --- | --- |
| `dbt.entries.v1` | the logged trips |
| `dbt.deleted.v1` | tombstones (id → deletion time), so a delete survives a sync |
| `dbt.dirty.v1` | ids not yet pushed to the server |
| `dbt.stats.prefs.v1` | statistics page settings |
| `dbt.sync.v1` | last sync time and the incremental pull cursor |
| `dbt.auth.v1` | the Supabase session (access + refresh token) |

**Signing in is required.** Both pages stay behind an auth gate
([js/auth-gate.js](js/auth-gate.js)) until a session exists, and trips sync
across devices through Supabase.

The gate checks for a *session*, not for connectivity — deliberately, since the
point of the app is logging a delay on a train with no reception. A device that
has signed in once opens straight into the app and keeps working offline; only a
device that has never signed in, or that signed out, sees the login screen. If
the server later rejects the stored session, the gate comes back up and local
trips are kept, never wiped.

(If a fork of this repo has no Supabase project configured, the gate steps aside
rather than locking everyone out, and the app runs as a purely local tracker.)

Sign-in is a password rather than an e-mailed code, which the original plan
called for. Supabase's free tier locks the e-mail templates behind custom SMTP —
so the 6-digit `{{ .Token }}` cannot be put into the mail — and caps sending at
**two e-mails per hour** project-wide, which a single retry would exhaust.
Password sign-in sends no mail at all. There is consequently **no password-reset
e-mail either**: keep the password in a password manager. If it is lost, set a
new one from the Supabase dashboard under Authentication → Users.

Conflicts resolve per trip, keyed by the stable train id from `buildTrainId()`:
the copy with the newer client-supplied `updatedAt` wins, and a deletion only
wins if it happened after the entry's last edit — so re-logging a train you
deleted on another device keeps it.

### When it syncs

Syncing is automatic; the manual button on the statistics page is only a
fallback. A round runs:

- immediately after logging, editing or deleting a trip,
- on sign-in,
- when a page opens,
- whenever the tab becomes visible again,
- when connectivity returns (the `online` event),
- and every 3 minutes while a tab is open.

Concurrent triggers share a single round rather than racing each other, and
rounds are never closer together than 15 seconds. Repeated failures back off
exponentially to a maximum of 30 minutes, so a device that is simply offline
stops retrying pointlessly; one success — or the `online` event — resets it
immediately. While `navigator.onLine` is false no request is attempted at all.

When a round pulls in something new, the open page re-renders itself. The
tracker deliberately holds that redraw back while the delay sheet is open, so a
background sync can never move the form under you mid-edit.

### Enabling sync

1. Create a Supabase project. From **Project Settings → API Keys** note the
   **Project URL** and the **publishable** (anon) key, and put both into
   [js/supabase.js](js/supabase.js). That key is safe to commit: it only
   identifies the project, and the row-level-security policy below is what
   actually protects the data. Never commit the **secret** key.
2. **Authentication → Sign In / Providers → Email**: enabled (it is by default).
3. Same page, turn **Confirm email off**. With it on, signing up would need a
   confirmation mail, and the free tier's two-mails-per-hour cap makes that
   fragile. Off, `signup` returns a usable session immediately.
4. **Authentication → URL Configuration → Site URL**:
   `https://bernhardkreminski.github.io/D-nceBahnTracker/`
5. Run the SQL below in the SQL editor.
6. Create the account once on the app's own login screen — open the site and
   choose **Registrieren**. Then turn **Allow new users to sign up** off, so no
   one else can create an account in the project.

```sql
create table public.entries (
  user_id                uuid        not null references auth.users(id) on delete cascade,
  id                     text        not null,   -- buildTrainId(), stable per train
  line                   text,
  train_number           text,
  direction              text        not null,   -- 'RO_MU' | 'MU_RO'
  from_name              text,
  to_name                text,
  service_date           date        not null,
  scheduled_departure    timestamptz not null,
  scheduled_arrival      timestamptz not null,
  scheduled_duration_min int,
  departure_delay_min    int         not null default 0,
  arrival_delay_min      int         not null default 0,
  cancelled              boolean     not null default false,
  note                   text        not null default '',
  created_at             timestamptz not null,
  updated_at             timestamptz not null,   -- client-supplied, drives the merge
  deleted_at             timestamptz,            -- soft delete
  primary key (user_id, id)
);

create index entries_user_updated_idx on public.entries (user_id, updated_at desc);

alter table public.entries enable row level security;

create policy "own rows only" on public.entries
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

Verify the policy is active before the first real write:

```sql
select * from pg_policies where tablename = 'entries';
```

Do **not** add a trigger that overwrites `updated_at`. It is deliberately
client-supplied so an offline edit keeps the time it was actually made; a
server-side timestamp would break the merge.

> Free-tier note: a Supabase project pauses after roughly a week without
> traffic. Daily use keeps it awake; after a longer break it needs one click on
> **Restore** in the dashboard. A sync failing right after a holiday is usually
> this, not a bug — the app says so in the error message.

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
| `js/auth-gate.js` | Sign-in gate that locks both pages until a session exists |
| `js/storage.js` | `localStorage` persistence, tombstones, dirty set |
| `js/supabase.js` | Project credentials, e-mail OTP auth, REST access |
| `js/sync.js` | Pull/merge/push round and the conflict rules |
| `js/config.js` | Stations, directions, time window |
| `css/app.css` | Design system shared by both pages |

`js/model.js` is the single source of truth for the data shapes and for derived
values (`actualDurationMin`, `extraTimeInTrainMin`, `lostTimeMin`); both pages
and the API layer depend on it, so change it deliberately.

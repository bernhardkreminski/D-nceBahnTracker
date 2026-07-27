# Implementation plan: multi-device sync via Supabase

Replaces the current GitHub-Gist sync (`js/sync.js`, uncommitted) with an
account-based backend so logged trips sync across devices.

**Status:** not started. Everything below is design, not code.

---

## 1. Goal and non-goals

**Goal.** The same logged trips on phone, tablet and desktop, behind a real
login, with the app still fully usable offline on the train.

**Non-goals.**

- Multi-user / shared data. One account, one person's trips. The schema is
  per-user, but no sharing UI.
- Realtime push. A sync on save plus a manual button is enough; do **not** wire
  up Supabase Realtime subscriptions.
- Server-side aggregation. `js/stats.js` keeps computing everything in the
  browser from `js/storage.js`.
- A build step. The project has none and must keep none.

---

## 2. Architecture

Offline-first stays. **`localStorage` remains the write path and the source of
truth for rendering**; Supabase is a sync target, never a read dependency.
Saving a trip must not require a network round-trip or a session.

```
tracker.js / stats.js  ──►  storage.js (localStorage)   ← rendering reads here
                                  │
                                  ▼
                             sync.js  ──►  Supabase (Postgres + Auth)
```

The conflict model does not change: entries are keyed by the stable train id
from `buildTrainId()` in [js/model.js](js/model.js), so per-id last-write-wins on
`updatedAt` is well defined. **`mergeState()` at [js/sync.js:124](js/sync.js:124)
is correct and must be carried over as-is** — only the transport around it is
replaced. Its tombstone rule (a deletion wins only if it is newer than the
entry's last edit) still applies.

`updatedAt` stays **client-supplied**, because offline edits must keep the
timestamp of the moment they were made, not of the later upload. This makes the
merge sensitive to clock skew between devices; that is an accepted trade for a
single-user app. Do not add a database trigger that overwrites `updated_at`.

---

## 3. Manual setup (the repo owner does this, not the agent)

The agent cannot do these steps; write them into the README and stop for the
values.

1. Create a Supabase project. Note the **Project URL** and the **anon /
   publishable key**.
2. **Auth → Providers → Email**: enable. Leave e-mail confirmation on — the OTP
   flow below doubles as the confirmation.
3. **Use a 6-digit e-mail code, not a magic link.** Magic links open in the
   phone's default browser, which is frequently not the browser holding the
   half-finished session, and the login silently lands in the wrong place. Under
   **Auth → Email Templates → Magic Link**, replace the `{{ .ConfirmationURL }}`
   link with `{{ .Token }}` so the mail delivers a code.
4. **Auth → URL Configuration → Site URL**:
   `https://bernhardkreminski.github.io/D-nceBahnTracker/`
   (only needed for link-based flows, but set it so nothing falls back to
   `localhost`).
5. Run the SQL in §4 in the SQL editor.
6. Create the account once via the app's own sign-in form.

> Free-tier note: a Supabase project pauses after roughly a week with no
> traffic. Daily use keeps it awake; after a long holiday it needs one click in
> the dashboard to restore. Surface this in the README so a failing sync after a
> break isn't mistaken for a bug.

---

## 4. Schema

```sql
create table public.entries (
  user_id               uuid        not null references auth.users(id) on delete cascade,
  id                    text        not null,   -- buildTrainId(), stable per train
  line                  text,
  train_number          text,
  direction             text        not null,   -- 'RO_MU' | 'MU_RO'
  from_name             text,
  to_name               text,
  service_date          date        not null,
  scheduled_departure   timestamptz not null,
  scheduled_arrival     timestamptz not null,
  scheduled_duration_min int,
  departure_delay_min   int         not null default 0,
  arrival_delay_min     int         not null default 0,
  cancelled             boolean     not null default false,
  note                  text        not null default '',
  created_at            timestamptz not null,
  updated_at            timestamptz not null,   -- client-supplied, drives the merge
  deleted_at            timestamptz,            -- soft delete = the old tombstone
  primary key (user_id, id)
);

create index entries_user_updated_idx on public.entries (user_id, updated_at desc);

alter table public.entries enable row level security;

create policy "own rows only" on public.entries
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

The anon key is safe in the public repo — it identifies the project, it does not
grant access. The RLS policy above is what protects the data, so **verify it is
active before the first real write** (`select * from pg_policies where tablename
= 'entries';`).

`deleted_at` replaces the remote half of the tombstone map. Local tombstones in
`dbt.deleted.v1` stay exactly as they are — `mergeState()` needs them.

---

## 5. Files

| File | Change |
| --- | --- |
| `js/vendor/supabase.js` | **new** — vendored ESM build of `@supabase/supabase-js@2` |
| `js/supabase.js` | **new** — project URL + anon key, client singleton |
| `js/sync.js` | **rewritten** — same exported surface, Supabase transport |
| `js/storage.js` | small addition — a dirty-id set |
| `js/stats.js` | sync card UI swapped for auth UI |
| `js/tracker.js` | **unchanged** |
| `stats.html` | section title text only |
| `README.md` | Storage section rewritten |

### Vendor the SDK, do not hot-link a CDN

The app has to work on a train with no reception. An `import` from `esm.sh` at
module-evaluation time turns a flaky connection into a blank page, and it adds a
third-party runtime dependency to a project that currently has zero. Download
the bundle once and commit it:

```sh
curl -L "https://esm.sh/@supabase/supabase-js@2?bundle&target=es2022" -o js/vendor/supabase.js
```

Pin the exact version that resolves (check the header comment in the downloaded
file) and record it in the README. Confirm it is a single self-contained file
with no further remote `import`s — if `?bundle` still emits externals, re-fetch
with `&external=none` or use the `dist/module` build from npm.

---

## 6. `js/sync.js` — required exports

**Keep the public surface stable so `js/tracker.js` needs no edit.** It imports
`syncInBackground` only ([js/tracker.js:17](js/tracker.js:17), called at
[:413](js/tracker.js:413) and [:423](js/tracker.js:423)) and that contract —
fire-and-forget, never rejects, instant no-op when signed out — must hold.

```js
// auth
export async function sendCode(email)          // signInWithOtp({ email })
export async function verifyCode(email, code)  // verifyOtp({ type: 'email' })
export async function signOut()
export function getSession()                   // cached session or null
export function isSignedIn()
export function onAuthChange(cb)               // so the card re-renders on refresh/expiry

// data
export async function sync()                   // { count, pulled, pushed, at }
export function syncInBackground()             // never rejects
export { mergeState }                          // carried over unchanged
```

`sync()` keeps its existing return shape so the toasts in `js/stats.js` still
work.

### Client construction (`js/supabase.js`)

```js
createClient(URL, ANON_KEY, {
  auth: {
    persistSession: true,      // survives reloads; supabase-js uses localStorage
    autoRefreshToken: true,
    detectSessionInUrl: false, // we use OTP codes, never a link redirect
  },
})
```

### The sync round

1. Bail out immediately if there is no session (`syncInBackground` must not
   throw, must not await a network call).
2. **Pull** rows with `updated_at > lastPulledAt` (from `dbt.sync.v1`), all
   columns, including soft-deleted ones. First run: no filter, pull everything.
3. Map snake_case rows → the camelCase `Entry` shape in
   [js/model.js](js/model.js). Rows with `deleted_at` become tombstone entries,
   not entries.
4. `mergeState(local, remote)` → `replaceAll(merged.entries, merged.deleted)`
   ([js/storage.js:143](js/storage.js:143)).
5. **Push** only dirty ids (§7): `upsert` on conflict `(user_id, id)`, in
   chunks of ~500. Dirty ids that the merge resolved in the remote's favour are
   dropped from the push — pushing them back would be a no-op write.
6. On success: clear the dirty set, store `lastPulledAt` (use the max
   `updated_at` seen, **not** `Date.now()`, so a row written during the round is
   not skipped) and `lastSyncAt`.

Any failure leaves the dirty set intact so the next round retries. Never clear
it optimistically.

### Errors

Keep the German user-facing messages and the shape of `describeHttpError()` at
[js/sync.js:81](js/sync.js:81). Map at minimum: no session / expired session,
offline (`navigator.onLine === false` or a fetch TypeError), RLS rejection, and
a paused project (fetch failure against a reachable host) — the last one should
say the project may need restoring in the dashboard.

---

## 7. `js/storage.js` — dirty-id set

The only change to this file. Needed because "which local rows are unsent" is
otherwise unknowable: `saveEntry` stamps `updatedAt = now`, so comparing against
`lastSyncAt` would also re-push everything the merge just pulled in.

Add alongside the existing keys:

```js
const DIRTY_KEY = 'dbt.dirty.v1';   // { [id]: true }
```

- `saveEntry()` ([:59](js/storage.js:59)) and `deleteEntry()`
  ([:71](js/storage.js:71)) mark the id dirty.
- `clearAll()` ([:78](js/storage.js:78)) marks every removed id dirty (it
  already tombstones them all — mirror that loop).
- `replaceAll()` ([:143](js/storage.js:143)) must **not** touch the dirty set;
  it is the merge write path.
- `importJSON()` ([:153](js/storage.js:153)) marks every imported id dirty.
- New exports: `listDirty()`, `clearDirty(ids)`.

Follow the file's existing style: a `readX`/`writeX` pair wrapped in try/catch
that degrades to `{}` rather than throwing.

---

## 8. `js/stats.js` — auth card

Replaces the whole "GitHub sync card" region, [js/stats.js:626–870](js/stats.js:626).
Reuse the structure that is already there — it is sound: a module-level
`syncUi` object for transient state (so an unrelated re-render doesn't wipe a
half-typed form), `renderSyncCard()` dispatching on connection state, and
`render()` calling it at [:328](js/stats.js:328).

Update the import at [js/stats.js:17](js/stats.js:17).

Three states instead of two:

- **Signed out** — explanatory text, e-mail field, „Code senden".
- **Code sent** — the e-mail shown read-only, a 6-digit field
  (`inputmode="numeric"`, `autocomplete="one-time-code"` so iOS offers the code
  from the Mail app), „Anmelden", and a „Andere E-Mail" escape.
- **Signed in** — e-mail, last sync time, „Jetzt synchronisieren", „Abmelden".

Keep `syncUi.busy` guarding the buttons and `syncUi.error` rendering into the
existing `.notice` block. Sign-out must warn — via the existing
`window.confirm` pattern at [:865](js/stats.js:865) — that local trips are kept
but no longer sync, and must **not** clear `dbt.entries.v1`.

Subscribe to `onAuthChange` so an expired session flips the card without a
reload.

Copy in `stats.html`: change the section title at `#syncSection` from
„Geräte-Sync (GitHub)" to „Geräte-Sync". The empty `#syncCard` div and the
comment above it stay — the card is still built entirely in JS.

All new user-facing strings in German, matching the existing tone.

---

## 9. Removing the Gist implementation

Delete it wholesale; there is no migration to write. The Gist sync was never
committed, and if any data already sits in a gist, Export/Import on the stats
page covers moving it. Remove `verifyToken`, `createGist`, `githubFetch`, the
`dbt.sync.v1` token/gistId shape and every GitHub string. Nothing may read a
GitHub token afterwards — grep for `github`, `gist`, `token` when done.

Existing local trips need one piece of care. They were saved before the dirty
set existed, so nothing marks them as unsent. **On the first successful
sign-in, seed the dirty set with every id currently in `dbt.entries.v1`** —
without this, the entire pre-existing history silently never reaches the
server. This is the single easiest thing to get wrong in this plan.

---

## 10. Verification

No test framework exists in this repo, so this is a manual checklist. Serve with
`python3 -m http.server 8000`.

1. Sign in on browser A, log a trip, confirm the row appears in the Supabase
   table editor with the right `user_id`.
2. Sign in on browser B (a private window is enough) — the trip appears after a
   sync.
3. Delete on A, sync B → gone on B, row has `deleted_at`.
4. Re-log the same train on B after deleting on A → it comes back and stays
   back (this is the tombstone-vs-`updatedAt` rule; it is the case most likely
   to be broken by a careless rewrite of the merge).
5. Edit the same train offline on both, then sync both → newer `updatedAt`
   wins, no duplicate row.
6. **Offline**: DevTools offline, log three trips, confirm the UI never blocks
   and no error toast appears; go online, sync, all three land.
7. Sign out → local trips still render; sign in again → nothing duplicated.
8. In the SQL editor, `select` the table as a second user (or with RLS forced)
   and confirm zero rows are visible.
9. Existing pre-sign-in trips get pushed on first sign-in (§9).

---

## 11. Order of work

1. Manual Supabase setup + schema (§3, §4) — blocks everything.
2. Vendor the SDK, add `js/supabase.js` (§5).
3. Dirty set in `js/storage.js` (§7) — small, isolated, testable alone.
4. Rewrite `js/sync.js` (§6), carrying `mergeState()` over verbatim.
5. Auth card in `js/stats.js` (§8) + `stats.html` title.
6. First-sign-in seeding (§9) — do not skip.
7. README Storage section.
8. Walk the checklist (§10).

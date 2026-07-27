// Minimal Supabase client: e-mail OTP auth + PostgREST access over plain fetch.
//
// Deliberately not the supabase-js SDK. The app has to work on a train with no
// reception, so a CDN import is out; and vendoring the SDK means ~260 kB of
// bundles plus hand-patched import paths for its node polyfills, pulling in
// realtime/storage/functions code this app never uses. Everything needed here is
// four REST endpoints, so this file keeps the project's zero-dependency property.

// ---------------------------------------------------------------------------
// Project configuration
// ---------------------------------------------------------------------------
//
// Fill these in from the Supabase dashboard: Project Settings -> Data API.
// The anon key is safe to commit -- it only identifies the project. Access is
// governed by the row-level-security policy on public.entries, so that policy
// MUST be active before the first real write.

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

/** False until the two values above are filled in; the UI stays hidden then. */
export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

const SESSION_KEY = 'dbt.auth.v1';
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_MS = 60_000; // refresh a token that expires within a minute

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Session
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt   epoch ms
 * @property {string} userId
 * @property {string} email
 */

let cachedSession = readSession();
const authListeners = new Set();

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.accessToken && s.refreshToken ? s : null;
  } catch {
    return null;
  }
}

function writeSession(session) {
  cachedSession = session;
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    console.error('[supabase] could not persist session', err);
  }
  for (const cb of authListeners) {
    try {
      cb(session);
    } catch (err) {
      console.warn('[supabase] auth listener failed', err);
    }
  }
}

/** @returns {Session|null} */
export function getSession() {
  return cachedSession;
}

export function isSignedIn() {
  return Boolean(cachedSession);
}

/** Subscribe to sign-in/sign-out/expiry. Returns an unsubscribe function. */
export function onAuthChange(cb) {
  authListeners.add(cb);
  return () => authListeners.delete(cb);
}

function sessionFromTokenResponse(data) {
  const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresInMs,
    userId: data.user?.id || cachedSession?.userId || '',
    email: data.user?.email || cachedSession?.email || '',
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turn a failure into a German message the UI can show as-is. Distinguishes the
 * cases that actually need different user action -- offline, expired session,
 * RLS rejection, and a free-tier project that has been paused for inactivity.
 */
export function describeError(err, status, body) {
  if (status === 401 || status === 403) {
    const msg = String(body?.message || body?.msg || '');
    if (/row-level security|permission denied/i.test(msg)) {
      return 'Zugriff verweigert — die Sicherheitsregel (RLS) der Tabelle lässt diesen Schreibvorgang nicht zu.';
    }
    return 'Sitzung abgelaufen oder ungültig. Bitte erneut anmelden.';
  }
  if (status === 400) {
    const msg = String(body?.error_description || body?.message || body?.msg || '');
    if (/expired|invalid/i.test(msg)) return 'Der Code ist falsch oder abgelaufen. Bitte neuen Code anfordern.';
    return msg ? `Anfrage abgelehnt: ${msg}` : 'Anfrage abgelehnt (400).';
  }
  if (status === 404) return 'Tabelle nicht gefunden — wurde das SQL-Schema angelegt?';
  if (status === 429) return 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.';
  if (status && status >= 500) {
    return 'Der Server antwortet nicht (5xx). Bei einem pausierten Supabase-Projekt hilft ein Klick auf „Restore" im Dashboard.';
  }
  if (err?.name === 'AbortError') return 'Zeitüberschreitung bei der Verbindung zum Server.';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Keine Internetverbindung — die Daten bleiben lokal gespeichert und werden später synchronisiert.';
  }
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError for DNS/connection failures, which for a
    // free-tier project is most often the "paused after inactivity" state.
    return 'Server nicht erreichbar. Falls das Supabase-Projekt pausiert ist, muss es im Dashboard reaktiviert werden.';
  }
  return err?.message || 'Unbekannter Fehler.';
}

// ---------------------------------------------------------------------------
// Low-level request
// ---------------------------------------------------------------------------

async function request(path, { method = 'GET', body, headers = {}, auth = false } = {}) {
  if (!isSupabaseConfigured()) throw new Error('Supabase ist in dieser Installation nicht konfiguriert.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const token = auth ? (await ensureFreshToken())?.accessToken : null;
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data = text ? safeParse(text) : null;

    if (!res.ok) {
      // A refresh token rejected by the server means the session is truly gone.
      if (res.status === 401 && auth) writeSession(null);
      throw new Error(describeError(null, res.status, data));
    }
    return data;
  } catch (err) {
    if (err instanceof Error && !(err instanceof TypeError) && err.name !== 'AbortError') throw err;
    throw new Error(describeError(err));
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Refresh the access token when it is about to expire. */
async function ensureFreshToken() {
  const session = cachedSession;
  if (!session) throw new Error('Nicht angemeldet.');
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    writeSession(null);
    throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.');
  }
  const next = sessionFromTokenResponse(await res.json());
  writeSession(next);
  return next;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Send a 6-digit login code by e-mail. Creates the account on first use. */
export async function sendCode(email) {
  const address = String(email || '').trim();
  if (!address) throw new Error('Bitte eine E-Mail-Adresse eingeben.');
  await request('/auth/v1/otp', {
    method: 'POST',
    body: { email: address, create_user: true },
  });
  return address;
}

/** Exchange the e-mailed code for a session. */
export async function verifyCode(email, code) {
  const address = String(email || '').trim();
  const token = String(code || '').trim();
  if (!token) throw new Error('Bitte den Code aus der E-Mail eingeben.');

  const data = await request('/auth/v1/verify', {
    method: 'POST',
    body: { email: address, token, type: 'email' },
  });
  if (!data?.access_token) throw new Error('Anmeldung fehlgeschlagen — kein Token erhalten.');

  writeSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    userId: data.user?.id || '',
    email: data.user?.email || address,
  });
  return getSession();
}

export async function signOut() {
  const session = cachedSession;
  writeSession(null); // drop locally first: the UI must sign out even if the call fails
  if (!session) return;
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` },
    });
  } catch {
    // Best effort -- the local session is already gone.
  }
}

// ---------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------

/** GET rows. `query` is an already-encoded PostgREST query string. */
export function selectRows(table, query = '') {
  return request(`/rest/v1/${table}${query ? `?${query}` : ''}`, { auth: true });
}

/**
 * Patch the rows matching an encoded PostgREST filter. Used for soft deletes,
 * where the full row is no longer available locally. RLS keeps this scoped to
 * the signed-in user, and a filter matching nothing is a harmless no-op.
 */
export function patchRows(table, query, patch) {
  return request(`/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    auth: true,
    body: patch,
    headers: { Prefer: 'return=minimal' },
  });
}

/** Insert or update rows, resolving conflicts on the primary key. */
export function upsertRows(table, rows) {
  return request(`/rest/v1/${table}`, {
    method: 'POST',
    auth: true,
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

// Shared sign-in gate. Both pages stay locked until a session exists.
//
// Deliberately gated on a *session*, not on connectivity: the whole point of the
// app is logging a delay on a train with no reception, so a device that has
// signed in once gets straight in and works offline. Only a device that has
// never signed in -- or that signed out -- sees this screen.

import { APP_NAME } from './config.js';
import { isSupabaseConfigured, isSignedIn, onAuthChange, signIn, signUp, MIN_PASSWORD_LENGTH } from './sync.js';

const ui = { email: '', password: '', busy: false, error: '' };
let started = false;
let onReady = null;

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function field(labelText, input) {
  return el('div', { className: 'field' }, [el('div', { className: 'label', text: labelText }), input]);
}

function render(gate) {
  gate.replaceChildren();

  const card = el('div', { className: 'gate-card' });
  card.appendChild(
    el('div', { className: 'gate-brand' }, [
      el('span', { className: 'gate-logo', attrs: { 'aria-hidden': 'true' }, text: '🚆' }),
      el('h1', { className: 'gate-title', text: APP_NAME }),
    ])
  );
  card.appendChild(
    el('p', {
      className: 'gate-sub',
      text: 'Bitte anmelden, um deine Fahrten zu erfassen und geräteübergreifend zu synchronisieren.',
    })
  );

  if (ui.error) {
    card.appendChild(
      el('div', { className: 'notice' }, [
        el('span', { attrs: { 'aria-hidden': 'true' }, text: '⚠️' }),
        el('span', { text: ui.error }),
      ])
    );
  }

  const emailInput = el('input', {
    className: 'input',
    attrs: { type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'du@beispiel.de' },
  });
  emailInput.value = ui.email;
  emailInput.addEventListener('input', () => {
    ui.email = emailInput.value;
  });
  card.appendChild(field('E-Mail', emailInput));

  const passwordInput = el('input', {
    className: 'input',
    attrs: { type: 'password', autocomplete: 'current-password', placeholder: '••••••••' },
  });
  passwordInput.value = ui.password;
  passwordInput.addEventListener('input', () => {
    ui.password = passwordInput.value;
  });
  passwordInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit('signin', gate);
  });
  card.appendChild(field('Passwort', passwordInput));

  const row = el('div', { className: 'btn-row' });
  const signInBtn = el('button', {
    className: 'btn btn--primary',
    text: ui.busy === 'signin' ? 'Melde an …' : 'Anmelden',
    attrs: { type: 'button' },
  });
  const signUpBtn = el('button', {
    className: 'btn btn--ghost',
    text: ui.busy === 'signup' ? 'Registriere …' : 'Registrieren',
    attrs: { type: 'button' },
  });
  if (ui.busy) {
    signInBtn.disabled = true;
    signUpBtn.disabled = true;
  }
  signInBtn.addEventListener('click', () => submit('signin', gate));
  signUpBtn.addEventListener('click', () => submit('signup', gate));
  row.appendChild(signInBtn);
  row.appendChild(signUpBtn);
  card.appendChild(row);

  card.appendChild(
    el('p', {
      className: 'hint',
      text:
        `Noch kein Konto? „Registrieren“ wählen (Passwort mindestens ${MIN_PASSWORD_LENGTH} Zeichen). ` +
        'Bitte im Passwort-Manager speichern — es gibt keine Zurücksetzen-E-Mail.',
    })
  );

  gate.appendChild(card);
  if (!ui.busy) (ui.email ? passwordInput : emailInput).focus();
}

async function submit(mode, gate) {
  const email = String(ui.email || '').trim();
  const password = String(ui.password || '');
  ui.error = '';

  if (!email) {
    ui.error = 'Bitte eine E-Mail-Adresse eingeben.';
    render(gate);
    return;
  }
  if (!password) {
    ui.error = 'Bitte ein Passwort eingeben.';
    render(gate);
    return;
  }

  ui.busy = mode;
  render(gate);
  try {
    if (mode === 'signup') await signUp(email, password);
    else await signIn(email, password);
    ui.password = '';
    ui.error = '';
    // onAuthChange unlocks the app; nothing else to do here.
  } catch (err) {
    ui.error = err.message;
  } finally {
    ui.busy = false;
    if (!isSignedIn()) render(gate);
  }
}

function unlock(gate, content) {
  gate.hidden = true;
  if (content) content.hidden = false;
  if (!started) {
    started = true;
    onReady?.();
  }
}

function lock(gate, content) {
  if (content) content.hidden = true;
  gate.hidden = false;
  render(gate);
}

/**
 * Lock the page until signed in, then run `onSignedIn` exactly once.
 *
 * If the deployment has no Supabase project configured, the gate steps aside
 * rather than bricking the app -- a fork without credentials still works as a
 * purely local tracker.
 */
export function initAuthGate({ gateId = 'authGate', contentId = 'appContent', onSignedIn } = {}) {
  const gate = document.getElementById(gateId);
  const content = document.getElementById(contentId);
  onReady = onSignedIn;

  if (!gate) {
    onSignedIn?.();
    return;
  }

  if (!isSupabaseConfigured()) {
    unlock(gate, content);
    return;
  }

  if (isSignedIn()) unlock(gate, content);
  else lock(gate, content);

  onAuthChange((session) => {
    if (session) {
      unlock(gate, content);
    } else {
      // Session ended (sign-out, or a refresh token the server rejected).
      ui.password = '';
      ui.error = '';
      lock(gate, content);
    }
  });
}

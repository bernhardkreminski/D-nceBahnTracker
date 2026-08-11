// The delay-entry sheet: the bottom modal for logging or changing the delay of
// one train. Both pages need it -- the tracker opens it from the live list, the
// statistics page from the "Einzelne Fahrten" table -- so it owns its markup and
// builds it into <body> on first use rather than being duplicated in two files.
//
// It takes anything Train-shaped; a stored Entry qualifies, which is what lets
// the statistics page reopen a trip that has long since left the live window.

import { DIRECTIONS } from './config.js';
import {
  toHHMM,
  actualArrival,
  actualDurationMin,
  extraTimeInTrainMin,
  entryFromTrain,
  formatMinutes,
} from './model.js';
import { getEntry, saveEntry, deleteEntry } from './storage.js';
import { syncInBackground } from './sync.js';

const QUICK_PICKS = [0, 2, 5, 10, 15, 20, 30, 45, 60];

/** Element cache, filled by build() on first open. */
let els = null;

/** What the currently open sheet is editing, and who wants to hear about it. */
const session = {
  train: null,
  wasExisting: false,
  onSaved: null,
  onDeleted: null,
  onError: null,
};

let isOpen = false;

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

/** A −/input/+ row. Returns the three nodes plus the wrapper. */
function buildStepper(idPrefix, labelId) {
  const minus = el('button', { text: '−', attrs: { type: 'button', 'aria-label': 'Minus 1 Minute' } });
  const plus = el('button', { text: '+', attrs: { type: 'button', 'aria-label': 'Plus 1 Minute' } });
  const input = el('input', {
    className: 'input',
    attrs: { type: 'number', inputmode: 'numeric', value: '0', id: `${idPrefix}Input`, 'aria-labelledby': labelId },
  });
  return { wrap: el('div', { className: 'stepper' }, [minus, input, plus]), minus, input, plus };
}

function build() {
  const title = el('h2', { className: 'sheet-title', attrs: { id: 'sheetTitle' }, text: 'Zug' });
  const sub = el('p', { className: 'sheet-sub' });

  const arrivalLabel = el('div', { className: 'label', attrs: { id: 'arrivalLabel' }, text: 'Ankunftsverspätung (Minuten)' });
  const arr = buildStepper('arr', 'arrivalLabel');
  const chips = el('div', {
    className: 'chips',
    attrs: { role: 'group', 'aria-label': 'Schnellauswahl Ankunftsverspätung' },
  });
  const arrivalField = el('div', { className: 'field' }, [arrivalLabel, arr.wrap, chips]);

  const detailsToggle = el('button', {
    className: 'btn btn--ghost btn--block',
    text: 'Details (Abfahrtsverspätung) ▾',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'departureField' },
  });

  const departureLabel = el('div', { className: 'label', attrs: { id: 'departureLabel' }, text: 'Abfahrtsverspätung (Minuten)' });
  const dep = buildStepper('dep', 'departureLabel');
  const departureField = el('div', { className: 'field', attrs: { id: 'departureField', hidden: '' } }, [departureLabel, dep.wrap]);
  departureField.style.marginTop = '14px';

  const cancelledCheckbox = el('input', { attrs: { type: 'checkbox' } });
  const cancelledField = el('div', { className: 'field' }, [
    el('label', { className: 'checkline' }, [cancelledCheckbox, document.createTextNode('Zug ist ausgefallen')]),
  ]);
  cancelledField.style.marginTop = '14px';

  const noteTextarea = el('textarea', {
    className: 'textarea',
    attrs: { id: 'noteTextarea', placeholder: 'Optional…' },
  });
  const noteField = el('div', { className: 'field' }, [
    el('label', { className: 'label', attrs: { for: 'noteTextarea' }, text: 'Notiz' }),
    noteTextarea,
  ]);

  const previewText = el('p', { className: 'hint', text: '…' });
  previewText.style.margin = '0';
  const previewCard = el('div', { className: 'card card-pad' }, [previewText]);

  const cancelBtn = el('button', { className: 'btn btn--ghost', text: 'Abbrechen', attrs: { type: 'button' } });
  const saveBtn = el('button', { className: 'btn btn--primary', text: 'Speichern', attrs: { type: 'button' } });
  const btnRow = el('div', { className: 'btn-row' }, [cancelBtn, saveBtn]);
  btnRow.style.marginTop = '14px';

  const deleteBtn = el('button', {
    className: 'btn btn--danger btn--block',
    text: 'Löschen',
    attrs: { type: 'button', hidden: '' },
  });
  deleteBtn.style.marginTop = '10px';

  const panel = el('div', { className: 'sheet-panel', attrs: { tabindex: '-1' } }, [
    el('div', { className: 'sheet-grabber', attrs: { 'aria-hidden': 'true' } }),
    title,
    sub,
    arrivalField,
    detailsToggle,
    departureField,
    cancelledField,
    noteField,
    previewCard,
    btnRow,
    deleteBtn,
  ]);

  const backdrop = el('button', { className: 'sheet-backdrop', attrs: { type: 'button', 'aria-label': 'Schließen' } });
  const sheet = el('div', {
    className: 'sheet',
    attrs: { hidden: '', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheetTitle' },
  }, [backdrop, panel]);

  document.body.appendChild(sheet);

  els = {
    sheet, panel, backdrop, title, sub,
    arrInput: arr.input, arrMinus: arr.minus, arrPlus: arr.plus, chips,
    detailsToggle, departureField, depInput: dep.input, depMinus: dep.minus, depPlus: dep.plus,
    cancelledCheckbox, noteTextarea, previewText,
    cancelBtn, saveBtn, deleteBtn,
  };

  buildQuickPickChips();
  wireEvents();
}

function buildQuickPickChips() {
  for (const value of QUICK_PICKS) {
    const chip = el('button', {
      className: 'chip',
      text: value === 0 ? 'pünktlich' : `+${value}`,
      attrs: { type: 'button' },
    });
    chip.dataset.value = String(value);
    chip.addEventListener('click', () => {
      els.arrInput.value = String(value);
      updateChipActiveState();
      updatePreview();
    });
    els.chips.appendChild(chip);
  }
}

function wireEvents() {
  els.backdrop.addEventListener('click', closeEntrySheet);
  els.cancelBtn.addEventListener('click', closeEntrySheet);
  els.saveBtn.addEventListener('click', handleSave);
  els.deleteBtn.addEventListener('click', handleDelete);

  els.detailsToggle.addEventListener('click', () => {
    const expanded = !els.departureField.hidden;
    els.departureField.hidden = expanded;
    els.detailsToggle.setAttribute('aria-expanded', String(!expanded));
  });

  els.arrMinus.addEventListener('click', () => stepInput(els.arrInput, -1));
  els.arrPlus.addEventListener('click', () => stepInput(els.arrInput, 1));
  els.depMinus.addEventListener('click', () => stepInput(els.depInput, -1));
  els.depPlus.addEventListener('click', () => stepInput(els.depInput, 1));

  els.arrInput.addEventListener('input', () => {
    updateChipActiveState();
    updatePreview();
  });
  els.depInput.addEventListener('input', updatePreview);
  els.cancelledCheckbox.addEventListener('change', updatePreview);
  els.noteTextarea.addEventListener('input', updatePreview);
}

function stepInput(input, delta) {
  input.value = String((Number(input.value) || 0) + delta);
  if (input === els.arrInput) updateChipActiveState();
  updatePreview();
}

function updateChipActiveState() {
  const current = Number(els.arrInput.value) || 0;
  for (const chip of els.chips.children) {
    chip.classList.toggle('is-active', Number(chip.dataset.value) === current);
  }
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

/** "Fr., 07.08.26" -- or null for today, where the date adds nothing. */
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (isToday) return null;
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' });
}

/**
 * Show the sheet for one train. Pre-fills from the stored Entry if there is one
 * (so reopening a logged trip edits it), otherwise from the train's live delay.
 *
 * @param {Object} options
 * @param {import('./model.js').Train} options.train  train or stored Entry to edit
 * @param {(entry: import('./model.js').Entry, info: {wasExisting: boolean}) => void} [options.onSaved]
 * @param {(id: string) => void} [options.onDeleted]
 * @param {(error: Error) => void} [options.onError] storing failed; the sheet stays open
 */
export function openEntrySheet({ train, onSaved = null, onDeleted = null, onError = null }) {
  if (!train) return;
  if (!els) build();

  const existing = getEntry(train.id);

  session.train = train;
  session.wasExisting = Boolean(existing);
  session.onSaved = onSaved;
  session.onDeleted = onDeleted;
  session.onError = onError;

  els.title.textContent = `${train.line} ${train.trainNumber}`.trim();
  els.sub.textContent = [
    dayLabel(train.scheduledDeparture),
    DIRECTIONS[train.direction]?.label || train.direction,
    `${toHHMM(train.scheduledDeparture)} → ${toHHMM(train.scheduledArrival)}`,
  ].filter(Boolean).join(' · ');

  const defaultArrival = existing ? existing.arrivalDelayMin : (train.arrivalDelayMin ?? 0);
  const defaultDeparture = existing ? existing.departureDelayMin : (train.departureDelayMin ?? 0);

  els.arrInput.value = String(Math.round(defaultArrival) || 0);
  els.depInput.value = String(Math.round(defaultDeparture) || 0);
  els.cancelledCheckbox.checked = existing ? Boolean(existing.cancelled) : Boolean(train.cancelled);
  els.noteTextarea.value = (existing ? existing.note : '') || '';
  els.deleteBtn.hidden = !existing;
  els.saveBtn.textContent = existing ? 'Aktualisieren' : 'Speichern';

  // Reveal the details section automatically if there is a non-zero departure
  // delay to show, otherwise keep it collapsed.
  const showDetails = Number(els.depInput.value) !== 0;
  els.departureField.hidden = !showDetails;
  els.detailsToggle.setAttribute('aria-expanded', String(showDetails));

  updateChipActiveState();
  updatePreview();

  els.sheet.hidden = false;
  isOpen = true;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeydown);
  els.panel.focus();
}

export function closeEntrySheet() {
  if (!els) return;
  els.sheet.hidden = true;
  isOpen = false;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKeydown);
  session.train = null;
  session.wasExisting = false;
  session.onSaved = null;
  session.onDeleted = null;
  session.onError = null;
}

/** True while the sheet is up -- pages use it to hold back background re-renders. */
export function isEntrySheetOpen() {
  return isOpen;
}

function onKeydown(event) {
  if (event.key === 'Escape') closeEntrySheet();
}

// ---------------------------------------------------------------------------
// Preview + persistence
// ---------------------------------------------------------------------------

function currentFormValues() {
  return {
    departureDelayMin: Number(els.depInput.value) || 0,
    arrivalDelayMin: Number(els.arrInput.value) || 0,
    cancelled: els.cancelledCheckbox.checked,
    note: els.noteTextarea.value,
  };
}

function updatePreview() {
  const train = session.train;
  if (!train) return;
  const values = currentFormValues();

  if (values.cancelled) {
    els.previewText.textContent = 'Zug fällt aus – keine Ankunft erfasst.';
    return;
  }

  const merged = { ...train, ...values };
  const arrival = actualArrival(merged);
  const duration = actualDurationMin(merged);
  const extra = extraTimeInTrainMin(merged);

  let extraText;
  if (extra > 0) extraText = `${formatMinutes(extra)} länger im Zug als geplant`;
  else if (extra < 0) extraText = `${formatMinutes(Math.abs(extra))} kürzer im Zug als geplant`;
  else extraText = 'Fahrzeit wie geplant';

  els.previewText.textContent = `Ankunft ca. ${toHHMM(arrival)} · ${formatMinutes(duration)} im Zug (${extraText})`;
}

function handleSave() {
  const train = session.train;
  if (!train) return;
  const { onSaved, onError, wasExisting } = session;

  let entry;
  try {
    entry = saveEntry(entryFromTrain(train, currentFormValues()));
  } catch (err) {
    // Deliberately leave the sheet open: nothing was stored, so closing it would
    // dress a loss up as a success and discard what the user just typed.
    console.error('[entry-sheet] could not persist entry', err);
    if (onError) onError(err);
    return;
  }

  closeEntrySheet();
  syncInBackground(); // fire-and-forget: saving must never wait on the network
  if (onSaved) onSaved(entry, { wasExisting });
}

function handleDelete() {
  const train = session.train;
  if (!train) return;
  const { onDeleted, onError } = session;
  const id = train.id;

  try {
    deleteEntry(id);
  } catch (err) {
    console.error('[entry-sheet] could not delete entry', err);
    if (onError) onError(err);
    return;
  }

  closeEntrySheet();
  syncInBackground();
  if (onDeleted) onDeleted(id);
}

// THE DECK: draw a card, do what it says.
// This file runs the main screen. The secret menu (options and the card editor) is in menu.js,
// the drawing rules in deck.js, and saving in store.js.
import { inline, render } from './markup.js';
import * as Deck from './deck.js';
import * as Store from './store.js';
import { initMenu } from './menu.js';

const $ = id => document.getElementById(id);
const ui = {
  draw: $('draw-button'),
  options: $('options-button'),
  card: $('card'),
  title: $('card-title'),
  text: $('card-text'),
  flavor: $('card-flavor-text'),
  permalink: document.querySelector('#card .permalink'),
  notice: $('notice'),
  toast: $('toast'),
};

const state = {
  original: null,    // the deck from cards.json
  deck: null,        // the deck in play: the original, or this device's edited copy
  custom: false,     // true once this device has its own edited copy
  replacement: false,
  off: new Set(),    // groups switched off in the secret menu
  shoe: [],          // ids of the cards still to come
  currentId: null,   // the card on screen
};

const cardById = id => state.deck?.cards.find(c => c.id === id) || null;

// ---------- saving ----------

const saveSettings = () => Store.save('settings', { replacement: state.replacement, off: [...state.off] });
const saveShoe = () => Store.save('shoe', { ids: state.shoe, date: Date.now() });

let deckTimer = null;
function deckChanged() {
  state.custom = true;
  clearTimeout(deckTimer);
  deckTimer = setTimeout(flushDeck, 300);
}
function flushDeck() {
  if (!deckTimer) return;
  clearTimeout(deckTimer);
  deckTimer = null;
  const ok = Store.save('deck', Deck.serializeDeck(state.deck));
  app.onSaved?.(ok);
}
window.addEventListener('pagehide', flushDeck);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDeck(); });

// ---------- the screen ----------

function showCard(card, { animate = true, keepHash = false } = {}) {
  state.currentId = card.id;
  Store.save('current', { id: card.id, date: Date.now() });
  ui.title.innerHTML = inline(card.title);
  ui.text.innerHTML = render(card.text);
  ui.flavor.innerHTML = render(card.flavor);
  ui.flavor.hidden = !card.flavor;
  ui.permalink.href = `#card-${card.id}`;
  ui.card.hidden = false;
  if (animate) {
    ui.card.classList.remove('deal');
    void ui.card.offsetWidth; // restart the animation
    ui.card.classList.add('deal');
  }
  if (!keepHash && location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function clearCard() {
  state.currentId = null;
  Store.remove('current');
  ui.card.hidden = true;
}

function showNotice(text) {
  ui.notice.textContent = text;
  ui.notice.hidden = !text;
}

let toastTimer = null;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.classList.remove('show');
    setTimeout(() => { ui.toast.hidden = true; }, 250);
  }, 2200);
}

function draw() {
  if (!state.deck) return;
  const result = Deck.drawCard({
    deck: state.deck, shoe: state.shoe, off: state.off,
    replacement: state.replacement, lastId: state.currentId,
  });
  if (!result.card) {
    clearCard();
    showNotice(state.deck.cards.length
      ? 'No cards can come up. Every card is in a group that is unchecked in the options.'
      : 'The deck is empty. Add some cards first.');
    return;
  }
  state.shoe = result.shoe;
  saveShoe();
  showNotice(result.reshuffled ? "That's the whole deck. Every card has been shuffled back in." : '');
  showCard(result.card);
}

const cardIdFromHash = () => {
  const m = /^#card-(\d+)$/.exec(location.hash);
  return m ? Number(m[1]) : null;
};

window.addEventListener('hashchange', () => {
  const card = cardById(cardIdFromHash());
  if (card) { showNotice(''); showCard(card, { keepHash: true }); }
});

ui.permalink.addEventListener('click', async e => {
  e.preventDefault();
  if (state.currentId == null) return;
  const hash = `#card-${state.currentId}`;
  history.replaceState(null, '', hash);
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link to this card copied');
  } catch {
    toast('The link to this card is in the address bar');
  }
});

ui.draw.addEventListener('click', draw);

// Space or Enter draws a card when nothing else has the keyboard.
document.addEventListener('keydown', e => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  if (e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, textarea, select, button, a, [contenteditable]')) return;
  e.preventDefault();
  draw();
});

// ---------- what the secret menu can do ----------

const app = {
  state,
  onSaved: null, // set by the menu to show "Saved"
  deckChanged,
  flushDeck,
  toast,
  setReplacement(on) { state.replacement = on; saveSettings(); },
  setGroupOn(id, on) {
    if (on) state.off.delete(id); else state.off.add(id);
    saveSettings();
  },
  cardsLeft: () => Deck.cardsLeft(state.deck, state.shoe, state.off),
  resetShoe() { state.shoe = Deck.freshShoe(state.deck); saveShoe(); showNotice(''); },
  cardAdded(card) { state.shoe.push(card.id); saveShoe(); deckChanged(); },
  cardDeleted(id) {
    state.shoe = state.shoe.filter(x => x !== id);
    saveShoe();
    if (state.currentId === id) clearCard();
    deckChanged();
  },
  groupDeleted(id) { state.off.delete(id); saveSettings(); deckChanged(); },
  showCardById(id) { const card = cardById(id); if (card) { showNotice(''); showCard(card); } },
  /** Swaps in a whole new deck (an import, or the original cards). */
  replaceDeck(deck, { custom }) {
    clearTimeout(deckTimer);
    deckTimer = null;
    state.deck = deck;
    state.custom = custom;
    state.off = new Set([...state.off].filter(id => deck.groups.some(g => g.id === id)));
    saveSettings();
    state.shoe = Deck.freshShoe(deck);
    saveShoe();
    if (!cardById(state.currentId)) clearCard();
    showNotice('');
    if (custom) app.onSaved?.(Store.save('deck', Deck.serializeDeck(deck)));
    else Store.remove('deck');
  },
  restoreOriginal() {
    if (!state.original) return false;
    app.replaceDeck(structuredClone(state.original), { custom: false });
    return true;
  },
  /** Re-shows the card on screen after the menu closes, in case it was edited. */
  refreshCard() {
    const card = cardById(state.currentId);
    if (card) showCard(card, { animate: false, keepHash: true });
    else if (state.currentId != null) clearCard();
  },
};

// ---------- start up ----------

async function loadOriginal() {
  const res = await fetch('cards.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`cards.json: HTTP ${res.status}`);
  return Deck.normalizeDeck(await res.json());
}

async function start() {
  let saved = null;
  const raw = Store.load('deck');
  if (raw) {
    try { saved = Deck.normalizeDeck(raw); } catch { saved = null; }
  }
  try {
    state.original = await loadOriginal();
  } catch (err) {
    console.warn('Could not load the original cards', err);
  }
  if (saved) {
    state.deck = saved;
    state.custom = true;
  } else if (state.original) {
    state.deck = structuredClone(state.original);
  } else {
    showNotice("Couldn't load the cards. Check your connection and reload the page.");
    return;
  }

  const groupIds = new Set(state.deck.groups.map(g => g.id));
  const settings = Store.load('settings', {}) || {};
  state.replacement = settings.replacement === true;
  state.off = new Set((Array.isArray(settings.off) ? settings.off : []).filter(id => groupIds.has(id)));

  const cardIds = new Set(state.deck.cards.map(c => c.id));
  const shoe = Store.load('shoe');
  const fresh = shoe && Array.isArray(shoe.ids) && Date.now() - shoe.date < Deck.SHOE_LIFETIME_MS;
  state.shoe = fresh ? shoe.ids.filter(id => cardIds.has(id)) : Deck.freshShoe(state.deck);
  if (!fresh) saveShoe();

  const linked = cardById(cardIdFromHash());
  const current = Store.load('current');
  if (linked) showCard(linked, { keepHash: true });
  else if (current && Date.now() - current.date < Deck.SHOE_LIFETIME_MS && cardById(current.id)) {
    showCard(cardById(current.id), { animate: false });
  }

  const menu = initMenu(app);
  ui.options.addEventListener('click', () => menu.open());
  ui.draw.disabled = false;
}

start();

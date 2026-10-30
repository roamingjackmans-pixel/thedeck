// THE DECK: draw a card, do what it says.
// This file runs the main screen and keeps the deck in sync. The secret menu (options and the card
// editor) is in menu.js, the drawing rules in deck.js, publishing in sync.js, and saving in store.js.
//
// Everyone plays the shared deck (cards.json). Editing on a device makes an unpublished copy there.
// A device connected to GitHub publishes its copy when the secret menu closes, and every other phone
// picks up the new shared deck within a minute or two.
import { inline, render } from './markup.js';
import * as Deck from './deck.js';
import * as Store from './store.js';
import * as Sync from './sync.js';
import { initMenu } from './menu.js';

const $ = id => document.getElementById(id);
const ui = {
  draw: $('draw-button'),
  options: $('options-button'),
  menu: $('menu'),
  card: $('card'),
  title: $('card-title'),
  text: $('card-text'),
  flavor: $('card-flavor-text'),
  permalink: document.querySelector('#card .permalink'),
  notice: $('notice'),
  toast: $('toast'),
};

const UPDATE_CHECK_MS = 60 * 1000;

const state = {
  shared: null,      // the deck everyone plays: { revision, updated, groups, cards }
  deck: null,        // the deck in play: a copy of the shared deck, or this device's unpublished edits
  custom: false,     // true while this device has unpublished edits
  baseRevision: 0,   // the shared revision those edits started from
  github: null,      // { token, login } when this device can publish
  publishing: false,
  replacement: false,
  off: new Set(),    // groups switched off in the secret menu
  shoe: [],          // ids of the cards still to come
  currentId: null,   // the card on screen
};

const cardById = id => state.deck?.cards.find(c => c.id === id) || null;
const copyOf = deck => structuredClone({ groups: deck.groups, cards: deck.cards });
const sameDeck = (a, b) => !!a && !!b && JSON.stringify([a.groups, a.cards]) === JSON.stringify([b.groups, b.cards]);
const menuOpen = () => ui.menu.open;

// ---------- saving on this device ----------

const saveSettings = () => Store.save('settings', { replacement: state.replacement, off: [...state.off] });
const saveShoe = () => Store.save('shoe', { ids: state.shoe, date: Date.now() });
const saveShared = () => Store.save('shared', {
  revision: state.shared.revision, updated: state.shared.updated, groups: state.shared.groups, cards: state.shared.cards,
});

let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  const ok = Store.save('deck', { ...Deck.serializeDeck(state.deck), baseRevision: state.baseRevision });
  app.onSaved?.(ok);
}
/** Called after every edit. The first edit turns the deck into this device's own copy. */
function deckChanged() {
  if (!state.custom) {
    state.custom = true;
    state.baseRevision = state.shared?.revision ?? 0;
  }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 300);
  syncChanged();
}
function flushDeck() { if (draftTimer) saveDraft(); }
function dropDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  state.custom = false;
  Store.remove('deck');
}
window.addEventListener('pagehide', flushDeck);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDeck(); });

const syncChanged = () => app.onSyncChange?.();

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

/** Re-shows the card on screen, in case it was edited or deleted. */
function refreshCard() {
  const card = cardById(state.currentId);
  if (card) showCard(card, { animate: false, keepHash: true });
  else if (state.currentId != null) clearCard();
}

function showNotice(text) {
  ui.notice.textContent = text;
  ui.notice.hidden = !text;
}

let toastTimer = null;
function toast(text, ms = 2200) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.classList.remove('show');
    setTimeout(() => { ui.toast.hidden = true; }, 250);
  }, ms);
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
  history.replaceState(null, '', `#card-${state.currentId}`);
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
  if (e.altKey || e.ctrlKey || e.metaKey || menuOpen()) return;
  if (e.target.closest?.('input, textarea, select, button, a, [contenteditable]')) return;
  e.preventDefault();
  draw();
});

// ---------- switching decks ----------

/**
 * Puts a deck in play. fresh: start a new shoe (a whole different deck); otherwise the cards already
 * drawn stay drawn, and any new cards join the cards still to come.
 */
function useDeck(deck, { fresh = false } = {}) {
  const before = new Set(state.deck?.cards.map(c => c.id) || []);
  const ids = new Set(deck.cards.map(c => c.id));
  state.deck = deck;
  state.shoe = fresh
    ? Deck.freshShoe(deck)
    : state.shoe.filter(id => ids.has(id)).concat(deck.cards.filter(c => !before.has(c.id)).map(c => c.id));
  saveShoe();
  const groups = new Set(deck.groups.map(g => g.id));
  state.off = new Set([...state.off].filter(id => groups.has(id)));
  saveSettings();
  if (!menuOpen()) refreshCard();
}

/** Switches to the shared deck if this device has no edits of its own. Returns true if it changed. */
function applyShared() {
  if (state.custom || menuOpen() || !state.shared || sameDeck(state.deck, state.shared)) return false;
  useDeck(copyOf(state.shared));
  state.baseRevision = state.shared.revision;
  return true;
}

// ---------- the shared deck ----------

function sharedFrom(raw) {
  return { ...Deck.normalizeDeck(raw), revision: Number(raw.revision) || 0, updated: typeof raw.updated === 'string' ? raw.updated : null };
}

async function fetchShared() {
  const res = await fetch('cards.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`cards.json: HTTP ${res.status}`);
  return sharedFrom(await res.json());
}

function cachedShared() {
  const raw = Store.load('shared');
  if (!raw) return null;
  try { return sharedFrom(raw); } catch { return null; }
}

let lastCheck = 0;
/** Looks for a newer shared deck, so phones pick up edits published from another device. */
async function checkForUpdates() {
  if (document.hidden || state.publishing || !state.shared) return;
  lastCheck = Date.now();
  let fetched;
  try { fetched = await fetchShared(); } catch { return; }
  if (fetched.revision <= state.shared.revision) return; // nothing new (or the site hasn't caught up yet)
  state.shared = fetched;
  saveShared();
  if (applyShared()) toast('The deck was just updated');
  syncChanged();
}
setInterval(checkForUpdates, UPDATE_CHECK_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastCheck > 20 * 1000) checkForUpdates();
});

// ---------- publishing ----------

async function publish() {
  if (!state.github || !state.custom || state.publishing) return;
  flushDeck();
  if (sameDeck(state.deck, state.shared)) {
    dropDraft(); // edited and then changed back: nothing to publish
    state.baseRevision = state.shared.revision;
    syncChanged();
    return;
  }
  state.publishing = true;
  syncChanged();
  if (!menuOpen()) toast('Publishing your changes…', 30000);
  try {
    const token = state.github.token;
    let result = await Sync.publishDeck(token, state.deck, { baseRevision: state.baseRevision });
    if (result.conflict) {
      const replace = confirm("Someone changed the shared deck from another device after you started editing here. Publish anyway, replacing those changes with this device's deck?");
      if (!replace) {
        toast('Not published. Your changes are still saved on this device.', 5000);
        return;
      }
      result = await Sync.publishDeck(token, state.deck, { force: true });
    }
    state.shared = { ...copyOf(state.deck), revision: result.revision, updated: result.updated };
    saveShared();
    dropDraft();
    state.baseRevision = result.revision;
    toast('Published. Everyone gets the new deck within a minute or two.', 4000);
  } catch (err) {
    console.warn('Publish failed', err);
    toast(`Couldn't publish. ${err.message} Your changes are still saved on this device.`, 8000);
  } finally {
    state.publishing = false;
    syncChanged();
  }
}

// ---------- what the secret menu can do ----------

const app = {
  state,
  onSaved: null,      // set by the menu to show "Saved"
  onSyncChange: null, // set by the menu to refresh the "Your Deck" section
  deckChanged,
  flushDeck,
  toast,
  publish,
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

  /** Makes a whole new deck (an import, or the original cards) this device's edits. */
  replaceDeck(deck) {
    if (!state.custom) state.baseRevision = state.shared?.revision ?? 0;
    state.custom = true;
    useDeck(deck, { fresh: true });
    showNotice('');
    saveDraft();
    syncChanged();
  },
  async loadOriginal() {
    const res = await fetch('original-cards.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`original-cards.json: HTTP ${res.status}`);
    return Deck.normalizeDeck(await res.json());
  },
  /** Throws away this device's edits and goes back to the shared deck. */
  discardEdits() {
    dropDraft();
    useDeck(copyOf(state.shared));
    state.baseRevision = state.shared.revision;
    syncChanged();
  },

  async connect(token) {
    const clean = String(token || '').trim();
    if (!clean) throw new Error('Paste the token first.');
    const login = await Sync.checkToken(clean);
    state.github = { token: clean, login };
    if (!Store.save('github', state.github)) {
      app.toast("This browser won't save the token, so it only lasts until you close the page.", 5000);
    }
    syncChanged();
    return login;
  },
  disconnect() {
    state.github = null;
    Store.remove('github');
    syncChanged();
  },

  /** The menu closed: show any edits on screen, then publish them if this device can. */
  menuClosed() {
    flushDeck();
    refreshCard();
    applyShared();
    if (state.custom && state.github) publish();
  },
};

// ---------- start up ----------

async function start() {
  const cached = cachedShared();
  let fetched = null;
  try { fetched = await fetchShared(); } catch (err) { console.warn('Could not load the shared deck', err); }
  // Right after publishing, this device knows a newer deck than the site has deployed yet.
  state.shared = fetched && (!cached || fetched.revision >= cached.revision) ? fetched : cached;
  if (!state.shared) {
    showNotice("Couldn't load the cards. Check your connection and reload the page.");
    return;
  }
  if (state.shared === fetched) saveShared();

  const draft = Store.load('deck');
  if (draft) {
    try {
      state.deck = Deck.normalizeDeck(draft);
      state.custom = true;
      state.baseRevision = Number(draft.baseRevision) || 0;
    } catch { state.deck = null; }
  }
  if (state.custom && sameDeck(state.deck, state.shared)) dropDraft();
  if (!state.custom) {
    state.deck = copyOf(state.shared);
    state.baseRevision = state.shared.revision;
  }

  const github = Store.load('github');
  if (github && typeof github.token === 'string' && github.token) state.github = { token: github.token, login: String(github.login || '') };

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

  lastCheck = Date.now();
  const menu = initMenu(app);
  ui.options.addEventListener('click', () => menu.open());
  ui.draw.disabled = false;
}

start();

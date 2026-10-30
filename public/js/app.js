// THE DECK: draw a card, do what it says.
//
// This file holds the deck and keeps it in sync, and switches between the screens:
//   home  - make or join a lobby (game.js), or play on one phone (solo.js)
//   solo  - the original one-phone game
//   room  - a lobby, then the card table where everyone plays on their own phone (game.js, net.js, engine.js)
// The secret menu (options and the card editor) is menu.js, the drawing rules deck.js, publishing sync.js,
// and saving store.js.
//
// Everyone plays the shared deck (cards.json). Editing on a device makes an unpublished copy there.
// A device connected to GitHub publishes its copy when the secret menu closes, and every other phone
// picks up the new shared deck within a minute or two. In a lobby, everyone plays the host's deck.
import * as Deck from './deck.js';
import * as Store from './store.js';
import * as Sync from './sync.js';
import { initMenu } from './menu.js';
import { initSolo } from './solo.js';
import { initGame } from './game.js';
import { initSettings } from './theme.js';

const $ = id => document.getElementById(id);
const ui = {
  menu: $('menu'),
  options: $('options-button'),
  toast: $('toast'),
  screens: { home: $('home'), solo: $('solo'), room: $('room') },
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
  off: new Set(),    // groups switched off in the secret menu (the host's rules in a lobby)
  shoe: [],          // one-phone mode: ids of the cards still to come
  currentId: null,   // one-phone mode: the card on screen
  prevId: null,      // one-phone mode: the card before it (on the discard pile)
  screen: 'home',
};

const copyOf = deck => structuredClone({ groups: deck.groups, cards: deck.cards });
const sameDeck = (a, b) => !!a && !!b && JSON.stringify([a.groups, a.cards]) === JSON.stringify([b.groups, b.cards]);
const menuOpen = () => ui.menu.open;
let solo = null;
let game = null;

// ---------- screens ----------

function showScreen(name) {
  for (const [id, el] of Object.entries(ui.screens)) el.hidden = id !== name;
  state.screen = name;
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
  if (name === 'solo') solo.refresh();
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-home]')) showScreen('home');
});

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
  deckEdited();
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
const rulesChanged = () => game?.rulesChanged();
// A lobby host's phones get the new deck a moment after the editing stops, not on every keystroke.
let deckTimer = null;
function deckEdited() {
  clearTimeout(deckTimer);
  deckTimer = setTimeout(() => game?.deckChanged(), 800);
}

// ---------- switching decks ----------

/**
 * Puts a deck in play. fresh: start a new one-phone shoe (a whole different deck); otherwise the cards
 * already drawn stay drawn, and any new cards join the cards still to come.
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
  if (!menuOpen()) solo.refresh();
  game?.deckChanged();
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

// ---------- what the screens and the secret menu can do ----------

const app = {
  state,
  onSaved: null,      // set by the menu to show "Saved"
  onSyncChange: null, // set by the menu to refresh the "Your Deck" section
  deckChanged,
  flushDeck,
  toast,
  publish,
  showScreen,
  saveShoe,
  openMenu: tab => menu?.open(tab),
  setReplacement(on) { state.replacement = on; saveSettings(); rulesChanged(); },
  setGroupOn(id, on) {
    if (on) state.off.delete(id); else state.off.add(id);
    saveSettings();
    rulesChanged();
  },
  cardsLeft: () => Deck.cardsLeft(state.deck, state.shoe, state.off),
  resetShoe() { state.shoe = Deck.freshShoe(state.deck); saveShoe(); solo.showNotice(''); solo.refresh(); },
  cardAdded(card) { state.shoe.push(card.id); saveShoe(); deckChanged(); },
  cardDeleted(id) {
    state.shoe = state.shoe.filter(x => x !== id);
    saveShoe();
    if (state.currentId === id) solo.clear();
    deckChanged();
  },
  groupDeleted(id) { state.off.delete(id); saveSettings(); deckChanged(); rulesChanged(); },
  /** "Show on Screen" in the card editor: the card goes up in one-phone mode. */
  showCardById(id) {
    if (state.screen === 'room') { toast('Leave the lobby to look at cards in one-phone mode'); return; }
    showScreen('solo');
    solo.showCardById(id);
  },
  inRoom: () => state.screen === 'room',

  /** Makes a whole new deck (an import, or the original cards) this device's edits. */
  replaceDeck(deck) {
    if (!state.custom) state.baseRevision = state.shared?.revision ?? 0;
    state.custom = true;
    useDeck(deck, { fresh: true });
    solo.showNotice('');
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
      toast("This browser won't save the token, so it only lasts until you close the page.", 5000);
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
    solo.refresh();
    applyShared();
    game?.deckChanged();
    if (state.custom && state.github) publish();
  },
};

let menu = null;

/**
 * The secret menu opens after 7 taps in a row on the invisible spot in the top-left corner.
 * Taps have to come within 1.5 seconds of each other, and a tap anywhere else starts the count over.
 */
const SECRET_TAPS = 7;
const SECRET_GAP_MS = 1500;
function openOnSevenTaps() {
  let taps = 0;
  let last = 0;
  document.addEventListener('pointerdown', e => { if (!ui.options.contains(e.target)) taps = 0; }, true);
  ui.options.addEventListener('click', () => {
    const now = Date.now();
    taps = now - last <= SECRET_GAP_MS ? taps + 1 : 1;
    last = now;
    if (taps < SECRET_TAPS) return;
    taps = 0;
    menu.open();
  });
}

// ---------- start up ----------

const cardIdFromHash = () => {
  const m = /^#card-(\d+)$/.exec(location.hash);
  return m ? Number(m[1]) : null;
};
window.addEventListener('hashchange', () => {
  const id = cardIdFromHash();
  if (id == null || state.screen === 'room') return;
  if (solo.showCardById(id, { keepHash: true })) showScreen('solo');
});

async function start() {
  initSettings();
  solo = initSolo(app);
  game = initGame(app);
  const resumed = game.boot(); // straight back into a lobby after a reload, or ?room=12345

  const cached = cachedShared();
  let fetched = null;
  try { fetched = await fetchShared(); } catch (err) { console.warn('Could not load the shared deck', err); }
  // Right after publishing, this device knows a newer deck than the site has deployed yet.
  state.shared = fetched && (!cached || fetched.revision >= cached.revision) ? fetched : cached;
  if (!state.shared) {
    game.homeMessage("Couldn't load the cards. Check your connection and reload the page.");
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

  const current = Store.load('current');
  if (current && Date.now() - current.date < Deck.SHOE_LIFETIME_MS) {
    if (cardIds.has(current.id)) state.currentId = current.id;
    if (cardIds.has(current.prev)) state.prevId = current.prev;
  }

  lastCheck = Date.now();
  menu = initMenu(app);
  openOnSevenTaps();
  solo.enable();
  game.ready();

  if (!resumed) {
    const linked = cardIdFromHash();
    if (linked != null && solo.showCardById(linked, { keepHash: true })) showScreen('solo');
  }
}

start();

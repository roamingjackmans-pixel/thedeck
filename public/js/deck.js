// The deck's rules, kept free of the page so they can be tested (tools/test.mjs).
//
// A deck is { groups: [{ id, name }], cards: [{ id, title, text, flavor, secret?, groups: [groupId…] }] }.
// Groups work like the original site's "requirements": a card only comes up when every group it is in
// is switched on in the secret menu. A card in no groups can always come up.
//
// A card with a secret is a sealed card: whoever draws it sees only the outside ("Give this card to the
// player who…"), and the secret opens on the phone of the player it's given to.
//
// Two groups aren't switched on and off by hand. They follow "Where are you playing?":
//   same-room   cards that need everyone in one room (left out on a video call)
//   video-call  cards made for playing over a video call (only come up on one)

export const FORMAT = 'the-deck';
export const PLACE = { room: 'same-room', call: 'video-call' };
export const isPlaceGroup = id => id === PLACE.room || id === PLACE.call;
export const isSealed = card => !!card?.secret;

/** The groups that are really switched off: the unchecked ones, plus the place that doesn't apply. */
export function playOff(off, remote = false) {
  const set = new Set([...off].filter(id => !isPlaceGroup(id)));
  set.add(remote ? PLACE.room : PLACE.call);
  return set;
}
export const SHOE_LIFETIME_MS = 24 * 60 * 60 * 1000; // like the original, a half-used deck is kept for a day
const MAX_NAME = 80;
const MAX_TITLE = 120;
const MAX_TEXT = 2000;

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r\n?/g, '\n').slice(0, max);
export const cleanName = name => str(name, MAX_NAME).replace(/\s+/g, ' ').trim();

/**
 * Checks and tidies a deck from storage or an imported file. Throws an Error with a readable message
 * if it isn't a deck at all. Unknown fields are dropped, bad ids are replaced, broken group links removed.
 */
export function normalizeDeck(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards)) {
    throw new Error("That file isn't a deck (it has no list of cards).");
  }
  const groups = [];
  const groupIds = new Set();
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || typeof g !== 'object') continue;
    const name = cleanName(g.name);
    if (!name) continue;
    if (groups.some(x => x.name.toLowerCase() === name.toLowerCase())) continue;
    let id = typeof g.id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(g.id) ? g.id : '';
    if (!id || groupIds.has(id)) id = uniqueGroupId(groupIds, name);
    groupIds.add(id);
    groups.push({ id, name });
  }

  const cards = [];
  const cardIds = new Set();
  const pending = []; // cards whose id was missing or taken get one after the rest
  for (const c of raw.cards) {
    if (!c || typeof c !== 'object') continue;
    const card = {
      id: c.id,
      title: str(c.title, MAX_TITLE).trim(),
      text: str(c.text, MAX_TEXT).trim(),
      flavor: str(c.flavor ?? c.flavor_text, MAX_TEXT).trim(),
      groups: [...new Set((Array.isArray(c.groups) ? c.groups : []).filter(id => groupIds.has(id)))],
    };
    const secret = str(c.secret, MAX_TEXT).trim();
    if (secret) card.secret = secret;
    if (!card.title && !card.text) continue;
    if (!card.title) card.title = 'Untitled card';
    if (Number.isInteger(card.id) && card.id > 0 && !cardIds.has(card.id)) cardIds.add(card.id);
    else pending.push(card);
    cards.push(card);
  }
  let next = Math.max(0, ...cardIds) + 1;
  for (const card of pending) card.id = next++;
  return { groups, cards };
}

/** The deck as saved to storage or exported to a file. */
export const serializeDeck = deck => ({ format: FORMAT, version: 1, groups: deck.groups, cards: deck.cards });

export const isEligible = (card, off) => card.groups.every(g => !off.has(g));

export function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A full shoe: every card in the deck, in a random order. */
export const freshShoe = (deck, rand) => shuffle(deck.cards.map(c => c.id), rand);

/**
 * Draws a card.
 *   deck, shoe: the cards still to come (ids), off: Set of switched-off group ids,
 *   replacement: true to put cards back after drawing, lastId: the card on screen now.
 * Returns { card, shoe, reshuffled }. card is null when every card is in a switched-off group.
 * Cards whose groups are off stay in the shoe, so they can come up again if the group is switched back on.
 */
export function drawCard({ deck, shoe, off = new Set(), replacement = false, lastId = null, rand = Math.random }) {
  const byId = new Map(deck.cards.map(c => [c.id, c]));
  const eligible = deck.cards.filter(c => isEligible(c, off));
  if (!eligible.length) return { card: null, shoe, reshuffled: false };

  const pick = list => {
    // Avoid showing the same card twice in a row when there is any choice.
    const choices = list.length > 1 ? list.filter(c => c.id !== lastId) : list;
    return choices[Math.floor(rand() * choices.length)];
  };

  if (replacement) return { card: pick(eligible), shoe, reshuffled: false };

  let reshuffled = false;
  let remaining = shoe.filter(id => byId.has(id));
  let candidates = remaining.map(id => byId.get(id)).filter(c => isEligible(c, off));
  if (!candidates.length) {
    reshuffled = true;
    remaining = freshShoe(deck, rand);
    candidates = remaining.map(id => byId.get(id)).filter(c => isEligible(c, off));
  }
  const card = pick(candidates);
  return { card, shoe: remaining.filter(id => id !== card.id), reshuffled };
}

/** How many cards can still come up before the deck is shuffled again. */
export function cardsLeft(deck, shoe, off) {
  const byId = new Map(deck.cards.map(c => [c.id, c]));
  const playable = deck.cards.filter(c => isEligible(c, off)).length;
  const left = shoe.filter(id => byId.has(id) && isEligible(byId.get(id), off)).length;
  return { left, playable, total: deck.cards.length };
}

// ---- editing ----

function uniqueGroupId(taken, name) {
  const base = cleanName(name).toLowerCase().normalize('NFKD').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'group';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const findGroupByName = (deck, name) => deck.groups.find(g => g.name.toLowerCase() === name.toLowerCase());

/** Adds a group, or returns the existing one with that name. */
export function addGroup(deck, name) {
  const clean = cleanName(name);
  if (!clean) return { error: 'Give the group a name.' };
  const existing = findGroupByName(deck, clean);
  if (existing) return { group: existing, existed: true };
  const group = { id: uniqueGroupId(new Set(deck.groups.map(g => g.id)), clean), name: clean };
  deck.groups.push(group);
  return { group };
}

export function renameGroup(deck, id, name) {
  const clean = cleanName(name);
  const group = deck.groups.find(g => g.id === id);
  if (!group) return { error: 'That group no longer exists.' };
  if (!clean) return { error: 'Give the group a name.' };
  const other = findGroupByName(deck, clean);
  if (other && other.id !== id) return { error: `There's already a group called "${other.name}".` };
  group.name = clean;
  return { group };
}

export function deleteGroup(deck, id) {
  deck.groups = deck.groups.filter(g => g.id !== id);
  for (const c of deck.cards) c.groups = c.groups.filter(g => g !== id);
}

export const cardsInGroup = (deck, id) => deck.cards.filter(c => c.groups.includes(id));

/** Adds a blank card at the top of the deck and returns it. */
export function addCard(deck) {
  const id = Math.max(0, ...deck.cards.map(c => c.id)) + 1;
  const card = { id, title: 'New card', text: '', flavor: '', groups: [] };
  deck.cards.unshift(card);
  return card;
}

export function deleteCard(deck, id) {
  deck.cards = deck.cards.filter(c => c.id !== id);
}

export function setCardInGroup(card, groupId, inGroup) {
  const has = card.groups.includes(groupId);
  if (inGroup && !has) card.groups.push(groupId);
  if (!inGroup && has) card.groups = card.groups.filter(g => g !== groupId);
}

export function cleanCardField(field, value) {
  return str(value, field === 'title' ? MAX_TITLE : MAX_TEXT);
}

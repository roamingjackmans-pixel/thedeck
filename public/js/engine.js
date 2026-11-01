// Multiplayer rules for THE DECK. The host's browser runs these (net.js) and sends the result to every
// phone; each phone then only shows what its own player is allowed to see. Nothing here touches the page,
// so it can be tested (tools/test.mjs).
//
// How a game goes:
//   - Players take turns in the order they joined. On your turn you draw one card from the top of the deck
//     (only one: the next card waits for the next player). A bonus draw card ("Draw another card") gives
//     whoever draws it one more draw that turn, once they've dealt with it.
//   - A drawn card is private: it waits on your phone ("pending") until you choose what to do with it:
//       show it to everyone (it goes face up on the table), give it to another player (it waits on their
//       phone with the same choices), or add it to your hand.
//   - Cards in your hand can be shown, given away or discarded at any time, even when it isn't your turn.
//   - Ending your turn moves every face-up card on the table to the discard pile.
//   - When the deck runs out, the discard pile is shuffled to make a new deck, like a real one.
//   - The host sets the rules: which card groups are in play, the draw style, and whether everyone is in
//     one room or on a video call (that switches the "Same room only" and "Video call only" cards).
//   - Sealed cards (cards with a secret) open when they're given to someone: the card copy remembers it
//     (open: true) wherever it goes next, and who gave it, so the table can say who picked who.
import { hasBonus, isEligible, isSealed, playOff, shuffle } from './deck.js';
import { plain } from './markup.js';

export const PROTO = 4;           // bump when the message format or the rules change
export const MAX_PLAYERS = 16;
export const AUTO_SKIP_MS = 20000;       // someone who drops out on their turn is skipped after this long
const LOG_KEEP = 40;

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ok = { ok: true };
const no = err => ({ ok: false, err });
export const nameOf = (s, pid) => s.players[pid]?.name || 'Someone';
const titleOf = (deck, id) => {
  const card = deck?.cards.find(c => c.id === id);
  return card ? plain(card.title) : 'a card';
};

function log(s, text, now, extra) {
  s.log.push({ id: ++s.logId, at: now, text, ...extra });
  if (s.log.length > LOG_KEEP) s.log.splice(0, s.log.length - LOG_KEEP);
}

// ---------- the room ----------

export function newRoom(code, host, now = Date.now(), rules = {}) {
  const s = {
    v: PROTO, code, hostPid: host.pid, created: now,
    players: {}, order: [], joinSeq: 0,
    phase: 'lobby', rules: { off: [], replacement: false, remote: false }, game: null, gameNo: 0,
    log: [], logId: 0, showSeq: 0, deckKey: 0, quietUntil: 0,
  };
  setRules(s, rules);
  addPlayer(s, host, now);
  s.log = [];
  log(s, `${nameOf(s, host.pid)} opened the lobby`, now);
  return s;
}

/** Someone said hello. Adds them, or gives them their old seat (and hand) back if they were here before. */
export function addPlayer(s, p, now = Date.now()) {
  const pid = clean(p.pid, 24);
  if (!pid) return no('Bad player id');
  const old = s.players[pid];
  const name = clean(p.name, 20) || old?.name || `Player ${s.joinSeq + 1}`;
  if (old) {
    const back = !old.on;
    old.on = true;
    old.offAt = 0;
    old.name = name;
    old.relay = !!p.relay;
    if (back && !(s.quietUntil > now)) log(s, `${name} is back`, now);
    return { ok: true, back };
  }
  const online = s.order.filter(id => s.players[id].on).length;
  if (online >= MAX_PLAYERS) return no(`This lobby is full (${MAX_PLAYERS} players)`);
  s.players[pid] = { pid, name, n: ++s.joinSeq, on: true, offAt: 0, relay: !!p.relay };
  s.order.push(pid);
  log(s, `${name} joined`, now);
  return { ok: true, back: false };
}

export function setOnline(s, pid, on, now = Date.now()) {
  const p = s.players[pid];
  if (!p || p.on === on) return false;
  p.on = on;
  p.offAt = on ? 0 : now;
  if (!on && !(s.quietUntil > now)) log(s, `${p.name} left`, now);
  return true;
}

/** A new host took over the room (the old one dropped out). Everyone else will reconnect shortly. */
export function takeOver(s, pid, offset = 0, now = Date.now()) {
  const old = s.hostPid !== pid ? s.players[s.hostPid] : null;
  s.hostPid = pid;
  for (const id in s.players) {
    const p = s.players[id];
    p.on = id === pid;
    p.offAt = p.on ? 0 : now;
  }
  for (const c of s.game?.table || []) c.at -= offset;
  for (const e of s.log) e.at -= offset;
  s.quietUntil = now + 30000; // everyone reconnecting right now is not news
  const me = nameOf(s, pid);
  log(s, old ? `${me} is now hosting (${old.name} dropped out)` : `${me} is hosting again`, now);
}

function setRules(s, r, deck) {
  if (Array.isArray(r.off)) {
    const known = deck ? new Set(deck.groups.map(g => g.id)) : null;
    s.rules.off = [...new Set(r.off.map(String))].filter(id => !known || known.has(id)).slice(0, 100);
  }
  if (typeof r.replacement === 'boolean') s.rules.replacement = r.replacement;
  if (typeof r.remote === 'boolean') s.rules.remote = r.remote;
}

/** The groups whose cards can't come up under the room's rules. */
const roomOff = s => playOff(s.rules.off, s.rules.remote);

// ---------- the game ----------

function newGame(s, deck, rand) {
  s.gameNo++;
  s.game = {
    turn: null, turnNo: 1, drew: 0, bonus: 0,       // cards drawn this turn, and bonus draws earned
    shoe: shuffle(deck.cards.map(c => c.id), rand), // the deck: the top card is the last one
    discard: [],                                    // face up: the top card is the last one
    hands: {}, pending: {}, table: [],
    nextUid: 0, shuffles: 0,
  };
  const first = s.order.find(id => s.players[id].on);
  s.game.turn = first || null;
}

/** Players still in the game, in turn order. */
const seats = s => s.order.filter(id => s.players[id]);

function passTurn(s, now) {
  const g = s.game;
  const order = seats(s);
  const from = order.indexOf(g.turn);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(from + k + order.length) % order.length];
    if (s.players[id].on) {
      g.turn = id;
      g.turnNo++;
      g.drew = 0;
      g.bonus = 0;
      log(s, `It's ${nameOf(s, id)}'s turn`, now, { turn: id });
      return;
    }
  }
}

function toDiscard(s, card, rand) {
  const g = s.game;
  if (s.rules.replacement) g.shoe.splice(Math.floor(rand() * (g.shoe.length + 1)), 0, card.id);
  else g.discard.push({ uid: card.uid, id: card.id, ...(card.open ? { open: true } : {}) });
}

function clearTable(s, rand) {
  for (const c of s.game.table) toDiscard(s, c, rand);
  s.game.table = [];
}

/** Takes the top card that's in play (its groups are all on). Cards whose groups are off stay put. */
function takeTop(s, byId) {
  const g = s.game;
  const off = roomOff(s);
  g.shoe = g.shoe.filter(id => byId.has(id)); // forget cards deleted from the deck
  for (let i = g.shoe.length - 1; i >= 0; i--) {
    const card = byId.get(g.shoe[i]);
    if (isEligible(card, off)) { g.shoe.splice(i, 1); return card; }
  }
  return null;
}

const take = (list, uid) => {
  const i = list ? list.findIndex(c => c.uid === uid) : -1;
  return i < 0 ? null : list.splice(i, 1)[0];
};
const listFor = (g, kind, pid) => (g[kind][pid] ||= []);
/** A card the player holds: one waiting on their screen, or one in their hand. */
const takeHeld = (g, pid, uid) => take(listFor(g, 'pending', pid), uid) || take(listFor(g, 'hands', pid), uid);
/** What a card copy takes with it when it moves: whether its seal is open, and who gave it. */
const carry = c => (c.open ? { open: true, ...(c.from ? { from: c.from } : {}) } : {});

/** Applies a player's action. Returns { ok } or { ok: false, err } with a message to show them. */
export function apply(s, pid, a, now = Date.now(), deck = null, rand = Math.random) {
  if (!a || typeof a !== 'object' || !s.players[pid]) return no('Bad action');
  const isHost = pid === s.hostPid;
  const me = nameOf(s, pid);
  const g = s.game;

  switch (a.k) {
    case 'profile': {
      const name = clean(a.name, 20);
      if (!name) return no('Type a name');
      if (name !== s.players[pid].name) log(s, `${s.players[pid].name} is now ${name}`, now);
      s.players[pid].name = name;
      return ok;
    }

    // ----- host only -----
    case 'rules':
      if (!isHost) return no('Only the host can change the rules');
      setRules(s, a, deck);
      return ok;
    case 'start':
      if (!isHost) return no('Only the host can start the game');
      if (!deck || !deck.cards.length) return no('The deck has no cards in it');
      newGame(s, deck, rand);
      s.phase = 'play';
      log(s, `The game started. It's ${nameOf(s, s.game.turn)}'s turn`, now, { turn: s.game.turn });
      return ok;
    case 'end':
      if (!isHost) return no('Only the host can end the game');
      s.phase = 'lobby';
      s.game = null;
      log(s, 'The host ended the game', now);
      return ok;
    case 'skip':
      if (!isHost) return no('Only the host can skip a turn');
      if (!g) return no("The game hasn't started");
      log(s, `${me} skipped ${nameOf(s, g.turn)}'s turn`, now);
      clearTable(s, rand);
      passTurn(s, now);
      return ok;
    case 'remove': {
      if (!isHost) return no('Only the host can remove players');
      const who = String(a.pid || '');
      const p = s.players[who];
      if (!p || who === pid) return no("Can't remove that player");
      if (p.on) return no(`${p.name} is still here`);
      if (g) {
        for (const c of [...(g.pending[who] || []), ...(g.hands[who] || [])]) toDiscard(s, c, rand);
        delete g.pending[who];
        delete g.hands[who];
        if (g.turn === who) passTurn(s, now);
      }
      delete s.players[who];
      s.order = s.order.filter(id => id !== who);
      log(s, `${me} removed ${p.name}`, now);
      return ok;
    }
  }

  // ----- playing cards -----
  if (!g || s.phase !== 'play') return no("The game hasn't started");
  const uid = Number(a.uid);

  switch (a.k) {
    case 'draw': {
      if (g.turn !== pid) return no("It's not your turn");
      if (!drawsLeft(s)) {
        return no(g.bonus ? "You've used your bonus draw. End your turn to pass the deck on."
          : 'You already drew your card this turn. End your turn to pass the deck on.');
      }
      if (listFor(g, 'pending', pid).length) return no('Deal with the card you have first');
      if (!deck) return no('The deck is still loading');
      const byId = new Map(deck.cards.map(c => [c.id, c]));
      let card = takeTop(s, byId);
      if (!card && g.discard.length) {
        g.shoe = shuffle(g.shoe.concat(g.discard.map(c => c.id)), rand);
        g.discard = [];
        g.shuffles++;
        log(s, 'The discard pile was shuffled back into the deck', now);
        card = takeTop(s, byId);
      }
      if (!card) return no("There's nothing left to draw. The cards left are switched off or in people's hands.");
      listFor(g, 'pending', pid).push({ uid: ++g.nextUid, id: card.id, from: null });
      log(s, g.drew ? `${me} took a bonus draw` : `${me} drew a card`, now, { by: pid });
      g.drew++;
      if (hasBonus(card)) g.bonus++;
      return ok;
    }
    case 'show': {
      const card = takeHeld(g, pid, uid);
      if (!card) return no("That card isn't yours any more");
      g.table.push({ uid: card.uid, id: card.id, by: pid, at: now, seq: ++s.showSeq, ...carry(card) });
      log(s, `${me} showed everyone "${titleOf(deck, card.id)}"`, now, { by: pid, card: card.id });
      return ok;
    }
    case 'give': {
      const to = String(a.to || '');
      if (!s.players[to]) return no('That player has left');
      if (to === pid) return no("You can't give a card to yourself");
      const card = takeHeld(g, pid, uid);
      if (!card) return no("That card isn't yours any more");
      const sealed = !card.open && isSealed(deck?.cards.find(c => c.id === card.id));
      listFor(g, 'pending', to).push({ uid: card.uid, id: card.id, from: pid, open: true });
      log(s, sealed ? `${me} gave ${nameOf(s, to)} a sealed card` : `${me} gave a card to ${nameOf(s, to)}`, now, { by: pid, to });
      return ok;
    }
    case 'keep': {
      const card = take(listFor(g, 'pending', pid), uid);
      if (!card) return no("That card isn't yours any more");
      listFor(g, 'hands', pid).push({ uid: card.uid, id: card.id, ...carry(card) });
      log(s, `${me} put a card in their hand`, now, { by: pid });
      return ok;
    }
    case 'discard': {
      let card = take(listFor(g, 'hands', pid), uid);
      if (!card) {
        const onTable = g.table.find(c => c.uid === uid);
        if (onTable && (onTable.by === pid || isHost)) card = take(g.table, uid);
      }
      if (!card) return no("You can't discard that card");
      toDiscard(s, card, rand);
      log(s, `${me} discarded "${titleOf(deck, card.id)}"`, now, { by: pid, card: card.id });
      return ok;
    }
    case 'takeback': {
      const onTable = g.table.find(c => c.uid === uid);
      if (!onTable || onTable.by !== pid) return no("That card isn't yours to take");
      take(g.table, uid);
      listFor(g, 'hands', pid).push({ uid: onTable.uid, id: onTable.id, ...carry(onTable) });
      log(s, `${me} took "${titleOf(deck, onTable.id)}" back into their hand`, now, { by: pid });
      return ok;
    }
    case 'endturn': {
      if (g.turn !== pid) return no("It's not your turn");
      if (!g.drew) return no('Draw a card first');
      if (listFor(g, 'pending', pid).length) return no('Deal with your card first: show it, give it away or add it to your hand');
      clearTable(s, rand);
      passTurn(s, now);
      return ok;
    }
  }
  return no('Unknown action');
}

/** Called often by the host. Skips the turn of someone who dropped out. Returns true if anything changed. */
export function tick(s, now = Date.now(), rand = Math.random) {
  const g = s.game;
  if (s.phase !== 'play' || !g) return false;
  const p = s.players[g.turn];
  if (p && p.on) return false;
  if (p && now - p.offAt < AUTO_SKIP_MS) return false;
  if (!s.order.some(id => s.players[id].on)) return false;
  clearTable(s, rand);
  if (!p) {
    g.turn = s.order.find(id => s.players[id].on);
    g.drew = 0;
    g.bonus = 0;
    log(s, `It's ${nameOf(s, g.turn)}'s turn`, now, { turn: g.turn });
    return true;
  }
  log(s, `${p.name} dropped out, so their turn was skipped`, now);
  passTurn(s, now);
  return true;
}

/** The host's deck changed (edited or updated): drop deleted cards from the deck, shuffle new ones in. */
export function syncDeck(s, deck, rand = Math.random) {
  const g = s.game;
  if (!g) return false;
  const ids = new Set(deck.cards.map(c => c.id));
  const seen = new Set(g.shoe);
  for (const list of [g.discard, g.table, ...Object.values(g.hands), ...Object.values(g.pending)]) {
    for (const c of list) seen.add(c.id);
  }
  const before = g.shoe.length;
  g.shoe = g.shoe.filter(id => ids.has(id));
  let added = 0;
  for (const card of deck.cards) {
    if (seen.has(card.id)) continue;
    g.shoe.splice(Math.floor(rand() * (g.shoe.length + 1)), 0, card.id);
    added++;
  }
  return added > 0 || g.shoe.length !== before;
}

// ---------- reading the state (for the screens) ----------

export const isMyTurn = (s, pid) => s.phase === 'play' && s.game?.turn === pid;
export const pendingOf = (s, pid) => s.game?.pending[pid] || [];
export const handOf = (s, pid) => s.game?.hands[pid] || [];
/** How many more cards the player whose turn it is can draw: one a turn, plus any bonus draws. */
export const drawsLeft = s => (s.game ? Math.max(0, 1 + (s.game.bonus || 0) - s.game.drew) : 0);
/** How many cards can still be drawn before the discard pile has to be reshuffled. */
export function drawable(s, deck) {
  const g = s.game;
  if (!g || !deck) return 0;
  const off = roomOff(s);
  const byId = new Map(deck.cards.map(c => [c.id, c]));
  return g.shoe.filter(id => byId.has(id) && isEligible(byId.get(id), off)).length;
}

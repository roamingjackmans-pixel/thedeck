// Online play, peer-to-peer with PeerJS (no game server, so the game runs on any static website).
// Adapted from Horse Race's lobby code.
//
// The person who makes the lobby is the host: their browser owns the room state and runs the rules
// (engine.js). Everyone else connects straight to the host's browser through the free PeerJS matchmaking
// service. The room code is the host's PeerJS id, so joining is just "connect to jjthedeck-v1-<code>".
//
// The host's deck (its cards and groups) is sent to each phone when it joins, in small pieces, and again
// whenever the host's deck changes. The room state itself only refers to cards by id.
//
// If the host disappears (closed the tab, phone went to sleep, left), the other players notice, and the
// first one in line claims the room code and carries on hosting with the last state everyone had.
import * as E from './engine.js';

const PREFIX = 'jjthedeck-v1-';
const roomPeerId = code => PREFIX + code;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const DECK_PART = 40; // cards per deck message, to stay well under data channel size limits

export function genCode() {
  const a = new Uint32Array(5);
  crypto.getRandomValues(a);
  let c = String(1 + (a[0] % 9)); // never starts with 0
  for (let i = 1; i < 5; i++) c += String(a[i] % 10);
  return c;
}
export const cleanCode = c => String(c || '').replace(/\D/g, '').slice(0, 5);

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return () => { this._h[ev] = this._h[ev].filter(f => f !== fn); }; }
  emit(ev, ...a) { for (const f of this._h[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }
}

const netErr = (code, msg) => Object.assign(new Error(msg), { code });

/** Opens a PeerJS peer (with a fixed id, or a random one). Rejects with the PeerJS error type. */
function openPeer(id, ms = 12000) {
  if (!window.Peer) return Promise.reject(netErr('net', 'The connection library did not load. Check your internet and reload.'));
  return new Promise((resolve, reject) => {
    const opts = { debug: 1 };
    const peer = id ? new window.Peer(id, opts) : new window.Peer(opts);
    let done = false;
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onErr);
      if (err) { try { peer.destroy(); } catch { } reject(err); } else resolve(peer);
    };
    const onOpen = () => finish(null);
    const onErr = e => finish(netErr(e?.type || 'net', e?.type === 'unavailable-id' ? 'That room code is taken' : 'Could not reach the matchmaking service'));
    const timer = setTimeout(() => finish(netErr('timeout', 'Could not reach the matchmaking service')), ms);
    peer.on('open', onOpen);
    peer.on('error', onErr);
  });
}

/**
 * One lobby connection. Events:
 *  state(s)        the room state changed
 *  deck(deck)      the host's deck arrived or changed
 *  status(text)    connection status line (null when all is well)
 *  role(role)      became 'host' or 'guest'
 *  error(msg)      an action was refused, or something went wrong
 *  toast(msg)      something worth a small popup
 *  closed(msg)     the connection is gone for good
 */
export class Room extends Emitter {
  /** me: { pid, tab, name }. localDeck(): this device's own deck, used when this device hosts. */
  constructor(me, localDeck) {
    super();
    this.me = me;
    this.localDeck = localDeck;
    this.role = null;
    this.code = null;
    this.state = null;
    this.deck = null;
    this.offset = 0;        // host clock minus my clock (ms)
    this.closed = false;
    this.recovering = false;
    this._pings = [];
    this._timers = [];
    this._deckIn = null;    // deck pieces arriving
  }

  now() { return Date.now() + (this.role === 'host' ? 0 : this.offset); }
  get isHost() { return this.role === 'host'; }

  // ---------- making and joining ----------
  async create(rules) {
    let last;
    this.deck = this.localDeck();
    for (let i = 0; i < 6; i++) {
      const code = genCode();
      try {
        const peer = await openPeer(roomPeerId(code));
        const s = E.newRoom(code, this.me, Date.now(), rules);
        s.deckKey = 1;
        this._host(peer, s);
        return code;
      } catch (e) {
        last = e;
        if (e.code !== 'unavailable-id') break;
      }
    }
    throw last || netErr('net', 'Could not create a lobby');
  }

  async join(code) {
    code = cleanCode(code);
    if (code.length !== 5) throw netErr('badcode', 'Lobby codes are 5 numbers');
    this.code = code;
    await this._tryJoin(code);
  }

  /** Get back into a room after a reload, using what was saved before it. */
  resume(saved) {
    this.code = saved.code;
    this.state = saved.state;
    this.deck = saved.deck || null;
    this.deckKey = saved.deckKey;
    this.offset = saved.offset || 0;
    if (this.deck) this.emit('deck', this.deck);
    this.emit('state', this.state);
    this._recover(saved.state, true);
  }

  // ---------- actions ----------
  act(a) {
    if (this.role === 'host') {
      const r = this._apply(this.me.pid, a);
      if (!r.ok) this.emit('error', r.err);
      return r.ok;
    }
    if (this.role === 'guest' && this.conn?.open) { this._send(this.conn, { t: 'act', a }); return true; }
    this.emit('error', 'Not connected right now, try again in a moment');
    return false;
  }

  /** Host only: play with a different deck from now on (the host edited cards, or got an update). */
  setDeck(deck) {
    if (this.role !== 'host' || !this.state) return;
    this.deck = deck;
    this.state.deckKey = (this.state.deckKey || 0) + 1;
    E.syncDeck(this.state, deck);
    for (const c of this.conns.values()) this._sendDeck(c);
    this.emit('deck', deck);
    this._changed();
  }

  /** Leave on purpose. A host hands the room to the next player. */
  async leave() {
    if (this.closed) return;
    this.closed = true;
    if (this.role === 'host' && this.state) {
      E.setOnline(this.state, this.me.pid, false);
      this._broadcast();
      for (const c of this.conns.values()) this._send(c, { t: 'moved' });
      this.role = 'leaving';
      await sleep(250);
    } else if (this.role === 'guest' && this.conn) {
      this._send(this.conn, { t: 'leave' });
      await sleep(150);
    }
    this._teardown();
  }

  /** Page is closing/reloading: drop connections fast so the others notice, without marking us as gone. */
  drop() { this.closed = true; this._teardown(); }

  // ---------- host side ----------
  _host(peer, state) {
    this._teardown(true);
    this.role = 'host';
    this.peer = peer;
    this.state = state;
    this.code = state.code;
    this.conns = new Map();
    this.offset = 0;
    if (!this.deck) this.deck = this.localDeck();
    peer.on('connection', conn => this._onConn(conn));
    peer.on('error', e => {
      if (this.peer !== peer) return;
      if (e?.type === 'unavailable-id') this._stepDown(); // someone else holds our code now
      else if (e?.type !== 'peer-unavailable') console.warn('host peer error', e?.type);
    });
    this._every(1000, () => { if (E.tick(this.state, Date.now())) this._changed(); });
    this._every(3000, () => this._broadcast()); // heartbeat (lets guests notice a dead host)
    this._every(4000, () => {                   // lost the matchmaking server? get our code back
      if (this.peer === peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { } }
    });
    this.emit('role', 'host');
    this.emit('deck', this.deck);
    this._changed();
  }

  _onConn(conn) {
    let pid = null;
    const drop = m => { this._send(conn, m); setTimeout(() => { try { conn.close(); } catch { } }, 400); };
    const helloTimer = setTimeout(() => { if (!pid) { try { conn.close(); } catch { } } }, 15000);
    conn.on('data', m => {
      if (!m || typeof m !== 'object' || this.role !== 'host') return;
      if (m.t === 'hello') {
        clearTimeout(helloTimer);
        if (m.v !== E.PROTO) return drop({ t: 'err', code: 'version', msg: 'This lobby is running a different version of the game. Reload the page to update.' });
        const id = String(m.pid || '');
        if (!id) return drop({ t: 'err', code: 'bad', msg: 'Bad hello' });
        if (id === this.me.pid) return drop({ t: 'err', code: 'dup', msg: 'You are already in this lobby in another tab' });
        const prev = this.conns.get(id);
        if (prev && prev.open && prev._tab !== m.tab) return drop({ t: 'err', code: 'dup', msg: 'You are already in this lobby in another tab' });
        const r = E.addPlayer(this.state, { pid: id, name: m.name }, Date.now());
        if (!r.ok) return drop({ t: 'err', code: 'full', msg: r.err });
        if (prev) {
          this.conns.delete(id);
          this._send(prev, { t: 'err', code: 'replaced', msg: 'This lobby was opened in another tab' });
          setTimeout(() => { try { prev.close(); } catch { } }, 300);
        }
        pid = id;
        conn._pid = id;
        conn._tab = m.tab;
        this.conns.set(id, conn);
        this._sendDeck(conn); // arrives before the state, which follows shortly
        this._changed();
        return;
      }
      if (!pid || this.conns.get(pid) !== conn) return;
      if (E.tick(this.state, Date.now())) this._changed();
      if (m.t === 'act') this._apply(pid, m.a, conn);
      else if (m.t === 'needdeck') this._sendDeck(conn);
      else if (m.t === 'ping') {
        this._send(conn, { t: 'pong', c: m.c, h: Date.now() });
        if (Date.now() - (this._lastBcast || 0) > 3500) this._broadcast();
      } else if (m.t === 'leave') {
        this.conns.delete(pid);
        if (E.setOnline(this.state, pid, false, Date.now())) this._changed();
        try { conn.close(); } catch { }
      }
    });
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (pid && this.conns?.get(pid) === conn) {
        this.conns.delete(pid);
        if (this.role === 'host' && E.setOnline(this.state, pid, false, Date.now())) this._changed();
      }
    });
    conn.on('error', () => { });
  }

  _sendDeck(conn) {
    const deck = this.deck || { groups: [], cards: [] };
    const key = this.state.deckKey;
    const n = Math.max(1, Math.ceil(deck.cards.length / DECK_PART));
    for (let i = 0; i < n; i++) {
      this._send(conn, {
        t: 'deck', key, i, n,
        groups: i === 0 ? deck.groups : undefined,
        cards: deck.cards.slice(i * DECK_PART, (i + 1) * DECK_PART),
      });
    }
  }

  _apply(pid, a, conn) {
    const r = E.apply(this.state, pid, a, Date.now(), this.deck);
    if (!r.ok && conn) this._send(conn, { t: 'err', code: 'action', msg: r.err });
    if (r.ok) this._changed();
    return r;
  }

  _changed() {
    this.state.rev = (this.state.rev || 0) + 1;
    if (!this._bcastQueued) {
      this._bcastQueued = true;
      setTimeout(() => { this._bcastQueued = false; this._broadcast(); }, 20);
    }
    this.emit('state', this.state);
  }

  _broadcast() {
    if (this.role !== 'host' || !this.conns) return;
    this._lastBcast = Date.now();
    const msg = { t: 'state', s: this.state };
    for (const c of this.conns.values()) this._send(c, msg);
  }

  /** Our room code was taken over by another player while we were cut off: become their guest. */
  _stepDown() {
    if (this.role !== 'host') return;
    const last = clone(this.state);
    for (const c of this.conns.values()) this._send(c, { t: 'moved' });
    this._teardown();
    this.emit('toast', 'Someone else took over hosting, reconnecting to them…');
    this._recover(last, false);
  }

  // ---------- guest side ----------
  _tryJoin(code, ms = 15000) {
    return openPeer(null).then(peer => new Promise((resolve, reject) => {
      if (this.closed) { try { peer.destroy(); } catch { } return reject(netErr('closed', 'Closed')); }
      const conn = peer.connect(roomPeerId(code), { reliable: true, serialization: 'json', metadata: { pid: this.me.pid } });
      let joined = false;
      let failed = false;
      const fail = (c, msg) => {
        if (joined || failed) return;
        failed = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch { }
        reject(netErr(c, msg));
      };
      const timer = setTimeout(() => fail('timeout', "Couldn't connect to that lobby. Check the code, or your network may be blocking it."), ms);
      peer.on('error', e => {
        if (joined) return;
        if (e?.type === 'peer-unavailable') fail('notfound', 'No lobby with that code is open');
        else fail('net', 'Connection problem, try again');
      });
      conn.on('open', () => this._send(conn, { t: 'hello', v: E.PROTO, pid: this.me.pid, tab: this.me.tab, name: this.me.name }));
      conn.on('data', m => {
        if (!m || typeof m !== 'object') return;
        if (!joined) {
          if (m.t === 'deck') this._onDeckPart(m);
          else if (m.t === 'state') { joined = true; clearTimeout(timer); this._guest(peer, conn); this._onGuestMsg(conn, m); resolve(); }
          else if (m.t === 'err') fail(m.code, m.msg);
          return;
        }
        this._onGuestMsg(conn, m);
      });
      conn.on('close', () => { if (!joined) fail('timeout', 'The lobby closed the connection'); else if (this.conn === conn) this._lost(); });
      conn.on('error', () => { });
    }));
  }

  _guest(peer, conn) {
    this._teardown(true);
    this.role = 'guest';
    this.peer = peer;
    this.conn = conn;
    this._lastMsg = Date.now();
    this._pings = [];
    const ping = () => this._send(conn, { t: 'ping', c: Date.now() });
    ping();
    this._every(2000, () => {
      if (this.conn !== conn) return;
      ping();
      if (Date.now() - this._lastMsg > 10000) this._lost(); // host went quiet
    });
    this._every(5000, () => { if (this.peer === peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { } } });
    this.emit('role', 'guest');
  }

  _onDeckPart(m) {
    if (!Array.isArray(m.cards) || !(m.n >= 1)) return;
    if (!this._deckIn || this._deckIn.key !== m.key) this._deckIn = { key: m.key, n: m.n, parts: [], groups: [] };
    const d = this._deckIn;
    if (m.i === 0 && Array.isArray(m.groups)) d.groups = m.groups;
    d.parts[m.i] = m.cards;
    if (d.parts.filter(Boolean).length === d.n) {
      this.deck = { groups: d.groups, cards: d.parts.flat() };
      this.deckKey = d.key;
      this._deckIn = null;
      this.emit('deck', this.deck);
    }
  }

  _onGuestMsg(conn, m) {
    if (this.conn !== conn) return;
    this._lastMsg = Date.now();
    switch (m.t) {
      case 'state':
        if (!m.s || typeof m.s !== 'object') return;
        this.state = m.s;
        this.code = m.s.code;
        // missing the host's current deck (and none on its way): ask for it
        if (m.s.deckKey !== this.deckKey && !this._deckIn && Date.now() - (this._askedDeck || 0) > 3000) {
          this._askedDeck = Date.now();
          this._send(conn, { t: 'needdeck' });
        }
        this.emit('state', this.state);
        break;
      case 'deck':
        this._onDeckPart(m);
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - m.c;
        this._pings.push({ rtt, off: m.h + rtt / 2 - now });
        if (this._pings.length > 8) this._pings.shift();
        this.offset = this._pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
        this.ping = rtt;
        break;
      }
      case 'err':
        if (m.code === 'action') this.emit('error', m.msg);
        else { this.closed = true; this._teardown(); this.emit('closed', m.msg || 'Disconnected'); }
        break;
      case 'moved':
        this._lost('moved');
        break;
    }
  }

  /** Lost the host. Try to find them again, or take over. */
  _lost(moved) {
    if (this.role !== 'guest' || this.closed) return;
    const last = this.state ? clone(this.state) : null;
    this._teardown();
    if (!last) { this.emit('closed', 'Lost connection to the lobby'); return; }
    this._recover(last, moved);
  }

  async _recover(last, quick) {
    if (this.recovering || this.closed) return;
    this.recovering = true;
    this.role = null;
    this.emit('role', null);
    this.emit('status', 'Reconnecting to the lobby…');
    if (quick === 'moved') await sleep(600); // give the old host a moment to let go of the code
    const code = last.code;
    // line up the players who were here, oldest first; the host that just vanished goes last
    const line = last.order.filter(id => last.players[id]?.on && id !== last.hostPid);
    let rank = line.indexOf(this.me.pid);
    if (rank < 0) rank = 0;
    const deadline = Date.now() + 120000;
    let round = 0;
    // a host coming back from a reload tries to grab its room back straight away
    if (quick === true && last.hostPid === this.me.pid && await this._claim(last)) return;
    while (!this.closed && Date.now() < deadline) {
      try {
        await this._tryJoin(code, 9000);
        this.recovering = false;
        this.emit('status', null);
        return;
      } catch (e) {
        if (this.closed) break;
        if (['dup', 'version', 'full', 'replaced'].includes(e.code)) {
          this.recovering = false;
          this.closed = true;
          this.emit('closed', e.message);
          return;
        }
        if (e.code === 'notfound') {
          // nobody is hosting right now. Give a reloading host a moment, then the first in line takes over.
          const wait = round === 0 ? (quick ? 0 : 4000) + rank * 1800 : 300 + Math.random() * 1500;
          await sleep(wait);
          if (this.closed) break;
          if (await this._claim(last)) return;
        } else {
          await sleep(1200);
        }
      }
      round++;
      this.emit('status', `Reconnecting to the lobby… (try ${round + 1})`);
    }
    this.recovering = false;
    if (!this.closed) { this.closed = true; this.emit('closed', 'Lost connection to the lobby'); }
  }

  /** Try to become the host of the room with the last state we saw. False if someone else holds the code. */
  async _claim(last) {
    let peer;
    try { peer = await openPeer(roomPeerId(last.code)); } catch (e) { if (e.code !== 'unavailable-id') await sleep(1500); return false; }
    if (this.closed) { try { peer.destroy(); } catch { } return false; }
    const s = clone(last);
    if (!s.players[this.me.pid]) E.addPlayer(s, this.me);
    const wasHost = s.hostPid === this.me.pid;
    E.takeOver(s, this.me.pid, wasHost ? 0 : this.offset);
    this.recovering = false;
    this._host(peer, s);
    this.emit('status', null);
    if (!wasHost) this.emit('toast', 'You are now hosting this lobby');
    return true;
  }

  // ---------- plumbing ----------
  _send(conn, m) { if (conn?.open) { try { conn.send(m); } catch (e) { console.warn('send failed', e); } } }
  _every(ms, fn) { this._timers.push(setInterval(fn, ms)); }
  _teardown(keepFlags) {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    if (this.conns) { for (const c of this.conns.values()) { try { c.close(); } catch { } } this.conns = null; }
    if (this.conn) { const c = this.conn; this.conn = null; try { c.close(); } catch { } }
    if (this.peer) { const p = this.peer; this.peer = null; try { p.destroy(); } catch { } }
    if (!keepFlags) this.role = null;
  }
}

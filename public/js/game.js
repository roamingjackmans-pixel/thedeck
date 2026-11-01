// Playing together: the home screen (make or join a lobby), the lobby, and the card table.
// The room state comes from net.js (the host runs engine.js); this file draws it and turns taps into actions.
//
// On the table, a big card viewer pops up for whatever needs attention, most important first:
//   1. something you opened yourself (a card in your hand, on the table, the discard pile, host controls)
//   2. a card waiting on you (you drew it, or someone gave it to you): Show to All, Give to Player, Add to Hand
//   3. a card someone just showed everyone
//
// Sealed cards stay sealed on the phone of whoever drew them: they can only give them away (or keep them
// for later). The player they're given to sees them open, and can then show them to everyone as usual.
import { Room, cleanCode } from './net.js';
import * as E from './engine.js';
import * as Store from './store.js';
import { PLACE, hasBonus, isPlaceGroup, isSealed } from './deck.js';
import { faceHtml, flipHtml, flipUp, pileHtml, fitCard } from './cards.js';
import { escapeHtml as esc, plain, render as renderText } from './markup.js';

// Things that belong to this tab (a phone has one), so two tabs on one computer are two players.
const tabStore = {
  get(k, d = null) { try { const v = sessionStorage.getItem(`thedeck.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(`thedeck.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { sessionStorage.removeItem(`thedeck.${k}`); } catch { /* private mode */ } },
};
const rid = (n = 12) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
};
const SESSION_MS = 6 * 60 * 60 * 1000;

export function initGame(app) {
  const $ = id => document.getElementById(id);
  const ui = {
    name: $('name-input'),
    create: $('create-btn'),
    joinForm: $('join-form'),
    code: $('code-input'),
    join: $('join-btn'),
    solo: $('solo-btn'),
    homeMsg: $('home-msg'),
    leave: $('leave-btn'),
    codeBtn: $('code-btn'),
    codeText: $('code-text'),
    hostBtn: $('host-btn'),
    status: $('room-status'),
    lobbyView: $('lobby-view'),
    lobbyPlayers: $('lobby-players'),
    lobbyRules: $('lobby-rules'),
    start: $('start-btn'),
    lobbyWait: $('lobby-wait'),
    tableView: $('table-view'),
    strip: $('players-strip'),
    banner: $('turn-banner'),
    drawPile: $('draw-pile'),
    discardPile: $('discard-pile'),
    pendingPill: $('pending-pill'),
    tableCards: $('table-cards'),
    log: $('game-log'),
    handLabel: $('hand-label'),
    hand: $('hand'),
    endTurn: $('end-turn-btn'),
    viewer: $('viewer'),
    viewerLabel: $('viewer-label'),
    viewerCard: $('viewer-card'),
    viewerBody: $('viewer-body'),
    viewerActions: $('viewer-actions'),
  };
  const TAB = tabStore.get('tab') || (() => { const t = rid(8); tabStore.set('tab', t); return t; })();

  let room = null;
  let s = null;            // the room state
  let deck = null;         // the deck everyone in the room plays (the host's)
  let sentDeck = '';       // host: the deck last sent to the room, to only resend real changes
  let view = null;         // what the player opened in the card viewer
  let viewerKey = '';
  let seenShow = 0;        // shown cards up to this number have already popped up here
  const hidden = new Set();    // waiting cards the player hid for now
  const flipped = new Set();   // cards that already did their turning-over animation
  const known = new Set();     // waiting cards we've already told the player about
  let unsub = [];
  let netStatus = null;    // connection trouble to show at the top, from net.js
  let wake = null;
  let busy = false;

  const me = () => room?.me.pid;
  const cardOf = id => deck?.cards.find(c => c.id === id) || null;
  const nameOf = pid => (pid === me() ? 'You' : E.nameOf(s, pid));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** A copy of a sealed card that nobody has been given yet: it shows the seal, not the inside. */
  const shut = (copy, card = cardOf(copy?.id)) => isSealed(card) && !copy?.open;
  const mini = copy => faceHtml(cardOf(copy.id), { size: 'mini', sealed: shut(copy) });

  // ---------- home ----------

  ui.name.value = Store.load('name', '') || '';
  ui.name.addEventListener('change', () => Store.save('name', ui.name.value.trim()));

  function homeMessage(text) { ui.homeMsg.textContent = text || ''; }
  function readName() {
    const name = ui.name.value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) {
      homeMessage('Type your name first.');
      ui.name.focus();
      return null;
    }
    Store.save('name', name);
    return name;
  }
  function setBusy(on) {
    busy = on;
    ui.create.disabled = on || !app.state.deck;
    ui.join.disabled = on;
  }

  const seatFor = code => tabStore.get('pid') || Store.load(`seat.${code}`, '') || rid();
  function saveSeat(code, pid) {
    tabStore.set('pid', pid);
    Store.save(`seat.${code}`, pid);
  }
  const hostDeck = () => structuredClone({ groups: app.state.deck.groups, cards: app.state.deck.cards });

  async function createLobby() {
    const name = readName();
    if (!name || busy) return;
    setBusy(true);
    homeMessage('Setting up your lobby…');
    const player = { pid: tabStore.get('pid') || rid(), tab: TAB, name };
    const r = new Room(player, hostDeck);
    bind(r);
    try {
      const code = await r.create({ off: [...app.state.off], replacement: app.state.replacement, remote: app.state.remote });
      saveSeat(code, player.pid);
      sentDeck = JSON.stringify(r.deck);
      enterRoom();
      app.toast(`Lobby ${code} is open. Share the code with your friends!`, 3500);
    } catch (e) {
      console.warn(e);
      unbind();
      homeMessage(e.message || 'Could not make a lobby. Check your internet and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function joinLobby(raw) {
    const code = cleanCode(raw);
    if (code.length !== 5) { homeMessage('Lobby codes are 5 numbers.'); ui.code.focus(); return; }
    const name = readName();
    if (!name || busy) return;
    setBusy(true);
    homeMessage(`Looking for lobby ${code}…`);
    let pid = seatFor(code);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = new Room({ pid, tab: TAB, name }, hostDeck);
      bind(r);
      try {
        await r.join(code);
        saveSeat(code, pid);
        enterRoom();
        setBusy(false);
        return;
      } catch (e) {
        unbind();
        if (e.code === 'dup' && attempt === 0) { pid = rid(); tabStore.set('pid', pid); continue; }
        homeMessage(e.message || 'Could not join that lobby.');
        break;
      }
    }
    setBusy(false);
  }

  ui.create.addEventListener('click', createLobby);
  ui.joinForm.addEventListener('submit', e => { e.preventDefault(); joinLobby(ui.code.value); });
  ui.code.addEventListener('input', () => { ui.code.value = cleanCode(ui.code.value); });
  ui.solo.addEventListener('click', () => app.showScreen('solo'));

  // ---------- the room connection ----------

  // in the browser console: deckTrace() shows how this tab's connection went
  window.deckTrace = () => (room && room.trace ? room.trace.join(' | ') : '');

  function bind(r) {
    room = r;
    s = null;
    deck = null;
    netStatus = null;
    view = null;
    viewerKey = '';
    hidden.clear();
    known.clear();
    unsub = [
      r.on('state', st => onState(st)),
      r.on('deck', d => { deck = d; render(); }),
      r.on('status', t => { netStatus = t; render(); }),
      r.on('error', msg => { app.toast(msg, 3500); viewerKey = ''; renderViewer(); }),
      r.on('toast', msg => app.toast(msg, 3500)),
      r.on('progress', msg => homeMessage(msg)),
      r.on('role', () => { viewerKey = ''; if (s) render(); }),
      r.on('closed', msg => onClosed(msg)),
    ];
  }
  function unbind() {
    for (const u of unsub) u();
    unsub = [];
    room = null;
    s = null;
    deck = null;
    document.body.classList.remove('in-room');
  }

  function enterRoom() {
    homeMessage('');
    document.body.classList.add('in-room');
    app.showScreen('room');
    keepAwake(true);
    render();
  }

  function onClosed(msg) {
    const code = room?.code;
    tabStore.del('session');
    unbind();
    keepAwake(false);
    hideViewer();
    app.showScreen('home');
    if (code) ui.code.value = code;
    homeMessage(`${msg || 'Lost the connection to the lobby.'}${code ? ' Tap Join to try again.' : ''}`);
  }

  ui.leave.addEventListener('click', async () => {
    if (!room || !confirm('Leave this lobby?')) return;
    const r = room;
    tabStore.del('session');
    unbind();
    keepAwake(false);
    hideViewer();
    app.showScreen('home');
    homeMessage('');
    await r.leave();
  });

  ui.codeBtn.addEventListener('click', async () => {
    if (!room?.code) return;
    const link = `${location.origin}${location.pathname}?room=${room.code}`;
    const text = `Join my game of THE DECK! Lobby code ${room.code}`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'THE DECK', text, url: link }); return; } catch { /* fall back to copying */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      app.toast('Invite link copied. Send it to your friends!');
    } catch {
      app.toast(`Lobby code: ${room.code}`);
    }
  });

  let saveTimer = 0;
  function saveSession() {
    if (!room || !s || room.closed) return;
    tabStore.set('session', {
      code: s.code, pid: me(), state: s, deck: room.deck, deckKey: room.deckKey ?? s.deckKey,
      offset: room.offset, at: Date.now(), seenShow,
    });
  }
  window.addEventListener('pagehide', () => {
    if (!room) return;
    saveSession();
    room.drop();
  });
  window.addEventListener('pageshow', e => { if (e.persisted && room) location.reload(); });

  async function keepAwake(on) {
    try {
      if (on && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      } else if (!on && wake) {
        await wake.release();
        wake = null;
      }
    } catch { /* not allowed right now */ }
  }
  document.addEventListener('visibilitychange', () => { if (room && document.visibilityState === 'visible') keepAwake(true); });

  function onState(st) {
    const first = !s;
    s = st;
    if (first && !tabStore.get('session')) seenShow = s.showSeq; // don't pop up cards shown before we arrived
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; saveSession(); }, 700);
    noticeNewCards();
    render();
  }

  /** Tell the player when someone hands them a card. */
  function noticeNewCards() {
    const mine = E.pendingOf(s, me());
    for (const c of mine) {
      if (known.has(c.uid)) continue;
      known.add(c.uid);
      if (c.from && c.from !== me()) {
        hidden.delete(c.uid);
        try { navigator.vibrate?.(150); } catch { /* not supported */ }
      }
    }
  }

  // ---------- drawing the room ----------

  function render() {
    if (!room) return;
    // "Reconnecting…" from net.js, or "Connecting…" until the first state arrives
    const status = netStatus || (s ? '' : 'Connecting to the lobby…');
    ui.status.hidden = !status;
    ui.status.textContent = status;
    if (!s) {
      ui.lobbyView.hidden = true;
      ui.tableView.hidden = true;
      return;
    }
    ui.codeText.textContent = s.code;
    const isHost = s.hostPid === me();
    ui.hostBtn.hidden = !isHost || s.phase !== 'play';
    ui.lobbyView.hidden = s.phase !== 'lobby';
    ui.tableView.hidden = s.phase !== 'play';
    if (s.phase === 'lobby') renderLobby();
    else renderTable();
    renderViewer();
  }

  function rulesHtml(editable) {
    const groups = (deck?.groups || []).filter(g => !isPlaceGroup(g.id));
    const off = new Set(s.rules.off);
    const count = id => deck.cards.filter(c => c.groups.includes(id)).length;
    const dis = editable ? '' : ' disabled';
    const list = groups.length
      ? groups.map(g => `<label class="rule-check">
          <input type="checkbox" data-rule-group="${g.id}"${off.has(g.id) ? '' : ' checked'}${dis}>
          <span>${esc(g.name)}</span><small>${plural(count(g.id), 'card')}</small></label>`).join('')
      : '<p class="rules-help">This deck has no card groups.</p>';
    const call = deck?.groups.some(g => g.id === PLACE.call) ? count(PLACE.call) : 0;
    const room = deck?.groups.some(g => g.id === PLACE.room) ? count(PLACE.room) : 0;
    const place = call || room ? `<div class="rule-place">
        <label class="rule-check"><input type="radio" name="rule-place" value="room"${s.rules.remote ? '' : ' checked'}${dis}>
          <span>Together in one room</span></label>
        <label class="rule-check"><input type="radio" name="rule-place" value="call"${s.rules.remote ? ' checked' : ''}${dis}>
          <span>On a video call</span></label>
        <p class="rules-help">${s.rules.remote
          ? `Playing on a call: ${plural(call, 'video call card')} come up, and ${plural(room, 'card')} that need everyone in one room stay out.`
          : `Playing in one room: the ${plural(call, 'video call card')} stay out.`}</p>
      </div>` : '';
    return `<h3 class="area-label">Rules</h3>
      ${place ? `<h4 class="rules-sub">Where are you playing?</h4>${place}<h4 class="rules-sub">Card groups</h4>` : ''}
      <p class="rules-help">${editable ? 'Uncheck a group to keep its cards out of the deck.' : 'The host sets the rules. Unchecked groups stay out of the deck.'}</p>
      <div class="rule-groups">${list}</div>
      <div class="rule-style">
        <label class="rule-check"><input type="radio" name="rule-style" value="no"${s.rules.replacement ? '' : ' checked'}${dis}>
          <span>Discarded cards stay out until the deck runs out</span></label>
        <label class="rule-check"><input type="radio" name="rule-style" value="yes"${s.rules.replacement ? ' checked' : ''}${dis}>
          <span>Discarded cards go straight back into the deck</span></label>
      </div>`;
  }

  /** The host changed a rule: it goes through the same settings as the secret menu. */
  function onRuleInput(e) {
    const box = e.target.closest('[data-rule-group]');
    if (box) app.setGroupOn(box.dataset.ruleGroup, box.checked);
    if (e.target.name === 'rule-style' && e.target.checked) app.setReplacement(e.target.value === 'yes');
    if (e.target.name === 'rule-place' && e.target.checked) app.setRemote(e.target.value === 'call');
  }
  ui.lobbyRules.addEventListener('change', onRuleInput);

  function renderLobby() {
    const isHost = s.hostPid === me();
    ui.lobbyPlayers.innerHTML = s.order.map(id => {
      const p = s.players[id];
      const tags = `${id === s.hostPid ? '<span class="tag">HOST</span>' : ''}${id === me() ? '<span class="tag you">YOU</span>' : ''}${p.on ? (p.relay ? '<span class="tag relay" title="Connected through the backup relay (a direct connection did not work for them)">RELAY</span>' : '') : '<span class="tag away">AWAY</span>'}`;
      const edit = id === me() ? '<button type="button" class="btn-link" data-rename>Change name</button>' : '';
      const remove = isHost && !p.on && id !== me() ? `<button type="button" class="btn-link danger" data-remove="${esc(id)}">Remove</button>` : '';
      return `<li class="${p.on ? '' : 'away'}"><span class="lp-name">${esc(p.name)}</span>${tags}${edit}${remove}</li>`;
    }).join('');
    // Don't redraw the rules while the host is tapping them.
    const rulesKey = JSON.stringify([isHost, s.rules, deck?.groups]);
    if (ui.lobbyRules.dataset.key !== rulesKey) {
      ui.lobbyRules.dataset.key = rulesKey;
      ui.lobbyRules.innerHTML = deck ? rulesHtml(isHost) : '<p class="rules-help">Loading the deck…</p>';
    }
    ui.start.hidden = !isHost;
    ui.start.disabled = !deck;
    const n = s.order.filter(id => s.players[id].on).length;
    ui.lobbyWait.textContent = isHost
      ? `${plural(n, 'player')} here. Tap Invite to share the lobby, and start when everyone's in.`
      : `Waiting for ${E.nameOf(s, s.hostPid)} to start the game…`;
  }

  ui.lobbyPlayers.addEventListener('click', e => {
    if (e.target.closest('[data-rename]')) {
      const name = prompt('Your name', E.nameOf(s, me()));
      if (name && name.trim()) {
        Store.save('name', name.trim().slice(0, 20));
        ui.name.value = name.trim().slice(0, 20);
        room.me.name = name.trim().slice(0, 20);
        room.act({ k: 'profile', name });
      }
    }
    const rm = e.target.closest('[data-remove]');
    if (rm && confirm(`Remove ${E.nameOf(s, rm.dataset.remove)} from the lobby?`)) room.act({ k: 'remove', pid: rm.dataset.remove });
  });
  ui.start.addEventListener('click', () => room?.act({ k: 'start' }));

  function renderTable() {
    const g = s.game;
    const pid = me();
    const myTurn = g.turn === pid;
    const waiting = E.pendingOf(s, pid);

    ui.strip.innerHTML = s.order.map(id => {
      const p = s.players[id];
      const inHand = (g.hands[id] || []).length;
      const looking = (g.pending[id] || []).length;
      return `<li class="seat${id === g.turn ? ' turn' : ''}${p.on ? '' : ' away'}${id === pid ? ' me' : ''}">
        <span class="seat-name">${id === s.hostPid ? '<span class="crown" title="Host">♛</span>' : ''}${esc(id === pid ? 'You' : p.name)}</span>
        <span class="seat-info"><i class="mini-back" aria-hidden="true"></i>${inHand}${looking ? ' · <span class="looking">looking at a card</span>' : ''}${p.on ? '' : ' · away'}</span>
      </li>`;
    }).join('');

    if (myTurn) {
      ui.banner.textContent = waiting.length ? "Your turn. Choose what to do with your card."
        : !g.drew ? 'Your turn! Tap the deck to draw a card.'
        : E.drawsLeft(s) ? 'Bonus draw! Tap the deck to draw one more card.'
        : "That's your card for this turn. End your turn when you're done.";
    } else {
      const looking = E.pendingOf(s, g.turn).length;
      ui.banner.textContent = `${E.nameOf(s, g.turn)}'s turn${looking ? ' · looking at a card…' : ''}`;
    }
    ui.banner.classList.toggle('mine', myTurn);

    const canDraw = myTurn && E.drawsLeft(s) > 0 && !waiting.length;
    const left = E.drawable(s, deck);
    ui.drawPile.innerHTML = left
      ? pileHtml(left, { label: `${left} left`, active: canDraw })
      : `<div class="pile-empty"></div><span class="pile-label">${g.discard.length ? 'Reshuffle' : 'Empty'}</span>`;
    ui.drawPile.disabled = !canDraw;
    ui.drawPile.classList.toggle('can-draw', canDraw);

    const top = g.discard.at(-1);
    ui.discardPile.innerHTML = top
      ? `<div class="discard-top">${mini(top)}</div><span class="pile-label">${plural(g.discard.length, 'discard')}</span>`
      : '<div class="pile-empty"></div><span class="pile-label">Discard pile</span>';
    ui.discardPile.disabled = !top;

    const waitingHidden = waiting.filter(c => hidden.has(c.uid)).length;
    ui.pendingPill.hidden = !waitingHidden;
    ui.pendingPill.textContent = `${plural(waitingHidden, 'card')} waiting for you · Open`;

    ui.tableCards.innerHTML = g.table.length
      ? g.table.map(c => `<button type="button" class="card-btn" data-table="${c.uid}">
          ${mini(c)}<span class="card-by">${esc(nameOf(c.by))}</span></button>`).join('')
      : '<p class="area-empty">Cards shown to everyone land here.</p>';

    ui.log.innerHTML = s.log.slice(-4).reverse().map(e => `<li>${esc(e.text)}</li>`).join('');

    const hand = E.handOf(s, pid);
    ui.handLabel.textContent = `Your hand (${hand.length})`;
    ui.hand.innerHTML = hand.length
      ? hand.map(c => `<button type="button" class="card-btn" data-hand="${c.uid}">${mini(c)}</button>`).join('')
      : '<p class="area-empty">Cards you keep go here. Play them any time, even when it isn\'t your turn.</p>';

    ui.endTurn.hidden = !myTurn;
    ui.endTurn.disabled = !g.drew || waiting.length > 0;
  }

  ui.drawPile.addEventListener('click', () => room?.act({ k: 'draw' }));
  ui.discardPile.addEventListener('click', () => { view = { kind: 'discard' }; renderViewer(); });
  ui.endTurn.addEventListener('click', () => room?.act({ k: 'endturn' }));
  ui.pendingPill.addEventListener('click', () => { hidden.clear(); renderViewer(); render(); });
  ui.hostBtn.addEventListener('click', () => { view = { kind: 'host' }; renderViewer(); });
  ui.tableCards.addEventListener('click', e => {
    const b = e.target.closest('[data-table]');
    if (b) { view = { kind: 'table', uid: Number(b.dataset.table) }; renderViewer(); }
  });
  ui.hand.addEventListener('click', e => {
    const b = e.target.closest('[data-hand]');
    if (b) { view = { kind: 'hand', uid: Number(b.dataset.hand) }; renderViewer(); }
  });

  // ---------- the card viewer ----------

  /** Where a card is right now, as far as this player can see. */
  function locate(uid) {
    const g = s?.game;
    if (!g) return null;
    const pid = me();
    const inList = (list, where) => { const c = list?.find(x => x.uid === uid); return c ? { ...c, where } : null; };
    return inList(g.pending[pid], 'pending') || inList(g.hands[pid], 'hand') || inList(g.table, 'table');
  }

  function currentView() {
    if (!s || s.phase !== 'play' || !s.game) return view?.kind === 'rules' ? view : null;
    const g = s.game;
    const pid = me();
    if (view) {
      const stillThere = ['discard', 'host', 'rules'].includes(view.kind)
        || (view.kind === 'give' && ['pending', 'hand'].includes(locate(view.uid)?.where))
        || (view.kind === 'hand' && locate(view.uid)?.where === 'hand')
        || (view.kind === 'table' && locate(view.uid)?.where === 'table');
      if (view.kind === 'discard' && !g.discard.length) view = null;
      else if (!stillThere) view = null;
    }
    if (view) return view;
    const waiting = E.pendingOf(s, pid).find(c => !hidden.has(c.uid));
    if (waiting) return { kind: 'pending', uid: waiting.uid };
    const shown = g.table.filter(c => c.seq > seenShow && c.by !== pid).sort((a, b) => a.seq - b.seq)[0];
    if (shown) return { kind: 'shown', uid: shown.uid, seq: shown.seq };
    return null;
  }

  function hideViewer() {
    ui.viewer.hidden = true;
    viewerKey = '';
    document.body.classList.remove('viewing');
  }

  const button = (act, label, cls = 'btn-light', extra = '') => `<button type="button" class="btn ${cls}" data-va="${act}"${extra}>${label}</button>`;

  function renderViewer() {
    const v = currentView();
    if (!v || !room) { hideViewer(); return; }
    const g = s?.game;
    const pid = me();
    const isHost = s?.hostPid === pid;
    const at = v.uid != null ? locate(v.uid) : null;
    const card = at ? cardOf(at.id) : null;
    const others = s ? s.order.filter(id => id !== pid).map(id => [id, s.players[id].name, s.players[id].on]) : [];
    const key = JSON.stringify([v, at, card?.id, card?.title, card?.text, card?.flavor, isHost, others, g?.discard.length, g?.turn, s?.rules, deck?.groups]);
    if (key === viewerKey) return;
    viewerKey = key;

    let label = '';
    let cardHtml = '';
    let body = '';
    let actions = '';
    let flip = false;
    const sealed = at ? shut(at, card) : false;
    const big = (c, o = {}) => faceHtml(c, { size: 'big', sealed, ...o });
    const still = c => `<div class="flip up"><div class="flip-inner">${big(c)}</div></div>`;
    // A card that's new on this phone turns over (and a sealed one given to you opens as it lands).
    const turning = (uid, c) => {
      if (flipped.has(uid)) return still(c);
      flipped.add(uid);
      flip = true;
      return flipHtml(c, { sealed, opening: isSealed(c) && !sealed });
    };
    // "Sam picked Alex": shown with a sealed card that was given to the player who has it now.
    const picked = isSealed(card) && at?.from ? ` · ${esc(nameOf(at.from))} picked ${at.by === pid ? 'you' : esc(nameOf(at.by))}` : '';

    switch (v.kind) {
      case 'pending':
        if (sealed) {
          label = 'You drew a sealed card. Read who it\'s for, then give it to them.' + (hasBonus(card) ? ' You get a bonus draw.' : '');
          actions = button('give', 'Give to Player', 'btn-gold') + button('keep', 'Keep It for Later');
        } else {
          label = !at.from ? (hasBonus(card) ? 'Bonus draw! Deal with this card, then draw one more.' : 'You drew this card. Only you can see it.')
            : isSealed(card) ? `${esc(E.nameOf(s, at.from))} picked you for this sealed card. Only you can see inside.`
            : `${esc(E.nameOf(s, at.from))} gave you this card`;
          actions = button('show', 'Show to All', 'btn-gold') + button('give', 'Give to Player') + button('keep', 'Add to Hand');
        }
        cardHtml = turning(v.uid, card);
        actions += '<button type="button" class="btn-link light" data-va="hide">Hide it for now</button>';
        break;
      case 'hand':
        label = sealed ? 'Sealed, in your hand. Give it to someone when you\'re ready.' : 'In your hand. Play it any time.';
        cardHtml = still(card);
        actions = (sealed ? button('give', 'Give to Player', 'btn-gold') : button('show', 'Show to All', 'btn-gold') + button('give', 'Give to Player'))
          + button('discard', 'Discard') + button('close', 'Close', 'btn-ghost');
        break;
      case 'table': {
        const mine = at.by === pid;
        label = `${mine ? 'You' : esc(E.nameOf(s, at.by))} showed everyone this card${picked}`;
        cardHtml = still(card);
        if (mine) actions += button('takeback', 'Back to My Hand') + button('discard', 'Discard');
        else if (isHost) actions += button('discard', 'Discard');
        actions += button('close', 'Close', 'btn-ghost');
        if (mine) body = '<p class="viewer-note">Cards on the table go to the discard pile when the turn ends.</p>';
        break;
      }
      case 'shown':
        label = `${esc(E.nameOf(s, at.by))} shows everyone${picked}`;
        cardHtml = turning(v.uid, card);
        actions = button('seen', 'OK', 'btn-gold');
        break;
      case 'discard': {
        const top = g.discard.at(-1);
        label = `Top of the discard pile (${plural(g.discard.length, 'card')})`;
        cardHtml = `<div class="flip up"><div class="flip-inner">${big(cardOf(top.id), { sealed: shut(top) })}</div></div>`;
        actions = button('close', 'Close', 'btn-ghost');
        break;
      }
      case 'give':
        label = sealed ? 'Who gets it?' : 'Give this card to…';
        cardHtml = `<div class="viewer-small">${faceHtml(card, { size: 'mini', sealed })}</div>`;
        if (sealed) body = `<div class="give-prompt">${renderText(card.text)}</div>`;
        body += others.length
          ? `<div class="give-list">${others.map(([id, name, on]) => `<button type="button" class="btn btn-light give-to" data-va="give-to" data-to="${esc(id)}">
              ${esc(name)}${on ? '' : ' <small>(away, they get it when they\'re back)</small>'}</button>`).join('')}</div>`
          : '<p class="viewer-note">Nobody else is here yet.</p>';
        actions = button('back', 'Cancel', 'btn-ghost');
        break;
      case 'host': {
        label = 'Host controls';
        const away = s.order.filter(id => !s.players[id].on && id !== pid);
        body = `<div class="give-list">
          ${g.turn && g.turn !== pid ? button('skip', `Skip ${esc(E.nameOf(s, g.turn))}'s turn`) : ''}
          ${button('rules', 'Change the rules')}
          ${away.map(id => button('remove', `Remove ${esc(E.nameOf(s, id))} (away)`, 'btn-light', ` data-pid="${esc(id)}"`)).join('')}
          ${button('end', 'End the game', 'btn-danger')}
        </div>`;
        actions = button('close', 'Close', 'btn-ghost');
        break;
      }
      case 'rules':
        label = 'Rules';
        body = `<div class="rules-panel in-viewer">${rulesHtml(true)}</div>`;
        actions = button('close', 'Done', 'btn-gold');
        break;
    }

    ui.viewerLabel.innerHTML = label;
    ui.viewerCard.innerHTML = cardHtml;
    ui.viewerBody.innerHTML = body;
    ui.viewerActions.innerHTML = actions;
    ui.viewer.hidden = false;
    ui.viewer.dataset.kind = v.kind;
    document.body.classList.add('viewing');
    fitCard(ui.viewerCard);
    if (flip) flipUp(ui.viewerCard);
  }

  ui.viewerBody.addEventListener('change', onRuleInput);

  ui.viewer.addEventListener('click', e => {
    const b = e.target.closest('[data-va]');
    if (!b || !room) return;
    const v = currentView();
    if (!v) return;
    const act = a => { room.act(a); };
    switch (b.dataset.va) {
      case 'show': act({ k: 'show', uid: v.uid }); view = null; break;
      case 'keep': act({ k: 'keep', uid: v.uid }); break;
      case 'discard': act({ k: 'discard', uid: v.uid }); view = null; break;
      case 'takeback': act({ k: 'takeback', uid: v.uid }); view = null; break;
      case 'give': view = { kind: 'give', uid: v.uid, back: v.kind }; break;
      case 'give-to': act({ k: 'give', uid: v.uid, to: b.dataset.to }); view = null; break;
      case 'back': view = v.back === 'hand' ? { kind: 'hand', uid: v.uid } : null; break;
      case 'hide': hidden.add(v.uid); render(); break;
      case 'seen':
        seenShow = Math.max(seenShow, v.seq);
        saveSession();
        break;
      case 'close': view = null; break;
      case 'skip': act({ k: 'skip' }); view = null; break;
      case 'rules': view = { kind: 'rules' }; break;
      case 'remove':
        if (confirm(`Remove ${E.nameOf(s, b.dataset.pid)} from the game? Their cards go to the discard pile.`)) act({ k: 'remove', pid: b.dataset.pid });
        break;
      case 'end':
        if (!confirm('End the game for everyone and go back to the lobby?')) return;
        act({ k: 'end' });
        view = null;
        break;
    }
    viewerKey = '';
    renderViewer();
    // Until the host answers, the same card stays up: don't let a double tap send it twice.
    const sent = ['show', 'keep', 'discard', 'takeback', 'give-to'].includes(b.dataset.va);
    if (sent && currentView()?.uid === v.uid) {
      for (const btn of ui.viewer.querySelectorAll('button')) btn.disabled = true;
      setTimeout(() => { viewerKey = ''; renderViewer(); }, 4000); // in case the answer never comes
    }
  });

  window.addEventListener('resize', () => { if (!ui.viewer.hidden) fitCard(ui.viewerCard); });

  // ---------- what app.js calls ----------

  return {
    /** Back into a lobby after a reload, or straight to joining from an invite link. True if in a lobby now. */
    boot() {
      const params = new URLSearchParams(location.search);
      const urlCode = cleanCode(params.get('room'));
      const saved = tabStore.get('session');
      if (saved?.state && Date.now() - saved.at < SESSION_MS && (!urlCode || urlCode === saved.code)) {
        const sp = saved.state.players?.[saved.pid];
        const player = { pid: saved.pid, tab: TAB, name: sp?.name || Store.load('name', '') || 'Player' };
        const r = new Room(player, hostDeck);
        bind(r);
        seenShow = saved.seenShow || 0;
        if (saved.state.game) for (const c of saved.state.game.pending[saved.pid] || []) { known.add(c.uid); flipped.add(c.uid); }
        enterRoom();
        r.resume(saved);
        return true;
      }
      if (urlCode) {
        ui.code.value = urlCode;
        if (Store.load('name', '')) joinLobby(urlCode);
        else { homeMessage('Type your name, then tap Join to get in.'); ui.name.focus(); }
      }
      return false;
    },
    /** The deck has loaded: making a lobby and one-phone play can start. */
    ready() {
      ui.create.disabled = busy;
      ui.solo.disabled = false;
    },
    homeMessage,
    /** The host changed a rule (here or in the secret menu): tell the room. */
    rulesChanged() {
      if (room?.isHost) room.act({ k: 'rules', off: [...app.state.off], replacement: app.state.replacement, remote: app.state.remote });
    },
    /** The host's deck changed: send it to the room if it really did. */
    deckChanged() {
      if (!room?.isHost || !app.state.deck) return;
      const next = hostDeck();
      const json = JSON.stringify(next);
      if (json === sentDeck) return;
      sentDeck = json;
      room.setDeck(next);
    },
  };
}

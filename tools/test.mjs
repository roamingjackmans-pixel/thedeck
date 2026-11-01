// Checks the deck rules, the card formatting, and the card data.   node tools/test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as Deck from '../public/js/deck.js';
import * as Sync from '../public/js/sync.js';
import * as E from '../public/js/engine.js';
import * as T from '../public/js/theme.js';
import { render, inline, plain } from '../public/js/markup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const pending = [];
const test = (name, fn) => {
  const fail = err => { console.error(`FAIL ${name}\n`, err); process.exitCode = 1; };
  try {
    const result = fn();
    if (result?.then) pending.push(result.then(() => { passed++; }, fail));
    else passed++;
  } catch (err) { fail(err); }
};

// A seeded random number generator so failures can be reproduced.
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const readJson = file => JSON.parse(fs.readFileSync(path.join(root, 'public', file), 'utf8'));
const original = Deck.normalizeDeck(readJson('original-cards.json'));
const clone = () => structuredClone(original);

// ---------- the card data ----------

// cards.json is the deck everyone plays. It changes whenever someone publishes from the secret menu,
// so it is only checked for being a well-formed deck (a broken one would stop the site deploying).
test('the shared deck is a well-formed deck', () => {
  const raw = readJson('cards.json');
  assert.equal(raw.format, 'the-deck');
  assert.ok(Number.isInteger(raw.revision) && raw.revision >= 1, 'has a revision number');
  assert.deepEqual(Deck.normalizeDeck(raw), { groups: raw.groups, cards: raw.cards }, 'nothing in it needs fixing');
  for (const c of raw.cards) {
    assert.ok(!(c.groups.includes(Deck.PLACE.room) && c.groups.includes(Deck.PLACE.call)), `card ${c.id} can come up somewhere`);
    for (const html of [inline(c.title), render(c.text), render(c.secret || ''), render(c.flavor)]) {
      assert.ok(!/\*\*|\]\(/.test(html), `card ${c.id} has no leftover markup: ${html}`);
    }
  }
});

test('sealed cards keep their secret, and an empty one makes an ordinary card', () => {
  const d = Deck.normalizeDeck({ cards: [
    { id: 1, title: 'Worst Kisser', text: 'Give this to…', secret: '  Drink 3.  ' },
    { id: 2, title: 'Plain', text: 'x', secret: '   ' },
  ] });
  assert.equal(d.cards[0].secret, 'Drink 3.');
  assert.ok(Deck.isSealed(d.cards[0]));
  assert.equal('secret' in d.cards[1], false);
  assert.ok(!Deck.isSealed(d.cards[1]));
});

test('a bonus draw is kept only when it is switched on, and the draw-again cards have one', () => {
  const d = Deck.normalizeDeck({ cards: [
    { id: 1, title: 'Again', text: 'Draw another card.', bonus: true },
    { id: 2, title: 'Not quite', text: 'x', bonus: 'yes' },
    { id: 3, title: 'Plain', text: 'x' },
  ] });
  assert.deepEqual(d.cards.map(Deck.hasBonus), [true, false, false]);
  assert.equal('bonus' in d.cards[1], false);
  for (const deck of [Deck.normalizeDeck(readJson('cards.json')), original]) {
    assert.deepEqual(deck.cards.filter(Deck.hasBonus).map(c => c.id), [128, 141]);
  }
});

test('"Where are you playing?" switches the same-room and video call cards', () => {
  const deck = {
    groups: [{ id: 'snow', name: 'Snow' }, { id: Deck.PLACE.room, name: 'Same room only' }, { id: Deck.PLACE.call, name: 'Video call only' }],
    cards: [
      { id: 1, title: 'Anywhere', text: 'x', flavor: '', groups: [] },
      { id: 2, title: 'Kiss', text: 'x', flavor: '', groups: [Deck.PLACE.room] },
      { id: 3, title: 'Fridge Tour', text: 'x', flavor: '', groups: [Deck.PLACE.call] },
      { id: 4, title: 'Snow call', text: 'x', flavor: '', groups: ['snow', Deck.PLACE.call] },
    ],
  };
  const ids = off => deck.cards.filter(c => Deck.isEligible(c, off)).map(c => c.id);
  assert.deepEqual(ids(Deck.playOff(new Set(), false)), [1, 2], 'in one room: no video call cards');
  assert.deepEqual(ids(Deck.playOff(new Set(), true)), [1, 3, 4], 'on a call: no same-room cards');
  assert.deepEqual(ids(Deck.playOff(new Set(['snow']), true)), [1, 3], 'other groups still count');
  assert.deepEqual(ids(Deck.playOff(new Set([Deck.PLACE.call]), true)), [1, 3, 4], "the place groups can't be unchecked by hand");
  assert.equal(Deck.cardsLeft(deck, [1, 2, 3, 4], Deck.playOff(new Set(), true)).playable, 3);
});

test('the original deck has all 153 cards and 3 groups', () => {
  assert.equal(original.cards.length, 153);
  assert.deepEqual(original.groups.map(g => g.name), ['Snow on the ground', 'There are girls present', 'You can find a stranger']);
  const inGroup = id => Deck.cardsInGroup(original, id).map(c => c.title);
  assert.deepEqual(inGroup('girls'), ['Kiss-Kiss', 'New Love']);
  assert.deepEqual(inGroup('stranger'), ['New Best Friend', 'Paparazzi']);
  assert.deepEqual(inGroup('snow'), ['Blizzard Bra or Boxers']);
  assert.equal(new Set(original.cards.map(c => c.id)).size, 153);
  for (const c of original.cards) {
    assert.ok(c.title && c.text, `card ${c.id} has a title and text`);
    assert.ok(!/<|&[a-z]+;/.test(c.title + c.text + c.flavor), `card ${c.id} has no leftover HTML`);
  }
});

// ---------- drawing ----------

test('without replacement, every card comes up once before any repeats', () => {
  const deck = clone();
  const rand = seeded(7);
  let shoe = Deck.freshShoe(deck, rand);
  const seen = new Set();
  let last = null;
  for (let i = 0; i < deck.cards.length; i++) {
    const r = Deck.drawCard({ deck, shoe, rand, lastId: last });
    assert.equal(r.reshuffled, false);
    assert.ok(!seen.has(r.card.id), 'no repeats');
    seen.add(r.card.id);
    shoe = r.shoe;
    last = r.card.id;
  }
  assert.equal(seen.size, deck.cards.length);
  assert.equal(shoe.length, 0);
  const next = Deck.drawCard({ deck, shoe, rand, lastId: last });
  assert.equal(next.reshuffled, true, 'an empty shoe reshuffles');
  assert.notEqual(next.card.id, last, 'the reshuffle does not repeat the card on screen');
  assert.equal(next.shoe.length, deck.cards.length - 1);
});

test('cards in a switched-off group never come up, and stay in the shoe', () => {
  const deck = clone();
  const rand = seeded(3);
  const off = new Set(['girls', 'stranger']);
  let shoe = Deck.freshShoe(deck, rand);
  for (let i = 0; i < 400; i++) {
    const r = Deck.drawCard({ deck, shoe, off, rand });
    assert.ok(!r.card.groups.some(g => off.has(g)), `drew ${r.card.title}`);
    shoe = r.shoe;
    if (!r.reshuffled && i < 148) {
      for (const c of Deck.cardsInGroup(deck, 'girls')) assert.ok(shoe.includes(c.id), 'skipped cards stay in the shoe');
    }
  }
  assert.equal(Deck.cardsLeft(deck, Deck.freshShoe(deck), off).playable, 153 - 4);
});

test('a card in two groups needs both groups switched on', () => {
  const deck = clone();
  const both = deck.cards[0];
  both.groups = ['girls', 'snow'];
  assert.equal(Deck.isEligible(both, new Set()), true);
  assert.equal(Deck.isEligible(both, new Set(['snow'])), false);
  assert.equal(Deck.isEligible(both, new Set(['girls'])), false);
});

test('with replacement, cards can repeat but never twice in a row', () => {
  const deck = clone();
  const rand = seeded(11);
  const shoe = Deck.freshShoe(deck, rand);
  const counts = new Map();
  let last = null;
  for (let i = 0; i < 3000; i++) {
    const r = Deck.drawCard({ deck, shoe, replacement: true, rand, lastId: last });
    assert.notEqual(r.card.id, last);
    assert.equal(r.shoe, shoe, 'the shoe is untouched');
    counts.set(r.card.id, (counts.get(r.card.id) || 0) + 1);
    last = r.card.id;
  }
  assert.ok(counts.size > 140, 'most cards came up');
});

test('when every card is switched off, nothing is drawn', () => {
  const deck = { groups: [{ id: 'a', name: 'A' }], cards: [{ id: 1, title: 'x', text: 'y', flavor: '', groups: ['a'] }] };
  const r = Deck.drawCard({ deck, shoe: [1], off: new Set(['a']) });
  assert.equal(r.card, null);
  const one = Deck.drawCard({ deck, shoe: [1], lastId: 1 });
  assert.equal(one.card.id, 1, 'a one-card deck can repeat');
});

// ---------- editing ----------

test('groups can be added, renamed and deleted', () => {
  const deck = clone();
  const a = Deck.addGroup(deck, '  Outdoors  ');
  assert.equal(a.group.name, 'Outdoors');
  assert.equal(a.group.id, 'outdoors');
  assert.equal(Deck.addGroup(deck, 'outdoors').existed, true, 'names are not case sensitive');
  assert.ok(Deck.addGroup(deck, '   ').error);
  const b = Deck.addGroup(deck, 'Outdoors!!');
  assert.equal(b.group.id, 'outdoors-2', 'ids stay unique');
  assert.ok(Deck.renameGroup(deck, b.group.id, 'OUTDOORS').error, 'cannot rename onto another group');
  assert.equal(Deck.renameGroup(deck, b.group.id, 'Pool party').group.name, 'Pool party');

  const card = deck.cards[5];
  Deck.setCardInGroup(card, 'outdoors', true);
  Deck.setCardInGroup(card, 'girls', true);
  Deck.setCardInGroup(card, 'girls', true);
  assert.deepEqual(card.groups, ['outdoors', 'girls'], 'a card can be in several groups, once each');
  Deck.deleteGroup(deck, 'outdoors');
  assert.deepEqual(card.groups, ['girls'], 'deleting a group takes it off its cards');
  assert.ok(!deck.groups.some(g => g.id === 'outdoors'));
});

test('cards can be added and deleted', () => {
  const deck = clone();
  const card = Deck.addCard(deck);
  assert.equal(card.id, 154);
  assert.equal(deck.cards[0], card, 'new cards go to the top of the list');
  Deck.deleteCard(deck, 3);
  assert.equal(deck.cards.length, 153);
  assert.ok(!deck.cards.some(c => c.id === 3));
  assert.equal(Deck.addCard(deck).id, 155);
});

test('imports are checked and tidied', () => {
  assert.throws(() => Deck.normalizeDeck(null));
  assert.throws(() => Deck.normalizeDeck({ groups: [] }));
  const d = Deck.normalizeDeck({
    groups: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { name: 'a' }, { id: 'BAD ID', name: 'C' }, { id: 'x' }],
    cards: [
      { id: 1, title: 'One', text: 'x', groups: ['a', 'a', 'missing'] },
      { id: 1, title: 'Dupe id', text: 'x' },
      { title: '', text: '' },
      { id: 'seven', text: 'no title', flavor_text: 'old style flavor', extra: 'dropped' },
      'junk',
    ],
  });
  assert.deepEqual(d.groups.map(g => g.name), ['A', 'B', 'C']);
  assert.equal(new Set(d.groups.map(g => g.id)).size, 3);
  assert.deepEqual(d.cards.map(c => c.id), [1, 2, 3]);
  assert.deepEqual(d.cards[0].groups, ['a']);
  assert.equal(d.cards[2].title, 'Untitled card');
  assert.equal(d.cards[2].flavor, 'old style flavor');
  assert.equal('extra' in d.cards[2], false);
  const round = Deck.normalizeDeck(JSON.parse(JSON.stringify(Deck.serializeDeck(original))));
  assert.deepEqual(round, original, 'export then import gives back the same deck');
});

// ---------- formatting ----------

test('formatting renders, and HTML in a card is shown as text', () => {
  assert.equal(inline('It\'s *doctor* Jan'), 'It&#39;s <em>doctor</em> Jan');
  assert.equal(inline('**big** deal'), '<strong>big</strong> deal');
  assert.equal(inline('5 * 3 * 2'), '5 * 3 * 2', 'lone asterisks stay');
  assert.equal(inline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))', 'only web and email links');
  assert.match(inline('[Switcharoo](http://reddit.com/a?b=1&c=2)'), /^<a href="http:\/\/reddit.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Switcharoo<\/a>$/);
  assert.equal(inline('[x](http://a.com/"onmouseover="alert(1))'), '[x](http://a.com/&quot;onmouseover=&quot;alert(1))');
  assert.equal(inline('A♣ A♦'), 'A♣ A<span class="red-suit">♦</span>');
  assert.equal(render('Line one\nLine two\n\nNew para'), '<p>Line one<br>Line two</p><p>New para</p>');
  assert.equal(render('Tests:\n1. One\n2. Two'), '<p>Tests:</p><ol><li>One</li><li>Two</li></ol>');
  assert.equal(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(render(''), '');
  assert.equal(plain('Ah, the old [Reddit Switcharoo](http://x.com). *Wow*'), 'Ah, the old Reddit Switcharoo. Wow');
});

test('every original card renders without leftover markup', () => {
  for (const c of original.cards) {
    for (const html of [inline(c.title), render(c.text), render(c.flavor)]) {
      assert.ok(!/\*\*|\]\(/.test(html), `card ${c.id}: ${html}`);
    }
  }
  const sobriety = original.cards.find(c => c.title === 'Sobriety Checkpoint');
  assert.match(render(sobriety.text), /<ol><li>Stand on one leg/);
});

// ---------- publishing (against a pretend GitHub) ----------

function fakeGitHub({ revision = 3, conflictOnce = false, status = null } = {}) {
  const repo = { sha: 'sha-1', text: Sync.deckFileText(original, revision, '2026-01-01T00:00:00Z') };
  const calls = [];
  let conflicts = conflictOnce ? 1 : 0;
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const reply = (code, body) => ({ ok: code < 300, status: code, json: async () => body });
    if (status) return reply(status, { message: 'nope' });
    if (url.endsWith('/user')) return reply(200, { login: 'someone' });
    if (init.method === 'GET') return reply(200, { sha: repo.sha, content: Sync.toBase64(repo.text).replace(/(.{60})/g, '$1\n') });
    const body = JSON.parse(init.body);
    if (conflicts-- > 0) {
      // Someone else publishes first.
      repo.sha = 'sha-other';
      repo.text = Sync.deckFileText(original, revision + 1);
      return reply(409, { message: 'sha mismatch' });
    }
    if (body.sha !== repo.sha) return reply(409, { message: 'sha mismatch' });
    repo.sha = `sha-${calls.length}`;
    repo.text = Sync.fromBase64(body.content);
    return reply(201, { content: { sha: repo.sha } });
  };
  return { fetch, calls, repo };
}

test('text survives the trip through base64, including symbols', () => {
  const s = 'A♣ A♦ ☞ Pokémon “quotes” …\n';
  assert.equal(Sync.fromBase64(Sync.toBase64(s)), s);
  assert.equal(Sync.fromBase64(Sync.toBase64('x'.repeat(100000))).length, 100000);
});

test('publishing commits the deck as the next revision', async () => {
  const gh = fakeGitHub({ revision: 3 });
  const deck = clone();
  deck.cards[0].title = 'Kiss-Kiss ♥';
  const result = await Sync.publishDeck('tok', deck, { baseRevision: 3, fetch: gh.fetch });
  assert.equal(result.revision, 4);
  const put = gh.calls.find(c => c.method === 'PUT');
  assert.match(put.url, /\/repos\/roamingjackmans-pixel\/thedeck\/contents\/public\/cards\.json$/);
  assert.equal(put.headers.Authorization, 'Bearer tok');
  assert.equal(put.body.sha, 'sha-1');
  assert.equal(put.body.branch, 'main');
  const saved = JSON.parse(gh.repo.text);
  assert.equal(saved.revision, 4);
  assert.equal(saved.cards[0].title, 'Kiss-Kiss ♥');
  assert.deepEqual(Deck.normalizeDeck(saved), deck, 'the committed file is a clean deck');
});

test('publishing notices when another device published first', async () => {
  const gh = fakeGitHub({ revision: 5 });
  const r = await Sync.publishDeck('tok', clone(), { baseRevision: 4, fetch: gh.fetch });
  assert.deepEqual(r, { conflict: true, revision: 5 });
  assert.ok(!gh.calls.some(c => c.method === 'PUT'), 'nothing was written');
  const forced = await Sync.publishDeck('tok', clone(), { baseRevision: 4, force: true, fetch: gh.fetch });
  assert.equal(forced.revision, 6);
});

test('a publish that races another one re-checks instead of overwriting', async () => {
  const gh = fakeGitHub({ revision: 2, conflictOnce: true });
  const r = await Sync.publishDeck('tok', clone(), { baseRevision: 2, fetch: gh.fetch });
  assert.deepEqual(r, { conflict: true, revision: 3 });
});

test('GitHub errors become readable messages', async () => {
  await assert.rejects(Sync.publishDeck('bad', clone(), { fetch: fakeGitHub({ status: 401 }).fetch }), /didn't accept the token/);
  await assert.rejects(Sync.publishDeck('tok', clone(), { fetch: fakeGitHub({ status: 403 }).fetch }), /can't edit the thedeck repo/);
  await assert.rejects(Sync.publishDeck('tok', clone(), { fetch: async () => { throw new TypeError('offline'); } }), /Couldn't reach GitHub/);
  assert.equal(await Sync.checkToken('tok', { fetch: fakeGitHub().fetch }), 'someone');
});

test('the token link fills in the right settings', () => {
  const url = new URL(Sync.TOKEN_PAGE);
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.equal(url.searchParams.get('contents'), 'write');
  assert.equal(url.searchParams.get('target_name'), 'roamingjackmans-pixel');
});

// ---------- multiplayer rules ----------

function table(names = ['Host', 'Sam', 'Alex'], deck = original, seed = 5) {
  const rand = seeded(seed);
  const s = E.newRoom('12345', { pid: 'p0', name: names[0] }, 1000);
  names.slice(1).forEach((name, i) => E.addPlayer(s, { pid: `p${i + 1}`, name }, 1000));
  const act = (pid, a, now = 2000) => E.apply(s, pid, a, now, deck, rand);
  return { s, act, rand };
}
const mustOk = r => { assert.ok(r.ok, r.err); return r; };

test('a game starts with the whole deck shuffled and the host to play', () => {
  const { s, act } = table();
  assert.equal(act('p1', { k: 'start' }).ok, false, 'only the host starts');
  mustOk(act('p0', { k: 'start' }));
  assert.equal(s.phase, 'play');
  assert.equal(s.game.shoe.length, 153);
  assert.equal(s.game.turn, 'p0');
});

test('a drawn card waits privately until you show it, give it or keep it', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  assert.equal(act('p1', { k: 'draw' }).ok, false, "can't draw on someone else's turn");
  mustOk(act('p0', { k: 'draw' }));
  const [card] = E.pendingOf(s, 'p0');
  assert.ok(card && card.uid);
  assert.equal(s.game.shoe.length, 152);
  assert.equal(act('p0', { k: 'draw' }).ok, false, 'one card at a time');
  assert.equal(act('p0', { k: 'endturn' }).ok, false, 'must deal with it before ending the turn');

  // give it to Sam: it moves to Sam's screen
  mustOk(act('p0', { k: 'give', uid: card.uid, to: 'p1' }));
  assert.equal(E.pendingOf(s, 'p0').length, 0);
  assert.equal(E.pendingOf(s, 'p1')[0].from, 'p0');
  // it's stuck with Sam, who keeps it
  assert.match(act('p1', { k: 'give', uid: card.uid, to: 'p2' }).err, /Host gave you this card, so it's stuck with you/);
  mustOk(act('p1', { k: 'keep', uid: card.uid }));
  assert.match(act('p1', { k: 'give', uid: card.uid, to: 'p2' }).err, /stuck with you/, 'even from their hand');
  assert.deepEqual(E.handOf(s, 'p1').map(c => c.uid), [card.uid]);
  // Sam can show it later
  mustOk(act('p1', { k: 'show', uid: card.uid }));
  assert.equal(s.game.table[0].by, 'p1');
  assert.equal(s.showSeq, 1);
  assert.equal(act('p2', { k: 'show', uid: card.uid }).ok, false, "can't play someone else's card");
});

test('a card given away on your turn holds up the turn until it is discarded', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  act('p0', { k: 'draw' });
  const uid = E.pendingOf(s, 'p0')[0].uid;
  assert.equal(act('p0', { k: 'discard', uid }).ok, false, "you can't throw away a card you drew without playing it");
  mustOk(act('p0', { k: 'give', uid, to: 'p2' }));
  assert.equal(E.giftHolder(s), 'p2');
  assert.match(act('p0', { k: 'endturn' }).err, /Wait for Alex/);
  // Alex shows it, takes it back, then discards it: that ends the Host's turn
  mustOk(act('p2', { k: 'show', uid }));
  assert.equal(E.giftHolder(s), 'p2', 'still Alex’s to finish on the table');
  mustOk(act('p2', { k: 'takeback', uid }));
  mustOk(act('p2', { k: 'discard', uid }));
  assert.equal(s.game.turn, 'p1', 'the turn moved on');
  assert.equal(s.game.discard.at(-1).uid, uid);
  assert.equal(E.giftHolder(s), null);

  // straight from the screen works too, and the table is cleared as usual
  act('p1', { k: 'draw' });
  const shown = E.pendingOf(s, 'p1')[0].uid;
  act('p1', { k: 'show', uid: shown });
  assert.equal(act('p1', { k: 'draw' }).ok, false);
  s.game.bonus = 1; // pretend it was a bonus draw card
  act('p1', { k: 'draw' });
  const given = E.pendingOf(s, 'p1')[0].uid;
  mustOk(act('p1', { k: 'give', uid: given, to: 'p0' }));
  mustOk(act('p0', { k: 'discard', uid: given }));
  assert.equal(s.game.turn, 'p2');
  assert.equal(s.game.table.length, 0);
  assert.ok(s.game.discard.some(c => c.uid === shown));

  // kept in a hand, it still holds up the turn until it's discarded from there
  act('p2', { k: 'draw' });
  const kept = E.pendingOf(s, 'p2')[0].uid;
  act('p2', { k: 'give', uid: kept, to: 'p1' });
  mustOk(act('p1', { k: 'keep', uid: kept }));
  assert.match(act('p2', { k: 'endturn' }).err, /Wait for Sam/);
  mustOk(act('p1', { k: 'discard', uid: kept }));
  assert.equal(s.game.turn, 'p0');

  // a card given while it isn't your turn is still stuck, but doesn't end anyone's turn
  act('p0', { k: 'draw' });
  const mine = E.pendingOf(s, 'p0')[0].uid;
  act('p0', { k: 'keep', uid: mine });
  mustOk(act('p0', { k: 'endturn' }));
  assert.equal(s.game.turn, 'p1');
  mustOk(act('p0', { k: 'give', uid: mine, to: 'p2' }), "giving from your hand on someone else's turn");
  assert.equal(E.giftHolder(s), null, "it doesn't hold up Sam's turn");
  assert.match(act('p2', { k: 'give', uid: mine, to: 'p1' }).err, /stuck/);
  mustOk(act('p2', { k: 'discard', uid: mine }));
  assert.equal(s.game.turn, 'p1', "discarding it didn't end Sam's turn");
});

test('ending your turn discards the table and passes the turn on', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  assert.equal(act('p0', { k: 'endturn' }).ok, false, 'draw first');
  act('p0', { k: 'draw' });
  const [card] = E.pendingOf(s, 'p0');
  mustOk(act('p0', { k: 'show', uid: card.uid }));
  const left = s.game.shoe.length;
  assert.match(act('p0', { k: 'draw' }).err, /already drew/, 'one draw per turn, even after dealing with the card');
  assert.equal(s.game.shoe.length, left, 'the refused draw took nothing off the deck');
  mustOk(act('p0', { k: 'endturn' }));
  assert.equal(s.game.table.length, 0);
  assert.deepEqual(s.game.discard.map(c => c.uid), [card.uid]);
  assert.equal(s.game.turn, 'p1');
  mustOk(act('p1', { k: 'draw' }), 'the next player gets their draw');
  mustOk(act('p1', { k: 'keep', uid: E.pendingOf(s, 'p1')[0].uid }));
  assert.equal(act('p1', { k: 'draw' }).ok, false, 'keeping the card does not earn another draw');
  assert.equal(E.handOf(s, 'p1').length, 1, 'kept cards stay in your hand');
  act('p1', { k: 'endturn' });
  act('p2', { k: 'draw' }); act('p2', { k: 'keep', uid: E.pendingOf(s, 'p2')[0].uid }); act('p2', { k: 'endturn' });
  assert.equal(s.game.turn, 'p0', 'back round to the first player');
});

test('shown cards can be taken back or discarded by whoever showed them', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  act('p0', { k: 'draw' });
  const uid = E.pendingOf(s, 'p0')[0].uid;
  act('p0', { k: 'show', uid });
  assert.equal(act('p1', { k: 'takeback', uid }).ok, false);
  assert.equal(act('p1', { k: 'discard', uid }).ok, false);
  mustOk(act('p0', { k: 'takeback', uid }));
  assert.equal(E.handOf(s, 'p0')[0].uid, uid);
  mustOk(act('p0', { k: 'discard', uid }));
  assert.equal(s.game.discard.at(-1).uid, uid);
});

test('switched-off groups never get drawn, and the discard pile is reshuffled when the deck runs out', () => {
  const small = {
    groups: [{ id: 'snow', name: 'Snow' }],
    cards: [1, 2, 3, 4].map(id => ({ id, title: `C${id}`, text: 'x', flavor: '', groups: id === 4 ? ['snow'] : [] })),
  };
  const { s, act } = table(['Host'], small);
  mustOk(act('p0', { k: 'rules', off: ['snow', 'nonsense'] }));
  assert.deepEqual(s.rules.off, ['snow'], 'unknown groups are dropped');
  act('p0', { k: 'start' });
  const drawn = [];
  for (let i = 0; i < 9; i++) {
    mustOk(act('p0', { k: 'draw' }));
    const c = E.pendingOf(s, 'p0')[0];
    drawn.push(c.id);
    act('p0', { k: 'show', uid: c.uid });
    act('p0', { k: 'endturn' });
  }
  assert.ok(!drawn.includes(4), 'the snow card stayed out');
  assert.ok(s.game.shuffles >= 2, 'the discard pile went back in');
  assert.deepEqual(new Set(drawn.slice(0, 3)), new Set([1, 2, 3]), 'no repeats before a reshuffle');
  // with everything held in hands, there's nothing to draw
  const t = table(['Host'], small);
  t.act('p0', { k: 'rules', off: ['snow'] });
  t.act('p0', { k: 'start' });
  for (let i = 0; i < 3; i++) {
    t.act('p0', { k: 'draw' }); t.act('p0', { k: 'keep', uid: E.pendingOf(t.s, 'p0')[0].uid }); t.act('p0', { k: 'endturn' });
  }
  assert.match(t.act('p0', { k: 'draw' }).err, /nothing left to draw/);
});

test('with replacement, discarded cards go straight back into the deck', () => {
  const { s, act } = table(['Host']);
  act('p0', { k: 'rules', replacement: true });
  act('p0', { k: 'start' });
  act('p0', { k: 'draw' });
  act('p0', { k: 'show', uid: E.pendingOf(s, 'p0')[0].uid });
  act('p0', { k: 'endturn' });
  assert.equal(s.game.discard.length, 0);
  assert.equal(s.game.shoe.length, 153);
});

test('a player who drops out on their turn is skipped, and the host can skip or remove players', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  act('p0', { k: 'draw' }); act('p0', { k: 'keep', uid: E.pendingOf(s, 'p0')[0].uid }); act('p0', { k: 'endturn' });
  assert.equal(s.game.turn, 'p1');
  E.setOnline(s, 'p1', false, 10000);
  assert.equal(E.tick(s, 10000 + E.AUTO_SKIP_MS - 1), false, 'gets a moment to come back');
  assert.equal(E.tick(s, 10000 + E.AUTO_SKIP_MS + 1), true);
  assert.equal(s.game.turn, 'p2');
  assert.equal(act('p1', { k: 'skip' }).ok, false, 'only the host skips');
  mustOk(act('p0', { k: 'skip' }));
  assert.equal(s.game.turn, 'p0', 'offline players are passed over');
  // Sam has a card in hand when removed: it goes to the discard pile
  s.game.hands.p1 = [{ uid: 99, id: 7 }];
  assert.equal(act('p0', { k: 'remove', pid: 'p2' }).ok, false, "can't remove someone who's here");
  mustOk(act('p0', { k: 'remove', pid: 'p1' }));
  assert.ok(!s.players.p1 && !s.order.includes('p1'));
  assert.equal(s.game.discard.at(-1).id, 7);
});

test('a returning player gets their seat and hand back, and a new host can take over', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  act('p0', { k: 'draw' });
  act('p0', { k: 'give', uid: E.pendingOf(s, 'p0')[0].uid, to: 'p2' });
  E.setOnline(s, 'p2', false, 3000);
  E.addPlayer(s, { pid: 'p2', name: 'Alex' }, 4000);
  assert.equal(s.players.p2.on, true);
  assert.equal(E.pendingOf(s, 'p2').length, 1, 'the card is still waiting for them');
  E.takeOver(s, 'p1', 0, 5000);
  assert.equal(s.hostPid, 'p1');
  assert.equal(s.players.p0.on, false);
  mustOk(act('p1', { k: 'skip' }), 'the new host has host powers');
});

test('one draw per turn holds through a reconnect and a new host, and a skipped turn passes it on', () => {
  const { s, act } = table();
  act('p0', { k: 'start' });
  mustOk(act('p0', { k: 'draw' }));
  act('p0', { k: 'show', uid: E.pendingOf(s, 'p0')[0].uid });
  E.setOnline(s, 'p0', false, 3000);
  E.addPlayer(s, { pid: 'p0', name: 'Host' }, 4000);
  assert.equal(act('p0', { k: 'draw' }).ok, false, 'coming back does not earn another draw');
  E.takeOver(s, 'p1', 0, 5000);
  E.addPlayer(s, { pid: 'p0', name: 'Host' }, 6000);
  assert.equal(act('p0', { k: 'draw' }).ok, false, 'nor does a new host taking over');
  mustOk(act('p1', { k: 'skip' }));
  assert.equal(s.game.turn, 'p1');
  mustOk(act('p1', { k: 'draw' }), 'the next player gets their draw');
});

test('a bonus draw card gives whoever draws it one more draw that turn', () => {
  const deck = { groups: [], cards: [1, 2, 3, 4, 5].map(id => ({ id, title: `C${id}`, text: 'x', flavor: '', groups: [], ...(id === 1 ? { bonus: true } : {}) })) };
  const { s, act } = table(['Host', 'Sam'], deck);
  act('p0', { k: 'start' });
  s.game.shoe = [5, 4, 3, 2, 1]; // the bonus card is on top
  mustOk(act('p0', { k: 'draw' }));
  assert.equal(E.drawsLeft(s), 1);
  assert.match(act('p0', { k: 'draw' }).err, /Deal with/, 'deal with the bonus card first');
  act('p0', { k: 'show', uid: E.pendingOf(s, 'p0')[0].uid });
  mustOk(act('p0', { k: 'draw' }), 'the bonus draw');
  assert.equal(s.log.at(-1).text, 'Host took a bonus draw');
  act('p0', { k: 'show', uid: E.pendingOf(s, 'p0')[0].uid });
  assert.equal(E.drawsLeft(s), 0);
  assert.match(act('p0', { k: 'draw' }).err, /used your bonus draw/, 'only one more');
  mustOk(act('p0', { k: 'endturn' }));
  mustOk(act('p1', { k: 'draw' }));
  act('p1', { k: 'show', uid: E.pendingOf(s, 'p1')[0].uid });
  assert.match(act('p1', { k: 'draw' }).err, /already drew/, 'the bonus went with the turn');
  // an unused bonus doesn't carry over either
  s.game.shoe.push(1);
  mustOk(act('p1', { k: 'endturn' }));
  mustOk(act('p0', { k: 'draw' }));
  act('p0', { k: 'keep', uid: E.pendingOf(s, 'p0')[0].uid });
  mustOk(act('p0', { k: 'endturn' }), 'the bonus draw is optional');
  mustOk(act('p1', { k: 'draw' }));
  act('p1', { k: 'keep', uid: E.pendingOf(s, 'p1')[0].uid });
  assert.equal(act('p1', { k: 'draw' }).ok, false);
});

test('cards added to or deleted from the host deck mid-game join or leave the draw pile', () => {
  const { s, act } = table(['Host']);
  act('p0', { k: 'start' });
  const deck = clone();
  Deck.deleteCard(deck, s.game.shoe[0]);
  const added = Deck.addCard(deck);
  assert.equal(E.syncDeck(s, deck, seeded(2)), true);
  assert.ok(s.game.shoe.includes(added.id));
  assert.equal(s.game.shoe.length, 153);
  assert.equal(new Set(s.game.shoe).size, 153);
});

test('a sealed card stays sealed until it is given, then stays open wherever it goes', () => {
  const deck = { groups: [], cards: [{ id: 1, title: 'Worst Kisser', text: 'Give this to the worst kisser.', flavor: '', groups: [], secret: 'Drink 3.' }] };
  const { s, act } = table(['Host', 'Sam', 'Alex'], deck);
  act('p0', { k: 'start' });
  mustOk(act('p0', { k: 'draw' }));
  const [drawn] = E.pendingOf(s, 'p0');
  assert.ok(!drawn.open, 'sealed for whoever drew it');
  mustOk(act('p0', { k: 'keep', uid: drawn.uid }));
  assert.ok(!E.handOf(s, 'p0')[0].open, 'still sealed in their hand');
  mustOk(act('p0', { k: 'give', uid: drawn.uid, to: 'p1' }));
  assert.match(s.log.at(-1).text, /Host gave Sam a sealed card/);
  const got = E.pendingOf(s, 'p1')[0];
  assert.deepEqual([got.open, got.from], [true, 'p0'], 'open for Sam, who knows who picked them');
  mustOk(act('p1', { k: 'show', uid: got.uid }));
  assert.deepEqual([s.game.table[0].open, s.game.table[0].from, s.game.table[0].by], [true, 'p0', 'p1'], 'the table says who picked who');
  mustOk(act('p1', { k: 'takeback', uid: got.uid }));
  assert.ok(E.handOf(s, 'p1')[0].open);
  mustOk(act('p1', { k: 'discard', uid: got.uid }));
  assert.ok(s.game.discard.at(-1).open);
});

test('the host decides whether everyone is in one room or on a video call', () => {
  const deck = {
    groups: [{ id: Deck.PLACE.room, name: 'Same room only' }, { id: Deck.PLACE.call, name: 'Video call only' }],
    cards: [
      { id: 1, title: 'Kiss', text: 'x', flavor: '', groups: [Deck.PLACE.room] },
      { id: 2, title: 'Fridge Tour', text: 'x', flavor: '', groups: [Deck.PLACE.call] },
    ],
  };
  const drawOne = remote => {
    const { s, act } = table(['Host', 'Sam'], deck);
    mustOk(act('p0', { k: 'rules', remote }));
    assert.equal(s.rules.remote, remote);
    act('p0', { k: 'start' });
    assert.equal(E.drawable(s, deck), 1);
    mustOk(act('p0', { k: 'draw' }));
    return E.pendingOf(s, 'p0')[0].id;
  };
  assert.equal(drawOne(false), 1, 'in one room');
  assert.equal(drawOne(true), 2, 'on a call');
  assert.equal(E.newRoom('1', { pid: 'a', name: 'A' }).rules.remote, false, 'rooms start in one room');
  assert.equal(table().act('p1', { k: 'rules', remote: true }).ok, false, 'only the host');
});

// ---------- table colors ----------

test('there are several table colors, and any picked color becomes a readable mat', () => {
  assert.ok(T.TABLES.length >= 8);
  assert.equal(new Set(T.TABLES.map(t => t.id)).size, T.TABLES.length);
  const lightness = hex => {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => v / 255);
    return (Math.max(...c) + Math.min(...c)) / 2;
  };
  for (const pick of ['#ffffff', '#ffff00', '#000000', '#1b6440', '#ff69b4', 'nonsense']) {
    const t = T.customTable(pick);
    assert.equal(t.colors.length, 3);
    for (const c of t.colors) assert.match(c, /^#[0-9a-f]{6}$/);
    assert.ok(lightness(t.colors[1]) <= 0.43, `${pick} is dark enough for white writing`);
    assert.ok(lightness(t.colors[0]) >= lightness(t.colors[1]) && lightness(t.colors[1]) >= lightness(t.colors[2]), 'light to dark');
  }
  assert.equal(T.customTable('#1b6440').colors[1], '#1b6440', 'a dark color is kept as it is');
});

await Promise.all(pending);
console.log(process.exitCode ? 'Some tests failed.' : `All ${passed} tests passed.`);

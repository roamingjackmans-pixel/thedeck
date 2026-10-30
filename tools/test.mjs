// Checks the deck rules, the card formatting, and the card data.   node tools/test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as Deck from '../public/js/deck.js';
import { render, inline, plain } from '../public/js/markup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n`, err); process.exitCode = 1; }
};

// A seeded random number generator so failures can be reproduced.
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const original = Deck.normalizeDeck(JSON.parse(fs.readFileSync(path.join(root, 'public', 'cards.json'), 'utf8')));
const clone = () => structuredClone(original);

// ---------- the card data ----------

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

console.log(process.exitCode ? 'Some tests failed.' : `All ${passed} tests passed.`);

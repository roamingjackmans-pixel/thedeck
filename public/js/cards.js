// Drawing cards that look like real playing cards: faces, backs, piles, and the flip when a card turns over.
import { inline, render, escapeHtml as esc } from './markup.js';

// Instead of suits, every card has a drink in its corners: beers, shots, wine bottles and martinis.
// The pictures are an SVG sprite in index.html (#d-beer, #d-shot, #d-wine, #d-martini).
const DRINKS = ['beer', 'shot', 'wine', 'martini'];
export const drinkOf = card => DRINKS[((card?.id ?? 0) % 4 + 4) % 4];
const corner = (drink, where) => `<svg class="pc-corner ${where}" aria-hidden="true"><use href="#d-${drink}"/></svg>`;

const SEAL_NOTE = 'Sealed. Only the player you give it to gets to open it.';

/**
 * A card face. size: 'big' (full text) or 'mini' (title only, for hands and piles).
 * extra: more classes. A missing card (deleted from the deck) shows a placeholder.
 * Sealed cards (with a secret) show it unless sealed is true. sealed: true shows a wax seal instead, with
 * sealNote under it; sealButton makes the seal a button (one phone: tap it to open). opening: the inside
 * appears with a little animation, for the moment it's opened.
 */
export function faceHtml(card, { size = 'big', extra = '', permalink = false, sealed = false, sealNote = SEAL_NOTE, sealButton = false, opening = false } = {}) {
  if (!card) {
    return `<div class="pc pc-face pc-${size} pc-missing ${extra}"><div class="pc-body"><p class="pc-text">This card was deleted from the deck.</p></div></div>`;
  }
  const drink = drinkOf(card);
  const secret = card.secret ? (sealed ? 'closed' : 'open') : '';
  const link = permalink ? `<a class="permalink" href="#card-${card.id}" title="Link to this card" aria-label="Link to this card">¶</a>` : '';
  let inside = '';
  if (secret === 'closed') {
    const tag = sealButton ? 'button type="button" data-open-seal' : 'div';
    inside = `<${tag} class="pc-seal"><span class="wax" aria-hidden="true">TD</span><span class="seal-note">${esc(sealNote)}</span></${sealButton ? 'button' : 'div'}>`;
  } else if (secret === 'open') {
    inside = `<div class="pc-inside${opening ? ' opening' : ''}"><span class="pc-inside-label">Inside</span>${render(card.secret)}</div>`;
  }
  const body = size === 'mini'
    ? `<h3 class="pc-title">${inline(card.title)}</h3>`
    : `<h3 class="pc-title">${inline(card.title)}</h3>
       <div class="pc-text">${render(card.text)}</div>
       ${inside}
       ${card.flavor ? `<div class="pc-flavor">${render(card.flavor)}</div>` : ''}`;
  const badge = size === 'mini' && secret === 'closed' ? '<span class="mini-seal" aria-hidden="true"></span>' : '';
  return `<div class="pc pc-face pc-${size}${secret ? ` pc-secret-${secret}` : ''} ${extra}" data-card="${card.id}">
    ${corner(drink, 'tl')}${corner(drink, 'br')}
    <div class="pc-body">${body}</div>${badge}${link}
  </div>`;
}

export const backHtml = (extra = '') => `<div class="pc pc-back ${extra}" aria-hidden="true"><span class="pc-emblem">THE<br>DECK</span></div>`;

/** A card that starts face down and turns over (call flipUp on the element once it's on the page). */
export function flipHtml(card, opts = {}) {
  return `<div class="flip fresh"><div class="flip-inner">${faceHtml(card, opts)}${backHtml('flip-back')}</div></div>`;
}

export function flipUp(root) {
  const el = root.querySelector('.flip');
  if (!el) return;
  void el.offsetWidth; // let the browser see it face down first, so turning it over animates
  el.classList.add('up');
}

/** The draw pile: a stack of backs that gets thicker the more cards are left. */
export function pileHtml(count, { label = '', active = false } = {}) {
  if (!count) return `<div class="pile-empty" aria-hidden="true"></div>`;
  const depth = Math.min(8, Math.ceil(count / 15));
  const edges = [];
  for (let i = 1; i <= depth; i++) edges.push(`${i}px ${i * 1.4}px 0 ${i % 2 ? '#e9e3d6' : '#c9c0b0'}`);
  edges.push(`${depth + 2}px ${depth * 1.4 + 6}px 14px rgba(0, 0, 0, 0.45)`);
  return `<div class="pile-stack${active ? ' active' : ''}" style="box-shadow:${edges.join(',')}">${backHtml()}</div>
    ${label ? `<span class="pile-label">${esc(label)}</span>` : ''}`;
}

/** Shrinks a big card's text until it fits on the card. */
export function fitCard(root) {
  for (const body of root.querySelectorAll('.pc-big .pc-body')) {
    body.style.fontSize = '';
    let size = 100;
    while (body.scrollHeight > body.clientHeight + 1 && size > 50) {
      size -= 6;
      body.style.fontSize = `${size}%`;
    }
  }
}

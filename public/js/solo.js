// One phone: the original game. Tap the deck (or Draw a Card), do what it says, pass the phone.
import * as Deck from './deck.js';
import * as Store from './store.js';
import { faceHtml, flipHtml, flipUp, pileHtml, fitCard } from './cards.js';

export function initSolo(app) {
  const $ = id => document.getElementById(id);
  const ui = {
    screen: $('solo'),
    stage: $('card'),
    deck: $('solo-deck'),
    discard: $('solo-discard'),
    draw: $('draw-button'),
    notice: $('notice'),
  };
  const state = app.state;
  const cardById = id => state.deck?.cards.find(c => c.id === id) || null;

  function showNotice(text) {
    ui.notice.textContent = text;
    ui.notice.hidden = !text;
  }

  function renderPiles() {
    if (!state.deck) return;
    const { left } = app.cardsLeft();
    ui.deck.innerHTML = pileHtml(left, { label: `${left} left`, active: true });
    const prev = cardById(state.prevId);
    ui.discard.innerHTML = prev
      ? `<div class="discard-top">${faceHtml(prev, { size: 'mini' })}</div><span class="pile-label">Last card</span>`
      : '<div class="pile-empty"></div><span class="pile-label">Last card</span>';
  }

  function renderEmpty() {
    ui.stage.innerHTML = '<div class="card-slot"><p>Tap the deck to draw a card</p></div>';
  }

  /** Puts a card on screen. drawn: it was just drawn (the old one goes on the discard pile). */
  function showCard(card, { animate = true, keepHash = false, drawn = false } = {}) {
    if (drawn && state.currentId != null && state.currentId !== card.id) state.prevId = state.currentId;
    state.currentId = card.id;
    Store.save('current', { id: card.id, prev: state.prevId, date: Date.now() });
    ui.stage.innerHTML = animate
      ? flipHtml(card, { permalink: true })
      : `<div class="flip up"><div class="flip-inner">${faceHtml(card, { permalink: true })}</div></div>`;
    fitCard(ui.stage);
    if (animate) flipUp(ui.stage);
    renderPiles();
    if (!keepHash && location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  function clear() {
    state.currentId = null;
    Store.remove('current');
    renderEmpty();
    renderPiles();
  }

  /** Re-shows the card on screen, in case it was edited or deleted. */
  function refresh() {
    const card = cardById(state.currentId);
    if (card) showCard(card, { animate: false, keepHash: true });
    else if (state.currentId != null) clear();
    else { renderEmpty(); renderPiles(); }
  }

  function draw() {
    if (!state.deck) return;
    const result = Deck.drawCard({
      deck: state.deck, shoe: state.shoe, off: state.off,
      replacement: state.replacement, lastId: state.currentId,
    });
    if (!result.card) {
      clear();
      showNotice(state.deck.cards.length
        ? 'No cards can come up. Every card is in a group that is unchecked in the options.'
        : 'The deck is empty. Add some cards first.');
      return;
    }
    state.shoe = result.shoe;
    app.saveShoe();
    showNotice(result.reshuffled ? "That's the whole deck. Every card has been shuffled back in." : '');
    showCard(result.card, { drawn: true });
  }

  ui.draw.addEventListener('click', draw);
  ui.deck.addEventListener('click', draw);

  ui.stage.addEventListener('click', async e => {
    const link = e.target.closest('.permalink');
    if (!link || state.currentId == null) return;
    e.preventDefault();
    history.replaceState(null, '', `#card-${state.currentId}`);
    try {
      await navigator.clipboard.writeText(location.href);
      app.toast('Link to this card copied');
    } catch {
      app.toast('The link to this card is in the address bar');
    }
  });

  // Space or Enter draws a card when nothing else has the keyboard.
  document.addEventListener('keydown', e => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    if (ui.screen.hidden || e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('input, textarea, select, button, a, [contenteditable]')) return;
    e.preventDefault();
    draw();
  });

  window.addEventListener('resize', () => { if (!ui.screen.hidden) fitCard(ui.stage); });

  return {
    draw,
    showCard,
    showCardById(id, opts) { const card = cardById(id); if (card) { showNotice(''); showCard(card, opts); return true; } return false; },
    refresh,
    clear,
    showNotice,
    enable() { ui.draw.disabled = false; },
  };
}

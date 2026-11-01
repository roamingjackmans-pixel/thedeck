// The secret menu: the original's options (draw style, card groups, reset shoe), plus
// a card editor where any card can be changed and put into any number of groups,
// tools to add, rename and delete groups, add and delete cards, export or import the deck,
// and publishing those changes for everyone.
import { inline, render, plain, escapeHtml as esc } from './markup.js';
import * as Deck from './deck.js';
import { TOKEN_PAGE } from './sync.js';

const PREVIEW_COUNT = 6; // card titles listed under each group before "+ N more"

export function initMenu(app) {
  const dlg = document.getElementById('menu');
  const $ = id => document.getElementById(id);
  const ui = {
    body: dlg.querySelector('.menu-body'),
    tabs: [$('tab-options'), $('tab-cards')],
    panels: { options: $('panel-options'), cards: $('panel-cards') },
    radios: [...dlg.querySelectorAll('input[name="draw-style"]')],
    placeGroup: $('place-group'),
    placeRadios: [...dlg.querySelectorAll('input[name="play-place"]')],
    groupList: $('group-list'),
    addGroupForm: $('add-group-form'),
    addGroupName: $('add-group-name'),
    addGroupMsg: $('add-group-msg'),
    shoeStatus: $('shoe-status'),
    resetShoe: $('reset-shoe'),
    deckStatus: $('deck-status'),
    exportDeck: $('export-deck'),
    importDeck: $('import-deck'),
    importFile: $('import-file'),
    resetDeck: $('reset-deck'),
    publishNow: $('publish-now'),
    discardEdits: $('discard-edits'),
    syncStatus: $('sync-status'),
    connectGithub: $('connect-github'),
    disconnectGithub: $('disconnect-github'),
    connectForm: $('connect-form'),
    connectCancel: $('connect-cancel'),
    connectMsg: $('connect-msg'),
    tokenInput: $('token-input'),
    tokenLink: $('token-link'),
    search: $('card-search'),
    filter: $('card-filter'),
    addCard: $('add-card'),
    cardCount: $('card-count'),
    cardList: $('card-list'),
    saveStatus: $('save-status'),
  };
  const deck = () => app.state.deck;
  const cardById = id => deck().cards.find(c => c.id === id);
  const groupName = id => deck().groups.find(g => g.id === id)?.name ?? '';
  let tab = 'options';
  let renamingGroup = null; // id of the group being renamed
  let openCardId = null;    // the card whose editor is open

  // ---------- saving status ----------

  let statusTimer = null;
  function changed() {
    app.deckChanged();
    noteSaving();
  }
  // The deck has changed (app.* already scheduled the save): show it, and update the "Your Deck" note.
  function noteSaving() {
    ui.saveStatus.textContent = 'Saving…';
    renderDeckStatus();
  }
  app.onSaved = ok => {
    ui.saveStatus.textContent = ok ? 'Saved on this device' : "Couldn't save: this browser is blocking storage";
    clearTimeout(statusTimer);
    if (ok) statusTimer = setTimeout(() => { ui.saveStatus.textContent = ''; }, 2500);
  };

  // ---------- open, close, tabs ----------

  let isOpen = false;
  function open(which = 'options') {
    syncDrawStyle();
    selectTab(which);
    if (!dlg.open) dlg.showModal();
    isOpen = true;
  }
  function close() {
    dlg.close();
    afterClose();
  }
  // Runs once per close however the menu was closed (Done, ×, backdrop, Escape). Called directly
  // as well as from the events, because some browsers are slow or unreliable at firing "close".
  function afterClose() {
    if (!isOpen || dlg.open) return;
    isOpen = false;
    app.menuClosed();
  }
  dlg.addEventListener('close', afterClose);
  dlg.addEventListener('cancel', () => setTimeout(afterClose, 0)); // Escape
  dlg.addEventListener('click', e => {
    if (e.target === dlg) return close(); // the dimmed backdrop
    if (e.target.closest('[data-close]')) return close();
    const go = e.target.closest('[data-goto]');
    if (go) { e.preventDefault(); selectTab(go.dataset.goto); }
  });

  function selectTab(name) {
    tab = name;
    for (const t of ui.tabs) {
      const on = t.id === `tab-${name}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    ui.panels.options.hidden = name !== 'options';
    ui.panels.cards.hidden = name !== 'cards';
    if (name === 'options') renderOptions(); else renderCards();
    ui.body.scrollTop = 0;
  }
  ui.tabs.forEach(t => {
    t.addEventListener('click', () => selectTab(t.id.replace('tab-', '')));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = ui.tabs[(ui.tabs.indexOf(t) + 1) % ui.tabs.length];
      next.focus();
      selectTab(next.id.replace('tab-', ''));
    });
  });

  // ---------- Options tab ----------

  function renderOptions() {
    syncDrawStyle();
    syncPlace();
    renderGroups();
    renderShoeStatus();
    renderDeckStatus();
  }

  function syncDrawStyle() {
    for (const r of ui.radios) r.checked = (r.value === 'replacement') === app.state.replacement;
  }
  ui.radios.forEach(r => r.addEventListener('change', () => {
    if (r.checked) app.setReplacement(r.value === 'replacement');
    renderShoeStatus();
  }));

  // "Where are you playing?" switches the two place groups, so it only shows when the deck has one.
  function syncPlace() {
    ui.placeGroup.hidden = !deck().groups.some(g => Deck.isPlaceGroup(g.id));
    for (const r of ui.placeRadios) r.checked = (r.value === 'call') === app.state.remote;
  }
  ui.placeRadios.forEach(r => r.addEventListener('change', () => {
    if (r.checked) app.setRemote(r.value === 'call');
    renderShoeStatus();
  }));
  const PLACE_NOTE = { [Deck.PLACE.room]: 'Left out on a video call', [Deck.PLACE.call]: 'Only comes up on a video call' };

  function renderGroups() {
    const d = deck();
    if (!d.groups.length) {
      ui.groupList.innerHTML = '<p class="empty">No groups yet. Add one below.</p>';
      return;
    }
    ui.groupList.innerHTML = d.groups.map(g => {
      const cards = Deck.cardsInGroup(d, g.id);
      const place = PLACE_NOTE[g.id];
      const on = place ? true : !app.state.off.has(g.id);
      const toggle = place
        ? `<span class="group-place"><span class="group-name">${esc(g.name)}</span><small>${place}</small></span>`
        : `<label class="checkbox">
             <input type="checkbox" data-act="toggle-group" data-group="${g.id}"${on ? ' checked' : ''}>
             <span class="group-name">${esc(g.name)}</span>
           </label>`;
      const head = renamingGroup === g.id
        ? `<form class="inline-form rename-form" data-group="${g.id}" autocomplete="off">
             <input type="text" maxlength="80" value="${esc(g.name)}" aria-label="Group name" enterkeyhint="done">
             <button type="submit" class="btn btn-default btn-sm">Save</button>
             <button type="button" class="btn btn-link btn-sm" data-act="cancel-rename">Cancel</button>
           </form>`
        : `${toggle}
           <span class="group-actions">
             <button type="button" class="btn-link" data-act="rename-group" data-group="${g.id}">Rename</button>
             <button type="button" class="btn-link danger" data-act="delete-group" data-group="${g.id}">Delete</button>
           </span>`;
      const shown = cards.slice(0, PREVIEW_COUNT);
      const more = cards.length - shown.length;
      const list = cards.length
        ? `<ul class="cards-affected">${shown.map(c =>
            `<li><a href="#" data-act="edit-card" data-card="${c.id}">${esc(plain(c.title))}</a></li>`).join('')}${
            more > 0 ? `<li><a href="#" data-act="show-group" data-group="${g.id}">+ ${more} more</a></li>` : ''}</ul>`
        : '<p class="empty">No cards in this group yet.</p>';
      return `<div class="group-row${on ? '' : ' is-off'}" data-group="${g.id}">
        <div class="group-line">${head}</div>${list}</div>`;
    }).join('');
    if (renamingGroup) {
      const input = ui.groupList.querySelector('.rename-form input');
      input?.focus();
      input?.select();
    }
  }

  ui.groupList.addEventListener('change', e => {
    const box = e.target.closest('[data-act="toggle-group"]');
    if (!box) return;
    app.setGroupOn(box.dataset.group, box.checked);
    box.closest('.group-row').classList.toggle('is-off', !box.checked);
    renderShoeStatus();
  });

  ui.groupList.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'rename-group') {
      renamingGroup = el.dataset.group;
      renderGroups();
    } else if (act === 'cancel-rename') {
      renamingGroup = null;
      renderGroups();
    } else if (act === 'delete-group') {
      const id = el.dataset.group;
      const count = Deck.cardsInGroup(deck(), id).length;
      const note = count ? ` Its ${count} card${count === 1 ? '' : 's'} will stay in the deck, just not in this group.` : '';
      if (!confirm(`Delete the group "${groupName(id)}"?${note}`)) return;
      Deck.deleteGroup(deck(), id);
      app.groupDeleted(id);
      noteSaving();
      renderOptions();
    } else if (act === 'edit-card') {
      e.preventDefault();
      openEditor(Number(el.dataset.card));
    } else if (act === 'show-group') {
      e.preventDefault();
      ui.search.value = '';
      ui.filter.value = `g:${el.dataset.group}`;
      openCardId = null;
      selectTab('cards');
    }
  });

  ui.groupList.addEventListener('submit', e => {
    const form = e.target.closest('.rename-form');
    if (!form) return;
    e.preventDefault();
    const result = Deck.renameGroup(deck(), form.dataset.group, form.querySelector('input').value);
    if (result.error) { ui.addGroupMsg.textContent = result.error; return; }
    ui.addGroupMsg.textContent = '';
    renamingGroup = null;
    changed();
    renderGroups();
  });

  ui.addGroupForm.addEventListener('submit', e => {
    e.preventDefault();
    const result = Deck.addGroup(deck(), ui.addGroupName.value);
    if (result.error) { ui.addGroupMsg.textContent = result.error; return; }
    if (result.existed) { ui.addGroupMsg.textContent = `There's already a group called "${result.group.name}".`; return; }
    ui.addGroupName.value = '';
    ui.addGroupMsg.innerHTML = `Added "${esc(result.group.name)}". Put cards in it from <a href="#" data-goto="cards">Edit Cards</a>.`;
    changed();
    renderGroups();
  });

  function renderShoeStatus() {
    const { left, playable, total } = app.cardsLeft();
    const kept = total - playable;
    const keptNote = kept ? ` ${kept} card${kept === 1 ? ' is' : 's are'} kept out by unchecked groups.` : '';
    ui.shoeStatus.textContent = app.state.replacement
      ? `Cards go back in after they're drawn, so all ${playable} can come up every time.${keptNote}`
      : `${left} of ${playable} cards left before the deck is shuffled again.${keptNote}`;
  }

  ui.resetShoe.addEventListener('click', () => {
    app.resetShoe();
    renderShoeStatus();
    app.toast('Deck state cleared. Every card is back in.');
  });

  // ---------- Your Deck: publishing for everyone ----------

  const when = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function renderDeckStatus() {
    const s = app.state;
    const n = deck().cards.length;
    const cards = `${n} card${n === 1 ? '' : 's'}`;
    let text;
    if (s.publishing) text = 'Publishing your changes for everyone…';
    else if (!s.custom) text = `Everyone is playing the same deck: ${cards}${s.shared?.updated ? `, last changed ${when(s.shared.updated)}` : ''}. Edits you make here are shared with everyone once you publish them.`;
    else if (s.github) text = `You have changes that aren't published yet (${cards}). They publish for everyone when you close this menu.`;
    else text = `Your changes (${cards}) are saved on this device only. Connect this device below to publish them for everyone, or discard them to go back to the shared deck.`;
    if (s.custom && !s.publishing && s.shared && s.shared.revision > s.baseRevision) {
      text += ' Heads up: the shared deck was changed from another device after you started editing here, and publishing will replace those changes.';
    }
    ui.deckStatus.textContent = text;
    ui.publishNow.hidden = !(s.custom && s.github);
    ui.publishNow.disabled = s.publishing;
    ui.discardEdits.hidden = !s.custom;
    ui.discardEdits.disabled = s.publishing;
    ui.syncStatus.textContent = s.github
      ? `This device publishes changes for everyone${s.github.login ? ` (connected to GitHub as ${s.github.login})` : ''}.`
      : 'Only a device connected to GitHub can publish changes for everyone. Everyone else gets them automatically.';
    ui.connectGithub.hidden = !!s.github || !ui.connectForm.hidden;
    ui.disconnectGithub.hidden = !s.github;
  }
  app.onSyncChange = () => { if (dlg.open) renderDeckStatus(); };

  ui.publishNow.addEventListener('click', () => app.publish());

  ui.discardEdits.addEventListener('click', () => {
    if (!confirm("Discard this device's changes and go back to the deck everyone is playing?")) return;
    app.discardEdits();
    openCardId = null;
    renderOptions();
    app.toast('Changes discarded');
  });

  ui.tokenLink.href = TOKEN_PAGE;
  ui.connectGithub.addEventListener('click', () => {
    ui.connectForm.hidden = false;
    ui.connectGithub.hidden = true;
    ui.connectMsg.textContent = '';
    ui.tokenInput.focus();
  });
  ui.connectCancel.addEventListener('click', () => {
    ui.connectForm.hidden = true;
    ui.tokenInput.value = '';
    renderDeckStatus();
  });
  ui.connectForm.addEventListener('submit', async e => {
    e.preventDefault();
    const button = ui.connectForm.querySelector('[type="submit"]');
    button.disabled = true;
    ui.connectMsg.textContent = 'Checking the token with GitHub…';
    try {
      const login = await app.connect(ui.tokenInput.value);
      ui.tokenInput.value = '';
      ui.connectForm.hidden = true;
      ui.connectMsg.textContent = '';
      renderDeckStatus();
      app.toast(`Connected as ${login}`);
    } catch (err) {
      ui.connectMsg.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  ui.disconnectGithub.addEventListener('click', () => {
    if (!confirm('Disconnect this device? It will stop publishing changes for everyone.')) return;
    app.disconnect();
    renderDeckStatus();
  });

  ui.exportDeck.addEventListener('click', () => {
    app.flushDeck();
    const data = { ...Deck.serializeDeck(deck()), exported: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `the-deck-${new Date().toISOString().slice(0, 10)}.json`;
    dlg.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  ui.importDeck.addEventListener('click', () => ui.importFile.click());
  ui.importFile.addEventListener('change', async () => {
    const file = ui.importFile.files[0];
    ui.importFile.value = '';
    if (!file) return;
    let imported;
    try {
      imported = Deck.normalizeDeck(JSON.parse(await file.text()));
    } catch (err) {
      alert(err instanceof SyntaxError ? "That file isn't a deck export (it isn't valid JSON)." : err.message);
      return;
    }
    if (!imported.cards.length) { alert('That deck has no cards in it.'); return; }
    const g = imported.groups.length;
    const shareNote = app.state.github ? ' It will be published for everyone when you close this menu.' : '';
    if (!confirm(`Replace your deck with the ${imported.cards.length} cards and ${g} group${g === 1 ? '' : 's'} in "${file.name}"?${shareNote}`)) return;
    app.replaceDeck(imported);
    openCardId = null;
    renderOptions();
    app.toast('Deck imported');
  });

  ui.resetDeck.addEventListener('click', async () => {
    const shareNote = app.state.github ? ' This will be published for everyone when you close this menu.' : '';
    if (!confirm(`Go back to the original 153 cards and 3 groups? Every edit, added card and added group is replaced.${shareNote} (Export Deck first if you want a copy.)`)) return;
    let original;
    try {
      original = await app.loadOriginal();
    } catch {
      alert("Couldn't load the original cards. Check your connection and try again.");
      return;
    }
    app.replaceDeck(original);
    openCardId = null;
    renderOptions();
    app.toast('Original cards restored');
  });

  // ---------- Edit Cards tab ----------

  function renderFilter() {
    const keep = ui.filter.value;
    const opts = [['all', 'All cards'], ['none', 'In no group'], ['sealed', 'Sealed (give-away) cards'], ['bonus', 'Bonus draw cards'], ...deck().groups.map(g => [`g:${g.id}`, `In: ${g.name}`])];
    ui.filter.innerHTML = opts.map(([val, label]) => `<option value="${esc(val)}">${esc(label)}</option>`).join('');
    ui.filter.value = opts.some(([val]) => val === keep) ? keep : 'all';
  }

  function matchingCards() {
    const term = ui.search.value.trim().toLowerCase();
    const f = ui.filter.value;
    return deck().cards.filter(c => {
      if (f === 'none' && c.groups.length) return false;
      if (f === 'sealed' && !Deck.isSealed(c)) return false;
      if (f === 'bonus' && !Deck.hasBonus(c)) return false;
      if (f.startsWith('g:') && !c.groups.includes(f.slice(2))) return false;
      return !term || `${c.title}\n${c.text}\n${c.secret || ''}\n${c.flavor}`.toLowerCase().includes(term);
    });
  }

  const chipsHtml = c => (Deck.isSealed(c) ? '<span class="chip chip-sealed">Sealed</span>' : '')
    + (Deck.hasBonus(c) ? '<span class="chip chip-bonus">Bonus draw</span>' : '')
    + c.groups.map(id => `<span class="chip">${esc(groupName(id))}</span>`).join('');

  function rowHeadHtml(c) {
    return `<span class="row-main">
        <span class="row-title">${esc(plain(c.title)) || '<em>Untitled</em>'}</span>
        <span class="row-snippet">${esc(plain(c.text))}</span>
        <span class="row-groups">${chipsHtml(c)}</span>
      </span>
      <span class="row-chevron" aria-hidden="true"></span>`;
  }

  function renderCards() {
    renderFilter();
    const cards = matchingCards();
    const total = deck().cards.length;
    ui.cardCount.textContent = cards.length === total
      ? `${total} card${total === 1 ? '' : 's'}. Tap a card to edit it.`
      : `Showing ${cards.length} of ${total} cards.`;
    ui.cardList.innerHTML = cards.map(c => `<li class="card-row" data-card="${c.id}">
        <button type="button" class="card-row-head" data-act="toggle-card" aria-expanded="false">${rowHeadHtml(c)}</button>
      </li>`).join('') || '<li class="empty">No cards match.</li>';
    const row = openCardId != null && rowFor(openCardId);
    if (row) expand(row);
    else openCardId = null;
  }

  const rowFor = id => ui.cardList.querySelector(`.card-row[data-card="${id}"]`);

  function openEditor(id) {
    ui.search.value = '';
    ui.filter.value = 'all';
    openCardId = id;
    selectTab('cards');
    const row = rowFor(id);
    if (row) row.scrollIntoView({ block: 'start' });
  }

  function groupPickerHtml(c) {
    const chips = deck().groups.map(g => `<label class="chip-check">
        <input type="checkbox" data-act="card-group" data-group="${g.id}"${c.groups.includes(g.id) ? ' checked' : ''}>
        <span>${esc(g.name)}</span></label>`).join('');
    return `${chips}<button type="button" class="chip chip-add" data-act="new-group">+ New group</button>`;
  }

  function groupHelp(c) {
    const normal = c.groups.filter(id => !Deck.isPlaceGroup(id)).length;
    const place = c.groups.includes(Deck.PLACE.call) && c.groups.includes(Deck.PLACE.room)
      ? ' In both "where" groups, so it never comes up.'
      : c.groups.includes(Deck.PLACE.call) ? ' Only comes up when you\'re playing on a video call.'
      : c.groups.includes(Deck.PLACE.room) ? ' Left out when you\'re playing on a video call.' : '';
    if (!c.groups.length) return 'In no groups, so it can always come up. Tap groups to add it to as many as you like.';
    return (normal > 1 ? 'Only comes up when all of its groups are checked in Options.'
      : normal ? 'Only comes up when its group is checked in Options.' : '') + place;
  }

  function editorHtml(c) {
    const id = `ed-${c.id}`;
    return `<div class="card-editor">
      <div class="field">
        <label class="field-label" for="${id}-title">Title</label>
        <input id="${id}-title" type="text" data-field="title" maxlength="120" value="${esc(c.title)}">
      </div>
      <div class="field">
        <label class="field-label" for="${id}-text">Text</label>
        <textarea id="${id}-text" data-field="text" rows="4" maxlength="2000">${esc(c.text)}</textarea>
      </div>
      <div class="field">
        <label class="field-label" for="${id}-secret">Sealed part <span class="optional">(optional)</span></label>
        <textarea id="${id}-secret" data-field="secret" rows="3" maxlength="2000" placeholder="Fill this in to make it a give-away card">${esc(c.secret || '')}</textarea>
        <p class="help-block">Makes it a sealed card. Whoever draws it only sees the text above (say, "Give this card to
          the player most likely to…") and has to give it to someone. This part opens on that player's phone. Only
          sealed cards can be given to another player.</p>
      </div>
      <div class="field">
        <label class="field-label" for="${id}-flavor">Flavor text <span class="optional">(optional)</span></label>
        <textarea id="${id}-flavor" data-field="flavor" rows="2" maxlength="2000">${esc(c.flavor)}</textarea>
      </div>
      <fieldset class="field group-picker">
        <legend class="field-label">Groups</legend>
        <div class="chips">${groupPickerHtml(c)}</div>
        <form class="inline-form new-group-form" autocomplete="off" hidden>
          <input type="text" maxlength="80" placeholder="New group name" aria-label="New group name" enterkeyhint="done">
          <button type="submit" class="btn btn-default btn-sm">Add</button>
          <button type="button" class="btn btn-link btn-sm" data-act="cancel-new-group">Cancel</button>
        </form>
        <p class="form-msg group-msg" role="status"></p>
        <p class="help-block group-help">${groupHelp(c)}</p>
      </fieldset>
      <div class="field">
        <span class="field-label">Turns</span>
        <div class="chips"><label class="chip-check">
          <input type="checkbox" data-act="card-bonus"${Deck.hasBonus(c) ? ' checked' : ''}><span>Bonus draw</span></label></div>
        <p class="help-block">For cards like "Draw another card". In a lobby everyone draws one card per turn, and
          whoever draws this one gets to draw one more.</p>
      </div>
      <div class="field">
        <span class="field-label">Preview</span>
        <div class="preview"></div>
        <p class="help-block">Formatting: *italic*, **bold**, [link](https://…). Lines starting with "1." or "-" make a list.</p>
      </div>
      <div class="button-row">
        <button type="button" class="btn btn-default" data-act="show-card">Show on Screen</button>
        <button type="button" class="btn btn-danger-outline" data-act="delete-card">Delete Card</button>
      </div>
    </div>`;
  }

  function renderPreview(row, c) {
    row.querySelector('.preview').innerHTML =
      `<div class="pv-title">${inline(c.title)}</div><div class="pv-text">${render(c.text)}</div>${
        c.secret ? `<div class="pv-inside"><span class="pv-inside-label">Sealed: opens for the player it's given to</span>${render(c.secret)}</div>` : ''}${
        c.flavor ? `<div class="pv-flavor">${render(c.flavor)}</div>` : ''}`;
  }

  function expand(row) {
    for (const other of ui.cardList.querySelectorAll('.card-row.open')) if (other !== row) collapse(other);
    const c = cardById(Number(row.dataset.card));
    if (!c) return;
    openCardId = c.id;
    row.classList.add('open');
    row.querySelector('.card-row-head').setAttribute('aria-expanded', 'true');
    if (!row.querySelector('.card-editor')) row.insertAdjacentHTML('beforeend', editorHtml(c));
    renderPreview(row, c);
  }

  function collapse(row) {
    row.classList.remove('open');
    row.querySelector('.card-row-head').setAttribute('aria-expanded', 'false');
    row.querySelector('.card-editor')?.remove();
    if (openCardId === Number(row.dataset.card)) openCardId = null;
  }

  function refreshRow(row, c) {
    row.querySelector('.card-row-head').innerHTML = rowHeadHtml(c);
    row.querySelector('.group-help').textContent = groupHelp(c);
  }

  ui.search.addEventListener('input', () => { openCardId = null; renderCards(); });
  ui.filter.addEventListener('change', () => { openCardId = null; renderCards(); });

  ui.addCard.addEventListener('click', () => {
    const card = Deck.addCard(deck());
    app.cardAdded(card);
    noteSaving();
    openEditor(card.id);
    const title = rowFor(card.id)?.querySelector('[data-field="title"]');
    title?.focus();
    title?.select();
  });

  ui.cardList.addEventListener('input', e => {
    const field = e.target.dataset.field;
    if (!field) return;
    const row = e.target.closest('.card-row');
    const c = cardById(Number(row.dataset.card));
    if (!c) return;
    c[field] = Deck.cleanCardField(field, e.target.value);
    if (field === 'secret' && !c.secret.trim()) delete c.secret; // an empty sealed part: an ordinary card
    refreshRow(row, c);
    renderPreview(row, c);
    changed();
  });

  ui.cardList.addEventListener('change', e => {
    const bonus = e.target.closest('[data-act="card-bonus"]');
    if (bonus) {
      const row = bonus.closest('.card-row');
      const c = cardById(Number(row.dataset.card));
      if (!c) return;
      if (bonus.checked) c.bonus = true;
      else delete c.bonus;
      refreshRow(row, c);
      changed();
      return;
    }
    const box = e.target.closest('[data-act="card-group"]');
    if (!box) return;
    const row = box.closest('.card-row');
    const c = cardById(Number(row.dataset.card));
    if (!c) return;
    Deck.setCardInGroup(c, box.dataset.group, box.checked);
    refreshRow(row, c);
    changed();
  });

  ui.cardList.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const row = el.closest('.card-row');
    const id = Number(row?.dataset.card);
    switch (el.dataset.act) {
      case 'toggle-card':
        if (row.classList.contains('open')) collapse(row);
        else { expand(row); row.scrollIntoView({ block: 'nearest' }); }
        break;
      case 'new-group': {
        const form = row.querySelector('.new-group-form');
        form.hidden = false;
        form.querySelector('input').focus();
        break;
      }
      case 'cancel-new-group':
        row.querySelector('.new-group-form').hidden = true;
        row.querySelector('.group-msg').textContent = '';
        break;
      case 'show-card':
        app.flushDeck();
        app.showCardById(id);
        close();
        break;
      case 'delete-card': {
        const c = cardById(id);
        if (!c || !confirm(`Delete the card "${plain(c.title)}"?`)) return;
        Deck.deleteCard(deck(), id);
        app.cardDeleted(id);
        noteSaving();
        openCardId = null;
        renderCards();
        break;
      }
    }
  });

  // "+ New group" inside a card: makes the group and puts this card in it.
  ui.cardList.addEventListener('submit', e => {
    const form = e.target.closest('.new-group-form');
    if (!form) return;
    e.preventDefault();
    const row = form.closest('.card-row');
    const c = cardById(Number(row.dataset.card));
    const input = form.querySelector('input');
    const msg = row.querySelector('.group-msg');
    const result = Deck.addGroup(deck(), input.value);
    if (result.error) { msg.textContent = result.error; return; }
    Deck.setCardInGroup(c, result.group.id, true);
    msg.textContent = result.existed ? `Added to the existing group "${result.group.name}".` : '';
    input.value = '';
    form.hidden = true;
    row.querySelector('.chips').innerHTML = groupPickerHtml(c);
    refreshRow(row, c);
    renderFilter();
    changed();
  });

  return { open };
}

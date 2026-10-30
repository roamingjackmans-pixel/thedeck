# THE DECK

Draw a card, do what it says. A party card game for the browser, rebuilt from
[rchowe.com/deck](http://rchowe.com/deck/) as a multiplayer game on a green card table, with an editable deck.

**Play:** https://josephjackman.com/thedeck/

## Playing together

- One person taps **Make a Lobby** and shares the **5-number code** (or the Invite link, `?room=CODE`).
  Everyone else types the code and taps **Join**, on their own phone.
- The **host sets the rules** in the lobby: which card groups are in play, and whether discarded cards stay out
  until the deck runs out or go straight back in. The host can change them mid-game too (the ⋯ button).
- Players take turns in the order they joined. On your turn, **tap the deck** to draw. The card turns over on
  **your phone only**; everyone else sees that you're looking at a card. Then choose:
  - **Show to All**: it pops up on everyone's phone and lands face up on the table.
  - **Give to Player**: pick someone. It pops up privately on their phone with the same three choices, so they
    can show it, pass it on, or keep it.
  - **Add to Hand**: keep it. Cards in your hand can be shown, given away or discarded **any time**, even when
    it isn't your turn.
- **End Turn** moves every face-up card on the table to the discard pile and passes the turn on. You can also
  draw again before ending your turn (for cards like "Draw another card").
- When the deck runs out, the discard pile is **shuffled back in**, like a real deck.
- The host can skip a turn, remove someone who left, or end the game. Someone who drops out on their turn is
  skipped after 20 seconds, and gets their seat and hand back when they return.
- There's no game server. The host's phone runs the game and the others connect straight to it (WebRTC,
  through the free [PeerJS](https://peerjs.com) matchmaking service, the same way Horse Race works). If the host
  leaves, the next player takes over hosting automatically and the game carries on. Everyone plays the host's
  deck, which is sent to each phone when it joins.
- **Play on One Phone** is the original game: tap the deck, do what it says, pass the phone.

## The look

- A felt card table. Tap the **⚙ Settings** button (top right) to pick the **table color**: green, blue, navy,
  teal, purple, pink, red, orange, brown, black, or **any color** from a color picker (very light picks are
  darkened so the writing stays readable). Each phone keeps its own choice. The same picker is in the secret
  menu.
- Cards look like playing cards, but instead of suits their corners have **drinks**: beers, shots, wine bottles
  and martinis (`public/js/cards.js` picks one per card).
- The **card backs** still say THE DECK, with two jokers having a drink, top and bottom like a court card
  (`public/img/back.svg`).

## What it does

Everything the original did:

- **Draw a Card** shows a random card: a title, what to do, and sometimes flavor text.
- Cards are drawn **without replacement**: every card comes up once before any repeats. The half-used deck is
  remembered for 24 hours, so reloading the page doesn't start over.
- The secret **Options** menu hides in the top-left corner: **tap the corner 7 times in a row** (each tap within
  1.5 seconds of the last; a tap anywhere else starts the count over). Nothing shows there, and screens keep
  that corner clear so it never sits on top of a real button. (The original revealed a button on hover.)
- In Options: **Draw Style** (with or without replacement), **Card Options** (uncheck a group such as
  "There are girls present" to keep its cards out of the deck) and **Reset Shoe** (put every card back).
  When you're hosting a lobby, the Card Options and Draw Style are the lobby's rules.
- The ¶ in a card's corner is a link to that card (`#card-12`). Clicking it copies the link.
- All 153 original cards and the original three groups.

New in this version (the **Edit Cards** tab of the secret menu):

- **Edit any card**: title, text and flavor text, with a live preview.
- **Put a card in any number of groups** by tapping group pills. A card only comes up when every one of its
  groups is checked in Options. A card in no groups can always come up.
- **Add groups** (in Options, or with "+ New group" right inside a card), and rename or delete them.
- **Add and delete cards.**
- **Export Deck / Import Deck** to save a copy of a deck, and **Restore Original Cards** to undo everything.
- "With Replacement" works (it was greyed out on the original). Cards never repeat twice in a row.
- Dark mode, a full-screen menu on phones, and Space or Enter to draw on a keyboard.

### Sharing edits with everyone

Everyone plays the same shared deck, `public/cards.json`. Edits are saved on the device first. A device
connected to GitHub then **publishes** them when the secret menu closes (or with **Publish Now**): it commits a
new `cards.json`, GitHub Pages redeploys in about a minute, and every other phone picks up the new deck on its
own (pages check for a newer deck every minute and whenever they come back to the screen).

To connect a device: secret menu → Options → **Your Deck** → **Connect This Device**. The link there opens
GitHub's token page with the name, permission (Contents: read and write) and expiry already filled in. Choose
**Only select repositories → thedeck**, generate the token and paste it in. The token is stored only in that
browser. It expires after a year; when it does, publishing says so, and you connect again with a new one.

Devices that aren't connected can still edit, but their changes stay on that device until they're discarded.
Each published deck has a revision number, so if two connected devices edit at once the second one is asked
before it replaces the first one's changes. Every publish is a commit, so old versions are in the git history.

Which groups are switched on, the draw style and the cards already drawn stay per device.

### Card formatting

`*italic*`, `**bold**`, `[link text](https://example.com)`, and lines starting with `1.` or `-` become a list.
Anything else, including HTML, shows exactly as typed.

## Play locally

```bash
npm start
```

Open http://localhost:8091.

## Tests

```bash
npm test
```

Checks the drawing rules (no repeats, groups switched off, reshuffling), the multiplayer rules (private draws,
passing cards on, playing out of turn, ending turns, reshuffling the discard pile, dropped players, host
takeover), the editing rules (groups, cards, imports), publishing against a pretend GitHub (revisions, two
devices publishing at once, error messages), that card formatting can't run code, and that the shared deck file
is well formed.

To try multiplayer on one computer, open the site in two or three tabs: each tab is its own player.

## Deploying

`.github/workflows/pages.yml` runs the tests and publishes `public/` to GitHub Pages on every push to `main`.
It shows up at `josephjackman.com/thedeck/` because this repo is named `thedeck` and the account's user site
(`roamingjackmans-pixel.github.io`) has the `josephjackman.com` custom domain. The workflow also stamps the
version and adds `?v=<commit>` to every file URL so phones never mix old and new code.

Publishing from the secret menu commits `public/cards.json` to `main`, which runs this same workflow. If you
edit the repo by hand, pull first: the deck may have been published from a phone since.

## Project layout

```
public/              the site (this folder is what gets published)
  index.html, legal.html, css/style.css, version.js
  cards.json         the shared deck everyone plays (changed by publishing)
  original-cards.json  the original 153 cards and 3 groups, for "Restore Original Cards"
  js/app.js          the deck and keeping it in sync, switching screens
  js/solo.js         one-phone mode
  js/game.js         home, lobby and card table screens, and the card viewer
  js/net.js          lobby connections: host, join, reconnect, host handover (from Horse Race)
  js/engine.js       the multiplayer rules (runs on the host; no page code, so it can be tested)
  js/cards.js        drawing playing cards, piles and the flip
  js/menu.js         the secret menu: options, groups, card editor, publishing, export/import
  js/sync.js         publishing to GitHub
  js/deck.js         drawing and editing rules (no page code, so it can be tested)
  js/markup.js       safe card formatting
  js/store.js        saving to this browser
  js/theme.js        table colors and the Settings popup
  img/back.svg       the card back (jokers drinking)
  vendor/peerjs.min.js  PeerJS 1.5.5
tools/
  serve.mjs          local server
  test.mjs           tests
  stamp-build.mjs    deploy version stamp
  convert-yaml.mjs   one-time converter from the original site's cards.yaml
```

## License

THE DECK was created by rchowe and is shared under the
[Creative Commons BY-NC-SA 2.0](https://creativecommons.org/licenses/by-nc-sa/2.0/) license. This adaptation
is shared under the same license. See `public/legal.html`.

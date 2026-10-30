# THE DECK

Draw a card, do what it says. A party card game for the browser, rebuilt from
[rchowe.com/deck](http://rchowe.com/deck/) with an editable deck.

**Play:** https://josephjackman.com/thedeck/

## What it does

Everything the original did:

- **Draw a Card** shows a random card: a title, what to do, and sometimes flavor text.
- Cards are drawn **without replacement**: every card comes up once before any repeats. The half-used deck is
  remembered for 24 hours, so reloading the page doesn't start over.
- A hidden **Options** button sits in the top-left corner. Hover there for a few seconds and it fades in, or
  just tap the corner on a phone.
- In Options: **Draw Style** (with or without replacement), **Card Options** (uncheck a group such as
  "There are girls present" to keep its cards out of the deck) and **Reset Shoe** (put every card back).
- The ¶ next to a card's title is a link to that card (`#card-12`). Clicking it copies the link.
- All 153 original cards and the original three groups.

New in this version (the **Edit Cards** tab of the secret menu):

- **Edit any card**: title, text and flavor text, with a live preview.
- **Put a card in any number of groups** by tapping group pills. A card only comes up when every one of its
  groups is checked in Options. A card in no groups can always come up.
- **Add groups** (in Options, or with "+ New group" right inside a card), and rename or delete them.
- **Add and delete cards.**
- **Export Deck / Import Deck** to copy a deck to another device, and **Restore Original Cards** to undo
  everything.
- "With Replacement" works (it was greyed out on the original). Cards never repeat twice in a row.
- Dark mode, a full-screen menu on phones, and Space or Enter to draw on a keyboard.

Edits are saved in the browser (localStorage) of the device you make them on. They are not sent anywhere and
other people's phones keep the original deck.

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

Checks the drawing rules (no repeats, groups switched off, reshuffling), the editing rules (groups, cards,
imports) and that card formatting can't run code.

## Deploying

`.github/workflows/pages.yml` runs the tests and publishes `public/` to GitHub Pages on every push to `main`.
It shows up at `josephjackman.com/thedeck/` because this repo is named `thedeck` and the account's user site
(`roamingjackmans-pixel.github.io`) has the `josephjackman.com` custom domain. The workflow also stamps the
version and adds `?v=<commit>` to every file URL so phones never mix old and new code.

To change the deck everyone starts with, edit `public/cards.json` and push.

## Project layout

```
public/              the site (this folder is what gets published)
  index.html, legal.html, css/style.css, version.js
  cards.json         the original 153 cards and 3 groups
  js/app.js          main screen: drawing, showing cards, links
  js/menu.js         the secret menu: options, groups, card editor, export/import
  js/deck.js         drawing and editing rules (no page code, so it can be tested)
  js/markup.js       safe card formatting
  js/store.js        saving to this browser
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

// One-time converter: the original deck's cards.yaml (rchowe.com/deck) -> public/cards.json.
//   node tools/convert-yaml.mjs <cards.yaml> [js-yaml module path]
// The original cards held bits of HTML. This turns them into the deck's small, safe formatting
// (*italic*, **bold**, [link](url), "1. " list lines, real line breaks) so cards are easy to edit on a phone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [yamlPath, yamlLib = 'js-yaml'] = process.argv.slice(2);
if (!yamlPath) { console.error('usage: node tools/convert-yaml.mjs <cards.yaml> [js-yaml path]'); process.exit(1); }
const jsyaml = (await import(yamlLib.includes('/') || yamlLib.includes('\\') ? pathToFileURL(yamlLib).href : yamlLib)).default;

const ENTITIES = { hellip: '…', larr: '←', rarr: '→', eacute: 'é', clubs: '♣', diams: '♦', hearts: '♥', spades: '♠', amp: '&', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', lt: '<', gt: '>' };

function toMarkup(html) {
  if (html == null) return '';
  let s = String(html).trim();
  // The one card whose flavor text was a picture of the Dos Equis man.
  if (/<img\b/i.test(s)) s = 'Stay thirsty, my friends.';
  s = s.replace(/<em>doctor<em>/g, '<em>doctor</em>'); // unclosed tag in the original
  s = s.replace(/<ol>\s*/gi, '\n').replace(/\s*<\/ol>/gi, '');
  let n = 0;
  s = s.replace(/<li>\s*([\s\S]*?)\s*<\/li>\s*/gi, (_, item) => `${++n}. ${item.replace(/\s+/g, ' ')}\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<a\s+href\s*=\s*'([^']*)'\s*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<\/?(?:em|i)>/gi, '*').replace(/<\/?(?:strong|b)>/gi, '**');
  s = s.replace(/<\/?span[^>]*>/gi, '');
  if (/<[a-z/]/i.test(s)) throw new Error('unconverted HTML: ' + s);
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
  s = s.replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? m);
  return s.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const GROUPS = [
  { id: 'snow', name: 'Snow on the ground', from: 'Snow on the ground' },
  { id: 'girls', name: 'There are girls present', from: 'There are girls present' },
  { id: 'stranger', name: 'You can find a stranger', from: 'You can find a stranger' },
];

const src = jsyaml.load(fs.readFileSync(yamlPath, 'utf8'));
const cards = src.cards.map((c, i) => {
  const groups = (c.requirements || []).map(r => {
    const g = GROUPS.find(g => g.from === r);
    if (!g) throw new Error('unknown requirement: ' + r);
    return g.id;
  });
  let flavor = toMarkup(c.flavor_text);
  // The original asked players to email the author new cards. Here the deck's owner can add them directly.
  if (c.title === 'Add a Card') flavor = 'Whoever is holding the phone can add it for real.';
  return { id: i + 1, title: toMarkup(c.title), text: toMarkup(c.text), flavor, groups };
});

const deck = { format: 'the-deck', version: 1, groups: GROUPS.map(({ id, name }) => ({ id, name })), cards };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'cards.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(deck, null, 2) + '\n');
console.log(`wrote ${cards.length} cards, ${GROUPS.length} groups -> ${path.relative(process.cwd(), out)}`);

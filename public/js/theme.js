// The table mat color. Each choice is three shades of one color (light, middle, dark) for the felt
// gradient. It's a per-phone preference, saved in this browser; index.html applies it before the page paints.
import * as Store from './store.js';

export const TABLES = [
  { id: 'green', name: 'Green', colors: ['#2b8a55', '#1b6440', '#0b3722'] },
  { id: 'blue', name: 'Blue', colors: ['#2f6fb5', '#1d4f88', '#0b2547'] },
  { id: 'navy', name: 'Navy', colors: ['#34508f', '#1e3264', '#09132e'] },
  { id: 'teal', name: 'Teal', colors: ['#1f8f8b', '#136a68', '#053533'] },
  { id: 'purple', name: 'Purple', colors: ['#7b4cb3', '#57318c', '#271046'] },
  { id: 'pink', name: 'Pink', colors: ['#c45089', '#9a3267', '#4c1131'] },
  { id: 'red', name: 'Red', colors: ['#b8363c', '#8c1f27', '#470a10'] },
  { id: 'orange', name: 'Orange', colors: ['#c8692b', '#9b4a17', '#4b2007'] },
  { id: 'brown', name: 'Brown', colors: ['#8d5c36', '#6b4125', '#321807'] },
  { id: 'black', name: 'Black', colors: ['#3d3d42', '#24242a', '#09090b'] },
];

const HEX = /^#[0-9a-f]{6}$/i;

function toHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toHex(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

/** A mat from any color. Light colors are darkened, so white writing on the table stays readable. */
export function customTable(hex) {
  const [h, s0, l0] = toHsl(HEX.test(hex) ? hex : '#1b6440');
  const s = Math.min(s0, 0.85);
  const l = Math.min(Math.max(l0, 0.1), 0.42);
  return { id: 'custom', name: 'Custom', pick: hex, colors: [toHex(h, s, Math.min(l + 0.11, 0.55)), toHex(h, s, l), toHex(h, s, Math.max(l * 0.36, 0.04))] };
}

export function currentTable() {
  const saved = Store.load('table');
  if (saved?.id === 'custom' && Array.isArray(saved.colors) && saved.colors.every(c => HEX.test(c))) return saved;
  return TABLES.find(t => t.id === saved?.id) || TABLES[0];
}

export function applyTable(t) {
  const root = document.documentElement.style;
  t.colors.forEach((c, i) => root.setProperty(`--felt-${i + 1}`, c));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.colors[1]);
}

function swatchesHtml(selected) {
  const custom = selected.id === 'custom' ? selected : null;
  const vars = colors => `--sw1:${colors[0]};--sw2:${colors[1]};--sw3:${colors[2]}`;
  return TABLES.map(t => `<button type="button" class="swatch" data-table="${t.id}" aria-pressed="${t.id === selected.id}" style="${vars(t.colors)}">
      <span class="swatch-felt"></span><span class="swatch-name">${t.name}</span></button>`).join('')
    + `<label class="swatch swatch-custom${custom ? ' has-color' : ''}" aria-pressed="${!!custom}"${custom ? ` style="${vars(custom.colors)}"` : ''}>
        <span class="swatch-felt"><input type="color" value="${custom?.pick || '#1b6440'}" aria-label="Pick any color"></span>
        <span class="swatch-name">Any color</span></label>`;
}

/** Wires up every swatch picker on the page (the Settings popup and the secret menu) and the ⚙ buttons. */
export function initSettings() {
  const dialog = document.getElementById('settings');
  const pickers = [...document.querySelectorAll('[data-swatches]')];
  let table = currentTable();
  applyTable(table);

  const render = () => { for (const el of pickers) el.innerHTML = swatchesHtml(table); };
  const choose = t => {
    table = t;
    Store.save('table', { id: t.id, colors: t.colors, ...(t.pick ? { pick: t.pick } : {}) });
    applyTable(t);
  };

  for (const el of pickers) {
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-table]');
      if (!b) return;
      choose(TABLES.find(t => t.id === b.dataset.table));
      render();
    });
    // Dragging around the color wheel recolors the table live; the swatches catch up when it's done.
    el.addEventListener('input', e => { if (e.target.type === 'color') choose(customTable(e.target.value)); });
    el.addEventListener('change', e => { if (e.target.type === 'color') render(); });
  }
  render();

  document.addEventListener('click', e => {
    if (e.target.closest('[data-settings]')) { render(); dialog.showModal(); }
    if (e.target.closest('[data-close-settings]') || e.target === dialog) dialog.close();
  });
}

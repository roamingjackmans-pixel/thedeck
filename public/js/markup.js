// Card formatting: a small, safe subset of Markdown, so cards are easy to write on a phone.
//   *italic*   **bold**   [link text](https://example.com)
//   lines starting "1. " become a numbered list, lines starting "- " a bulleted list,
//   other line breaks stay line breaks, and a blank line starts a new paragraph.
// Everything else shows exactly as typed: any HTML is escaped, so a card can never run code.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** One line of text -> HTML with links, bold, italic and red suits. */
export function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()<>"]+)\)/g,
    (m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/[♥♦]/g, '<span class="red-suit">$&</span>');
  return s;
}

/** A whole card field -> HTML with paragraphs, line breaks and lists. */
export function render(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let para = [];
  let list = null; // { tag: 'ol' | 'ul', items: [] }
  const flushPara = () => { if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; };
  const flushList = () => {
    if (list) html += `<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`;
    list = null;
  };
  for (const line of lines) {
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const ul = !ol && /^\s*[-•]\s+(.*)$/.exec(line);
    const item = ol || ul;
    if (item) {
      const tag = ol ? 'ol' : 'ul';
      flushPara();
      if (list && list.tag !== tag) flushList();
      (list ||= { tag, items: [] }).items.push(item[1]);
      continue;
    }
    flushList();
    if (!line.trim()) { flushPara(); continue; }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return html;
}

/** Formatting marks removed, for short labels like card lists. */
export function plain(text) {
  return String(text ?? '')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

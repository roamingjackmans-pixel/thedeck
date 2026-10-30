// Tiny static file server for trying the site locally:  node tools/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const port = +process.argv[2] || +process.env.PORT || 8091;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = types[path.extname(file)] || 'application/octet-stream';
    const text = /^(text|application\/json|image\/svg)/.test(type);
    res.writeHead(200, { 'content-type': type + (text ? '; charset=utf-8' : ''), 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`THE DECK on http://localhost:${port}`));

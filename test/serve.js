'use strict';
// Static server for browser-mode UI testing: serves src/renderer plus
// /__defaults (config-store defaults) for the mock bridge.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/main/config-store.js');

const rootDir = path.join(__dirname, '..', 'src', 'renderer');
const types = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml',
};
const port = Number(process.env.PORT || 5199);

http.createServer((req, res) => {
  if (req.url === '/__defaults') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(store.defaults()));
    return;
  }
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(rootDir, urlPath));
  if (!file.startsWith(rootDir)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  });
}).listen(port, () => console.log(`serving on http://127.0.0.1:${port}`));

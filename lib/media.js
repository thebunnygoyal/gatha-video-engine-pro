'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// The capability is private to the owned worker. No route serves arbitrary paths.
async function createMediaServer(files) {
  const capability = crypto.randomBytes(24).toString('hex');
  const entries = new Map();
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name) || !path.isAbsolute(file.path) || entries.has(file.name)) {
      throw new Error('Invalid owned media entry');
    }
    const stat = await fs.promises.stat(file.path);
    if (!stat.isFile() || stat.size <= 0) throw new Error('Invalid owned media file');
    entries.set(file.name, { ...file, size: stat.size });
  }
  const streams = new Set();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    // Compare the exact request target. Encoded traversal and query strings do not match.
    const prefix = '/' + capability + '/';
    const name = typeof req.url === 'string' && req.url.startsWith(prefix) ? req.url.slice(prefix.length) : '';
    const file = entries.get(name);
    if (!file) { res.writeHead(404); res.end(); return; }
    let start = 0;
    let end = file.size - 1;
    let partial = false;
    if (req.headers.range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + file.size }); res.end(); return;
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + file.size }); res.end(); return;
        }
        start = Math.max(0, file.size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + file.size }); res.end(); return;
      }
      partial = true;
    }
    res.writeHead(partial ? 206 : 200, {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file.path, { start, end });
    streams.add(stream);
    stream.once('close', () => streams.delete(stream));
    stream.once('error', () => res.destroy());
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  // A socket/runtime error must not become an unhandled exception in a render worker.
  server.on('error', () => {});
  const port = server.address().port;
  let closing;
  return {
    url(name) {
      if (!entries.has(name)) throw new Error('Unknown owned media');
      return `http://127.0.0.1:${port}/${capability}/${name}`;
    },
    close() {
      if (!closing) closing = new Promise((resolve, reject) => {
        for (const stream of streams) stream.destroy();
        for (const socket of sockets) socket.destroy();
        server.close((error) => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}

module.exports = { createMediaServer };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createMediaServer } = require('../lib/media');
const { temporary } = require('./helpers');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('private media serves exact bytes, HEAD and single ranges and closes', async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, 'voice.mp3');
  await fs.writeFile(file, '0123456789');
  const media = await createMediaServer([{ name: 'voice.mp3', path: file, type: 'audio/mpeg' }]);
  t.after(() => media.close());
  const url = media.url('voice.mp3');
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal((await request(url)).data.toString(), '0123456789');
  const head = await request(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '10');
  assert.equal(head.data.length, 0);
  const part = await request(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 2-4/10');
  assert.equal(part.data.toString(), '234');
  assert.equal((await request(url, { headers: { Range: 'bytes=-3' } })).data.toString(), '789');
  assert.equal((await request(url, { headers: { Range: 'bytes=9-' } })).data.toString(), '9');
  for (const range of ['bytes=12-', 'bytes=4-2', 'bytes=1-2,4-5', 'bytes=-0', 'bytes=99999999999999999999-']) {
    assert.equal((await request(url, { headers: { Range: range } })).status, 416);
  }
  assert.equal((await request(url, { method: 'POST' })).status, 405);
  assert.equal((await request(url + '?other=1')).status, 404);
  assert.equal((await request(url.replace('voice.mp3', '%2e%2e/private'))).status, 404);
  assert.equal((await request(url.replace(/\/[a-f0-9]{48}\//, '/wrong/'))).status, 404);
  await media.close();
  await assert.rejects(request(url));
});

test('media inventory cannot serve relative or duplicate/unowned names', async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, 'a');
  await fs.writeFile(file, 'x');
  await assert.rejects(createMediaServer([{ name: '../a', path: file }]));
  await assert.rejects(createMediaServer([{ name: 'a', path: 'relative' }]));
  await assert.rejects(createMediaServer([{ name: 'a', path: file }, { name: 'a', path: file }]));
});

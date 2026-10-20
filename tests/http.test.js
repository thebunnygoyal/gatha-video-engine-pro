'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createApp } = require('../server');
const { GenerationOwner } = require('../lib/owner');
const { temporary, deferred, body, resultFor } = require('./helpers');

async function application(t, worker) {
  const tempRoot = await temporary(t, 'gatha-http-fixture-');
  const owner = new GenerationOwner({ tempRoot, bucket: 'fixture-bucket', worker });
  const server = http.createServer(createApp({ owner }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await owner.shutdown(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { owner, url: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP result waits for owned upload work and concurrent requests are not accepted', async (t) => {
  const entered = deferred();
  const finish = deferred();
  let calls = 0;
  const app = await application(t, async (job, controls) => {
    calls++;
    controls.onBundleReady();
    entered.resolve();
    await Promise.race([finish.promise, new Promise((_, reject) => controls.signal.addEventListener('abort', () => reject(controls.signal.reason), { once: true }))]);
    return resultFor(job);
  });
  let responded = false;
  const pending = fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => { responded = true; return response; });
  await entered.promise;
  assert.equal(responded, false);
  const busy = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '10');
  assert.equal((await busy.json()).error.code, 'busy');
  assert.equal(calls, 1);
  finish.resolve();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'completed');
  assert.equal(await (await fetch(app.url + '/health')).text(), 'OK');
});

test('malformed/oversized JSON never dispatches and errors contain no request text', async (t) => {
  let calls = 0;
  const app = await application(t, async () => { calls++; });
  for (const [requestBody, status, code] of [
    ['{fixture-private', 400, 'invalid_request'],
    [JSON.stringify({ scenes: [] }), 400, 'invalid_request'],
    [JSON.stringify({ scenes: body.scenes, excess: 'x'.repeat(102400) }), 413, 'body_too_large'],
  ]) {
    const response = await fetch(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.equal(text.includes('fixture-private'), false);
  }
  assert.equal(calls, 0);
});

test('closing a completed request body does not cancel work; response disconnect does', async (t) => {
  const entered = deferred();
  const aborted = deferred();
  const app = await application(t, async (_job, controls) => {
    entered.resolve();
    await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve(controls.signal.reason.code);
    throw controls.signal.reason;
  });
  const request = http.request(app.url + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify(body));
  await entered.promise;
  assert.ok(app.owner.active);
  request.destroy();
  assert.equal(await aborted.promise, 'disconnected');
});

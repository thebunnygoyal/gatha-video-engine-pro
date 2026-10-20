'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateScenes, errorBody, GenerationError, LIMITS } = require('../lib/policy');
const { providerUrl } = require('../lib/runtime');

test('accepted bounds preserve exact text and strip unconsumed fields', () => {
  const scene = { text: '😀'.repeat(4000), prompt: 'x'.repeat(4000), camera_move: 'c'.repeat(256), unused: 'not forwarded' };
  const result = validateScenes({ scenes: Array.from({ length: 12 }, () => scene) });
  assert.equal(result.length, 12);
  assert.equal(result[0].text, scene.text);
  assert.equal(result[0].unused, undefined);
  assert.equal(LIMITS.bodyBytes, 102400);
  assert.equal(LIMITS.overallMs, 3300000);
});

test('invalid shape, size and text fail before any provider work', () => {
  const invalid = [null, [], {}, { scenes: [] }, { scenes: Array(13).fill({ text: 'a', prompt: 'b' }) },
    { scenes: [null] }, { scenes: [{ text: ' ', prompt: 'b' }] }, { scenes: [{ text: 'a', prompt: 3 }] },
    { scenes: [{ text: 'a'.repeat(4001), prompt: 'b' }] }, { scenes: [{ text: 'a', prompt: 'b'.repeat(4001) }] },
    { scenes: [{ text: 'a', prompt: 'b', camera_move: null }] },
    { scenes: [{ text: 'a', prompt: 'b', camera_move: 'c'.repeat(257) }] }];
  for (const value of invalid) assert.throws(() => validateScenes(value), (error) => error.code === 'invalid_request');
});

test('error messages never copy raw provider error text or untrusted stages', () => {
  const result = errorBody(new Error('fixture-secret-private-provider-body'));
  assert.equal(result.error.code, 'worker_failed');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(new GenerationError('unknown-secret', 'unknown-secret').stage, undefined);
  assert.equal(result.error.retryable, false);
});

test('provider asset boundaries require bounded HTTPS URLs', () => {
  assert.equal(providerUrl('https://fixture.invalid/a.mp4', 'video'), 'https://fixture.invalid/a.mp4');
  for (const value of [null, 3, 'file:///private', 'http://127.0.0.1/a', 'https://name:password@fixture.invalid/a', 'https://fixture.invalid/' + 'a'.repeat(8200)]) {
    assert.throws(() => providerUrl(value, 'video'), (error) => error.code === 'provider_response_invalid');
  }
});

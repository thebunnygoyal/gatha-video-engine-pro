'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.platform, 'linux');
assert.equal(Number(process.versions.node.split('.')[0]), 20, 'Use the pinned runtime image');
const installed = {};
for (const name of ['@remotion/renderer', '@remotion/bundler', '@google-cloud/storage', 'axios', 'express']) {
  // Read the exact installed metadata without relying on package.json export maps.
  installed[name] = JSON.parse(fs.readFileSync(path.join('/app/node_modules', name, 'package.json'), 'utf8')).version;
}
assert.deepEqual(installed, { '@remotion/renderer': '4.0.526', '@remotion/bundler': '4.0.526',
  '@google-cloud/storage': '7.22.0', axios: '1.20.0', express: '4.22.3' });
console.log(JSON.stringify({ verification_runtime: process.version, installed, paid_provider_calls: 0 }));
for (const args of [
  ['--test', 'tests/policy.test.js', 'tests/media.test.js', 'tests/generation.test.js', 'tests/owner.test.js', 'tests/runtime.test.js', 'tests/process-ledger.test.js', 'tests/http.test.js', 'tests/worker.test.js'],
  ['verify/runtime-media.js'],
]) {
  const completed = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 900_000 });
  if (completed.status !== 0) process.exit(completed.status || 1);
}

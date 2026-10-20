'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { runWorker } = require('../lib/worker-runner');
const { GenerationError, LIMITS } = require('../lib/policy');
const { temporary, resultFor } = require('./helpers');

const workerPath = path.join(__dirname, 'fixtures/worker.js');
const linux = { skip: process.platform !== 'linux' };
async function fixture(t, mode) {
  const root = await temporary(t, 'gatha-worker-fixture-');
  const job = { jobId: 'fixture-id', bucket: 'fixture-bucket', scenes: [{ text: mode, prompt: 'fixture' }],
    tempDir: path.join(root, 'job'), bundleDir: path.join(root, 'bundle'), bundleReady: false };
  await fs.mkdir(job.tempDir); await fs.mkdir(job.bundleDir);
  return job;
}
async function notRunning(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0];
      // A zombie has no executing code/open media; its parent/init owns reaping.
      if (state === 'Z' || state === 'X') return;
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Owned fixture process is still running');
}

test('worker result is received and all owned processes stop before settlement', linux, async (t) => {
  const job = await fixture(t, 'result');
  let ready = 0;
  assert.deepEqual(await runWorker(job, { workerPath, onBundleReady: () => { ready++; } }), resultFor(job));
  assert.equal(ready, 1);
  await notRunning(JSON.parse(await fs.readFile(path.join(job.tempDir, 'pids.json'), 'utf8')).leader);
});

test('worker failure is sanitized', linux, async (t) => {
  const job = await fixture(t, 'failure');
  await assert.rejects(runWorker(job, { workerPath }), (error) => error.code === 'provider_failed' && !error.message.includes('must never'));
});

test('a stage deadline stops a worker and its detached descendant before settling', linux, async (t) => {
  const job = await fixture(t, 'stall');
  await assert.rejects(runWorker(job, { workerPath, stageLimits: { ...LIMITS.stages, voice: 80 } }),
    (error) => error.code === 'stage_timeout' && error.stage === 'voice');
  const pids = JSON.parse(await fs.readFile(path.join(job.tempDir, 'pids.json'), 'utf8'));
  await notRunning(pids.leader); await notRunning(pids.child);
});

test('caller cancellation stops the worker and a separate child process group', linux, async (t) => {
  const job = await fixture(t, 'stall');
  const controller = new AbortController();
  const pending = assert.rejects(runWorker(job, { workerPath, signal: controller.signal }), (error) => error.code === 'disconnected');
  const record = path.join(job.tempDir, 'pids.json');
  let pids;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { pids = JSON.parse(await fs.readFile(record, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(pids);
  controller.abort(new GenerationError('disconnected'));
  await pending;
  await notRunning(pids.leader); await notRunning(pids.child);
});

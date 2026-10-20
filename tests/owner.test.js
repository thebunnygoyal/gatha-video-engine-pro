'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { GenerationOwner } = require('../lib/owner');
const { GenerationError } = require('../lib/policy');
const { temporary, deferred, body, resultFor } = require('./helpers');

async function setup(t, overrides = {}) {
  const tempRoot = await temporary(t, 'gatha-owner-fixture-');
  const owner = new GenerationOwner({ tempRoot, bucket: 'fixture-bucket', ...overrides });
  t.after(() => owner.shutdown());
  return { owner, tempRoot };
}

test('invalid, unavailable and unconfigured requests make zero worker calls', async (t) => {
  let calls = 0;
  const { owner, tempRoot } = await setup(t, { worker: async () => { calls++; }, isConfigured: () => false });
  await assert.rejects(owner.generate({ scenes: [] }), (error) => error.code === 'invalid_request');
  await assert.rejects(owner.generate(body), (error) => error.code === 'not_configured');
  owner.stopping = true;
  await assert.rejects(owner.generate(body), (error) => error.code === 'unavailable');
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('one active job owns the slot until completion and reuses only a finished bundle', async (t) => {
  const entered = deferred();
  const finish = deferred();
  const jobs = [];
  const { owner, tempRoot } = await setup(t, { worker: async (job, controls) => {
    jobs.push(job);
    if (!job.bundleReady) controls.onBundleReady();
    entered.resolve();
    await finish.promise;
    return resultFor(job);
  } });
  const first = owner.generate(body);
  await entered.promise;
  await assert.rejects(owner.generate(body), (error) => error.code === 'busy');
  assert.equal(jobs.length, 1);
  assert.equal((await fs.readdir(tempRoot)).length, 2);
  finish.resolve();
  const completed = await first;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, resultFor(jobs[0]));
  await assert.rejects(fs.stat(jobs[0].tempDir), { code: 'ENOENT' });
  await owner.generate(body);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].bundleReady, false);
  assert.equal(jobs[1].bundleReady, true);
  assert.equal(jobs[1].bundleDir, jobs[0].bundleDir);
  assert.notEqual(jobs[1].jobId, jobs[0].jobId);
  assert.equal((await fs.readdir(tempRoot)).length, 1);
});

test('failed/incomplete bundle is removed before a new attempt', async (t) => {
  const jobs = [];
  const { owner, tempRoot } = await setup(t, { worker: async (job, controls) => {
    jobs.push(job);
    if (jobs.length === 1) throw new GenerationError('bundle_failed', 'bundle');
    controls.onBundleReady();
    return resultFor(job);
  } });
  await assert.rejects(owner.generate(body), (error) => error.code === 'bundle_failed');
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await owner.generate(body);
  assert.equal(jobs[1].bundleReady, false);
  assert.notEqual(jobs[1].bundleDir, jobs[0].bundleDir);
});

test('a broken previously cached bundle is invalidated', async (t) => {
  const jobs = [];
  const { owner } = await setup(t, { worker: async (job, controls) => {
    jobs.push(job);
    if (jobs.length === 2) throw new GenerationError('bundle_failed', 'bundle');
    controls.onBundleReady();
    return resultFor(job);
  } });
  await owner.generate(body);
  await assert.rejects(owner.generate(body), (error) => error.code === 'bundle_failed');
  await owner.generate(body);
  assert.notEqual(jobs[2].bundleDir, jobs[0].bundleDir);
  assert.equal(jobs[2].bundleReady, false);
});

test('overall deadline waits for the cancelled worker to settle before cleanup/admission', async (t) => {
  const aborted = deferred();
  const finish = deferred();
  let job;
  const { owner, tempRoot } = await setup(t, { overallMs: 30, worker: async (value, controls) => {
    job = value;
    await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
    aborted.resolve();
    await finish.promise;
    throw controls.signal.reason;
  } });
  const pending = assert.rejects(owner.generate(body), (error) => error.code === 'overall_timeout');
  await aborted.promise;
  assert.ok(owner.active);
  assert.ok((await fs.stat(job.tempDir)).isDirectory());
  await assert.rejects(owner.generate(body), (error) => error.code === 'busy');
  finish.resolve();
  await pending;
  assert.equal(owner.active, null);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('client abort propagates while preserving worker ownership', async (t) => {
  const entered = deferred();
  const controller = new AbortController();
  const { owner, tempRoot } = await setup(t, { worker: async (_job, controls) => {
    entered.resolve();
    await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
    throw controls.signal.reason;
  } });
  const pending = assert.rejects(owner.generate(body, { signal: controller.signal }), (error) => error.code === 'disconnected');
  await entered.promise;
  controller.abort();
  await pending;
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('cleanup failure is retained, blocks admission, and can be cleaned on shutdown', async (t) => {
  let denyCleanup = true;
  const { owner, tempRoot } = await setup(t, {
    worker: async (job, controls) => { controls.onBundleReady(); return resultFor(job); },
    removeDirectory: async (directory) => {
      if (denyCleanup && path.basename(directory).startsWith('gatha-job-')) throw new Error('fixture permission failure');
      await fs.rm(directory, { recursive: true, force: true });
    },
  });
  await assert.rejects(owner.generate(body), (error) => {
    assert.equal(error.code, 'cleanup_failed');
    assert.ok(error.result.gcs_uri.startsWith('gs://fixture-bucket/renders/'));
    return true;
  });
  assert.equal(owner.available, false);
  assert.equal(owner.ownedDirectories.size, 2);
  await assert.rejects(owner.generate(body), (error) => error.code === 'unavailable');
  denyCleanup = false;
  await owner.shutdown();
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('cleanup never accepts an unowned directory', async (t) => {
  const { owner, tempRoot } = await setup(t);
  const foreign = path.join(tempRoot, 'unowned');
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, 'keep'), 'preserved');
  await assert.rejects(owner.removeOwned(foreign), (error) => error.code === 'cleanup_failed');
  assert.equal(await fs.readFile(path.join(foreign, 'keep'), 'utf8'), 'preserved');
});

test('unconfirmed native shutdown retains all owned paths and blocks cleanup/admission', async (t) => {
  const tempRoot = await temporary(t, 'gatha-unsettled-fixture-');
  let removals = 0;
  const owner = new GenerationOwner({ tempRoot, worker: async () => {
    throw new GenerationError('cancellation_failed', 'finalize');
  }, removeDirectory: async () => { removals++; } });
  await assert.rejects(owner.generate(body), (error) => error.code === 'cancellation_failed');
  assert.equal(removals, 0);
  assert.equal(owner.available, false);
  assert.equal(owner.ownedDirectories.size, 2);
  await assert.rejects(owner.generate(body), (error) => error.code === 'unavailable');
  await assert.rejects(owner.shutdown(), (error) => error.code === 'cancellation_failed');
  assert.equal(removals, 0);
  assert.equal((await fs.readdir(tempRoot)).length, 2);
  // This fixture has no real child; temporary() owns its independent cleanup.
});

test('shutdown cancels the active worker before removing its files', async (t) => {
  const entered = deferred();
  const { owner, tempRoot } = await setup(t, { worker: async (_job, controls) => {
    entered.resolve();
    await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
    throw controls.signal.reason;
  } });
  const pending = assert.rejects(owner.generate(body), (error) => error.code === 'shutting_down');
  await entered.promise;
  await owner.shutdown();
  await pending;
  assert.deepEqual(await fs.readdir(tempRoot), []);
  await assert.rejects(owner.generate(body), (error) => error.code === 'unavailable');
});

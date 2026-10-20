'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { runGeneration } = require('../lib/generation');
const { LIMITS } = require('../lib/policy');
const { temporary, body, resultFor, deferred } = require('./helpers');

async function fixture(t, failure) {
  const root = await temporary(t);
  const job = { jobId: 'fixture-job', scenes: body.scenes, tempDir: path.join(root, 'job'),
    bundleDir: path.join(root, 'bundle'), bundleReady: false, bucket: 'fixture-bucket' };
  await fs.mkdir(job.tempDir);
  await fs.mkdir(job.bundleDir);
  const calls = [];
  const audioUrls = [];
  const fail = (name) => { calls.push(name); if (failure === name) throw new Error('fixture-private-error'); };
  const dependencies = {
    async bundle({ outDir }) { fail('bundle'); await fs.mkdir(outDir); await fs.writeFile(path.join(outDir, 'index.html'), 'fixture'); },
    async voice(text) { fail('voice'); assert.equal(text, body.scenes[0].text); return Buffer.from('fixture-mp3'); },
    async image(prompt) { fail('image'); assert.equal(prompt, body.scenes[0].prompt); return 'https://fixture.invalid/key.png'; },
    async video(prompt, image) { fail('video'); assert.equal(prompt, 'A red landscape. [pan left]'); assert.equal(image, 'https://fixture.invalid/key.png'); return 'https://fixture.invalid/video.mp4'; },
    async selectComposition(options) { fail('select'); assert.equal(options.id, 'Main'); return { durationInFrames: 300, width: 1920, height: 1080, fps: 30 }; },
    async renderMedia(options) {
      fail('render');
      assert.equal(options.composition.durationInFrames, 150);
      assert.equal(options.codec, 'h264');
      const url = options.inputProps.scenes[0].audioUrl;
      audioUrls.push(url);
      assert.equal(new URL(url).hostname, '127.0.0.1');
      assert.equal(await (await fetch(url)).text(), 'fixture-mp3');
      await fs.writeFile(options.outputLocation, 'fixture-mp4');
    },
    async upload(file, destination) { fail('upload'); assert.equal(await fs.readFile(file, 'utf8'), 'fixture-mp4'); assert.deepEqual(destination, { bucket: 'fixture-bucket', object: 'renders/fixture-job.mp4' }); },
  };
  return { job, dependencies, calls, audioUrls };
}

test('complete pipeline preserves providers/input props and waits for upload', async (t) => {
  const item = await fixture(t);
  const uploadEntered = deferred();
  const uploadFinish = deferred();
  const originalUpload = item.dependencies.upload;
  item.dependencies.upload = async (...args) => { uploadEntered.resolve(); await uploadFinish.promise; await originalUpload(...args); };
  const messages = [];
  let settled = false;
  const pending = runGeneration(item.job, item.dependencies, (message) => messages.push(message)).then((result) => { settled = true; return result; });
  await uploadEntered.promise;
  assert.equal(settled, false);
  uploadFinish.resolve();
  assert.deepEqual(await pending, resultFor(item.job));
  assert.deepEqual(item.calls, ['bundle', 'voice', 'image', 'video', 'select', 'render', 'upload']);
  assert.equal(messages.filter((message) => message.type === 'bundle_ready').length, 1);
  await assert.rejects(fetch(item.audioUrls[0]));
});

for (const failure of ['bundle', 'voice', 'image', 'video', 'select', 'render', 'upload']) {
  test(`pipeline ${failure} failure is sanitized and stops later work`, async (t) => {
    const item = await fixture(t, failure);
    await assert.rejects(runGeneration(item.job, item.dependencies), (error) => {
      assert.equal(error.message.includes('fixture-private'), false);
      return ['bundle_failed', 'provider_failed', 'render_failed', 'upload_failed'].includes(error.code);
    });
    assert.equal(item.calls.at(-1), failure);
    for (const url of item.audioUrls) await assert.rejects(fetch(url));
  });
}

test('a ready bundle is reused, with its entry checked before paid calls', async (t) => {
  const item = await fixture(t);
  const site = path.join(item.job.bundleDir, 'site');
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, 'index.html'), 'ready');
  item.job.bundleReady = true;
  await runGeneration(item.job, item.dependencies);
  assert.equal(item.calls.includes('bundle'), false);
  await fs.unlink(path.join(site, 'index.html'));
  item.calls.length = 0;
  await assert.rejects(runGeneration(item.job, item.dependencies), (error) => error.code === 'bundle_failed');
  assert.deepEqual(item.calls, []);
});

test('empty or oversized audio fails before image/video work', async (t) => {
  for (const audio of [Buffer.alloc(0), Buffer.alloc(LIMITS.voiceBytes + 1)]) {
    const item = await fixture(t);
    item.dependencies.voice = async () => audio;
    await assert.rejects(runGeneration(item.job, item.dependencies), (error) => error.code === 'provider_response_invalid');
    assert.equal(item.calls.includes('image'), false);
  }
});

test('two scenes preserve the transition overlap and independent audio files', async (t) => {
  const item = await fixture(t);
  item.job.scenes = [...body.scenes, ...body.scenes];
  item.dependencies.renderMedia = async (options) => {
    assert.equal(options.composition.durationInFrames, 285);
    const urls = options.inputProps.scenes.map((scene) => scene.audioUrl);
    assert.notEqual(urls[0], urls[1]);
    for (const url of urls) assert.equal(await (await fetch(url)).text(), 'fixture-mp3');
    await fs.writeFile(options.outputLocation, 'fixture-mp4');
  };
  await runGeneration(item.job, item.dependencies);
  assert.equal(item.calls.filter((call) => call === 'voice').length, 2);
});

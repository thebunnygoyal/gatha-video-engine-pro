'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Writable } = require('node:stream');
const test = require('node:test');
const { createRuntimeDependencies } = require('../lib/runtime');
const { LIMITS } = require('../lib/policy');
const { temporary } = require('./helpers');

test('actual adapters preserve payloads and explicit deadlines without paid retries', async (t) => {
  const calls = [];
  let axiosOptions;
  let storageOptions;
  let streamOptions;
  let uploaded = Buffer.alloc(0);
  let browsers = 0;
  let closes = 0;
  const browser = { close: async (options) => { assert.equal(options.silent, true); closes++; } };
  const controller = new AbortController();
  const dependencies = createRuntimeDependencies({
    signal: controller.signal,
    environment: { FAL_API_KEY: 'fixture-fal', ELEVENLABS_API_KEY: 'fixture-eleven', REMOTION_CHROMIUM_EXECUTABLE: '/fixture/chromium' },
    axios: { create(options) {
      axiosOptions = options;
      return { async post(url, data, config) {
        calls.push({ url, data, config });
        if (calls.length === 1) return { data: Buffer.from('fixture-audio') };
        if (calls.length === 2) return { data: { images: [{ url: 'https://fixture.invalid/image.png' }] } };
        return { data: { video: { url: 'https://fixture.invalid/video.mp4' } } };
      } };
    } },
    bundle: async () => {},
    renderer: {
      makeCancelSignal: () => ({ cancelSignal: () => {}, cancel: () => {} }),
      openBrowser: async (_name, options) => { browsers++; assert.equal(options.browserExecutable, '/fixture/chromium'); return browser; },
      selectComposition: async (options) => options, renderMedia: async (options) => options,
    },
    Storage: class {
      constructor(options) { storageOptions = options; }
      bucket(bucket) {
        assert.equal(bucket, 'fixture-bucket');
        return { file(object) {
          assert.equal(object, 'renders/fixture.mp4');
          return { createWriteStream(options) {
            streamOptions = options;
            return new Writable({ write(chunk, _encoding, done) { uploaded = Buffer.concat([uploaded, chunk]); done(); } });
          } };
        } };
      }
    },
  });
  assert.equal((await dependencies.voice('exact voice text')).toString(), 'fixture-audio');
  const image = await dependencies.image('exact image prompt');
  await dependencies.video('exact video prompt [pan left]', image);
  assert.equal(calls.length, 3);
  assert.equal(axiosOptions.maxRedirects, 0);
  assert.equal(axiosOptions.maxBodyLength, 102400);
  assert.deepEqual(calls[0].data, { text: 'exact voice text', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.85 } });
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/pNInz6obbfIdGcilceT3');
  assert.equal(calls[1].url, 'https://fal.run/fal-ai/flux/dev');
  assert.deepEqual(calls[1].data, { prompt: 'exact image prompt', image_size: 'landscape_16_9' });
  assert.equal(calls[2].url, 'https://fal.run/fal-ai/minimax/video-01/image-to-video');
  assert.deepEqual(calls[2].data, { prompt: 'exact video prompt [pan left]', image_url: image });
  for (let index = 0; index < calls.length; index++) {
    assert.equal(calls[index].config.timeout, [90000, 180000, 600000][index]);
    assert.equal(calls[index].config.maxContentLength, index === 0 ? LIMITS.voiceBytes : LIMITS.providerJsonBytes);
    assert.equal(calls[index].config.signal, controller.signal);
  }
  assert.equal((await dependencies.selectComposition({ id: 'Main' })).browserExecutable, '/fixture/chromium');
  assert.equal((await dependencies.renderMedia({ codec: 'h264' })).browserExecutable, '/fixture/chromium');
  assert.equal((await dependencies.selectComposition({ id: 'Main' })).puppeteerInstance, browser);
  assert.equal(browsers, 1);
  const root = await temporary(t);
  const output = path.join(root, 'output.mp4');
  await fs.writeFile(output, 'fixture-upload');
  await dependencies.upload(output, { bucket: 'fixture-bucket', object: 'renders/fixture.mp4' });
  assert.equal(uploaded.toString(), 'fixture-upload');
  assert.equal(storageOptions.retryOptions.autoRetry, false);
  assert.equal(storageOptions.retryOptions.maxRetries, 0);
  assert.equal(streamOptions.resumable, false);
  assert.equal(streamOptions.timeout, 120000);
  assert.equal(streamOptions.validation, 'crc32c');
  await dependencies.close();
  await dependencies.close();
  assert.equal(closes, 1);
});

test('abort cancels the renderer and closes the same browser exactly once', async () => {
  let cancel = 0;
  let close = 0;
  const controller = new AbortController();
  const dependencies = createRuntimeDependencies({
    signal: controller.signal, environment: {}, axios: { create: () => ({}) },
    bundle: async () => {}, Storage: class {},
    renderer: {
      makeCancelSignal: () => ({ cancelSignal: () => {}, cancel: () => { cancel++; } }),
      openBrowser: async () => ({ close: async () => { close++; } }),
      selectComposition: async () => ({ id: 'Main' }),
    },
  });
  await dependencies.selectComposition({ id: 'Main' });
  controller.abort();
  await dependencies.close();
  assert.equal(cancel, 1); assert.equal(close, 1);
  await assert.rejects(dependencies.voice('no provider work'), { name: 'AbortError' });
});

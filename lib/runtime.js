'use strict';

const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { LIMITS, GenerationError } = require('./policy');

function providerUrl(value, stage) {
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new GenerationError('provider_response_invalid', stage); }
}

function createRuntimeDependencies(overrides = {}) {
  const axios = overrides.axios || require('axios');
  const bundle = overrides.bundle || require('@remotion/bundler').bundle;
  const renderer = overrides.renderer || require('@remotion/renderer');
  const Storage = overrides.Storage || require('@google-cloud/storage').Storage;
  const environment = overrides.environment || process.env;
  const signal = overrides.signal;
  const browserExecutable = environment.REMOTION_CHROMIUM_EXECUTABLE || environment.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  const storage = new Storage({ retryOptions: { autoRetry: false, maxRetries: 0, totalTimeout: 120 } });
  const http = axios.create({ maxRedirects: 0, maxBodyLength: LIMITS.bodyBytes });
  const renderCancellation = renderer.makeCancelSignal();
  let browserPromise;
  let browserClosing;
  const closeBrowser = () => {
    if (!browserPromise) return Promise.resolve();
    if (!browserClosing) browserClosing = browserPromise.then((browser) => browser.close({ silent: true }), () => {});
    return browserClosing;
  };
  const onAbort = () => {
    try { renderCancellation.cancel(); } catch { /* Parent still enforces native settlement. */ }
    // selectComposition has no cancelSignal. Closing the owned browser also
    // interrupts selection/launch; the parent independently checks descendants.
    void closeBrowser().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const getBrowser = async () => {
    signal?.throwIfAborted();
    if (!browserPromise) browserPromise = renderer.openBrowser('chrome', { browserExecutable, logLevel: 'error' });
    const browser = await browserPromise;
    signal?.throwIfAborted();
    return browser;
  };
  return {
    signal,
    bundle,
    async voice(text) {
      signal?.throwIfAborted();
      const response = await http.post('https://api.elevenlabs.io/v1/text-to-speech/pNInz6obbfIdGcilceT3',
        { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.85 } },
        { headers: { 'xi-api-key': environment.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer', timeout: LIMITS.stages.voice, maxContentLength: LIMITS.voiceBytes, signal });
      return Buffer.from(response.data);
    },
    async image(prompt) {
      signal?.throwIfAborted();
      const response = await http.post('https://fal.run/fal-ai/flux/dev',
        { prompt, image_size: 'landscape_16_9' },
        { headers: { Authorization: `Key ${environment.FAL_API_KEY}` }, timeout: LIMITS.stages.image,
          maxContentLength: LIMITS.providerJsonBytes, signal });
      return providerUrl(response.data?.images?.[0]?.url, 'image');
    },
    async video(prompt, imageUrl) {
      signal?.throwIfAborted();
      const response = await http.post('https://fal.run/fal-ai/minimax/video-01/image-to-video',
        { prompt, image_url: imageUrl },
        { headers: { Authorization: `Key ${environment.FAL_API_KEY}` }, timeout: LIMITS.stages.video,
          maxContentLength: LIMITS.providerJsonBytes, signal });
      return providerUrl(response.data?.video?.url, 'video');
    },
    selectComposition: async (options) => renderer.selectComposition({ ...options, browserExecutable,
      puppeteerInstance: await getBrowser(), logLevel: 'error' }),
    renderMedia: async (options) => renderer.renderMedia({ ...options, browserExecutable,
      puppeteerInstance: await getBrowser(), cancelSignal: renderCancellation.cancelSignal, logLevel: 'error' }),
    async upload(filePath, { bucket, object }) {
      signal?.throwIfAborted();
      const destination = storage.bucket(bucket).file(object).createWriteStream({
        resumable: false, validation: 'crc32c', timeout: LIMITS.stages.upload,
        metadata: { contentType: 'video/mp4' },
      });
      await pipeline(fs.createReadStream(filePath), destination, { signal });
    },
    async close() {
      signal?.removeEventListener('abort', onAbort);
      await closeBrowser();
    },
  };
}

module.exports = { createRuntimeDependencies, providerUrl };

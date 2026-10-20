'use strict';

// Forked only by the offline fixture, never present in the production target.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRuntimeDependencies } = require('../lib/runtime');
const { runGeneration } = require('../lib/generation');
const { GenerationError, safeError } = require('../lib/policy');

const controller = new AbortController();
let started = false;
let mode;
process.on('message', async (message) => {
  if (message.type === 'cancel') {
    if (mode !== 'forced-orphan') controller.abort(new GenerationError(message.code, message.stage));
    return;
  }
  if (started || message.type !== 'run') return;
  started = true;
  const job = message.job;
  mode = job.fixtureMode;
  const send = (value) => { if (process.connected) process.send(value, () => {}); };
  const finish = (value) => { if (process.connected) process.send(value, () => process.disconnect()); };
  try {
    const dependencies = createRuntimeDependencies(mode === 'forced-orphan' ? {} : { signal: controller.signal });
    if (mode === 'forced-orphan') {
      // Real Remotion-owned Chromium, deliberately refusing cooperative cancel.
      await dependencies.selectComposition({ serveUrl: path.join(job.bundleDir, 'site'), id: 'Main',
        inputProps: { scenes: [{ videoUrl: job.fixtureVideo, audioUrl: job.fixtureVideo, durationFrames: 150 }] } });
      const wrapper = spawn(process.execPath, [path.join(__dirname, 'native-orphan.js'), path.join(job.tempDir, 'orphan.json')],
        { detached: true, stdio: 'ignore' });
      wrapper.unref();
      send({ type: 'stage', stage: 'render' });
      return; // Parent must stop this leader, Chromium and reparented ffmpeg.
    }
    dependencies.voice = async () => fs.readFileSync(job.fixtureVoice);
    dependencies.image = async () => 'fixture-image';
    dependencies.video = async () => job.fixtureVideo;
    dependencies.upload = async () => { throw new Error('A cancelled fixture must not upload'); };
    const render = dependencies.renderMedia;
    let reported = false;
    dependencies.renderMedia = (options) => render({ ...options, concurrency: 1, onProgress: (progress) => {
      if (!reported && progress.renderedFrames > 0) {
        reported = true;
        fs.writeFileSync(path.join(job.tempDir, 'render-active.json'), JSON.stringify({ rendered_frames: progress.renderedFrames }));
      }
    } });
    const result = await runGeneration(job, dependencies, send);
    finish({ type: 'result', result });
  } catch (error) {
    // These paths use only synthetic local assets; no provider data/secrets.
    fs.writeFileSync(path.join(job.fixtureEvidence, mode + '.json'), JSON.stringify({ code: error.code,
      message: String(error.message).slice(0, 1600) }));
    const failure = safeError(error);
    finish({ type: 'failure', code: failure.code, stage: failure.stage });
  }
});

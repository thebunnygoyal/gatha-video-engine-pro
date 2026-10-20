'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runGeneration } = require('../lib/generation');
const { createMediaServer } = require('../lib/media');
const { createRuntimeDependencies } = require('../lib/runtime');
const { verifyNativeCancellation } = require('./runtime-cancel');

function command(binary, args, encoding = 'utf8') {
  const completed = spawnSync(binary, args, { encoding, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(completed.status, 0, `${binary} fixture failed: ${String(completed.stderr).slice(-1600)}`);
  return completed.stdout;
}

async function main() {
  assert.equal(process.platform, 'linux', 'Run in the pinned Linux image');
  const parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'gatha-render-fixture-'));
  const priorTemp = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]));
  let media;
  let safeToRemove = true;
  try {
    const voice = path.join(root, 'voice.mp3');
    const video = path.join(root, 'video.mp4');
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-q:a', '4', voice]);
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=30:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', video]);
    media = await createMediaServer([{ name: 'video.mp4', path: video, type: 'video/mp4' }]);
    const job = { jobId: 'non-billable-fixture', bucket: 'fixture-bucket',
      scenes: [{ text: 'Synthetic voice', prompt: 'Synthetic red frame' }],
      tempDir: path.join(root, 'job'), bundleDir: path.join(root, 'bundle'), bundleReady: false };
    await fs.mkdir(job.tempDir); await fs.mkdir(job.bundleDir);
    // Match the production worker: Remotion/Chromium temporary files belong to
    // this job before their modules are loaded.
    for (const key of Object.keys(priorTemp)) process.env[key] = job.tempDir;
    const dependencies = createRuntimeDependencies();
    const nativeBundle = dependencies.bundle;
    let bundles = 0;
    let providerMocks = 0;
    let uploads = 0;
    const stages = [];
    dependencies.bundle = async (options) => {
      bundles++;
      try { return await nativeBundle(options); }
      catch (error) { console.error('Synthetic bundle diagnostic:', String(error.message).slice(0, 2000)); throw error; }
    };
    dependencies.voice = async () => { providerMocks++; return fs.readFile(voice); };
    dependencies.image = async () => { providerMocks++; return 'fixture-image'; };
    dependencies.video = async () => { providerMocks++; return media.url('video.mp4'); };
    let uploaded;
    dependencies.upload = async (file, destination) => {
      uploads++;
      uploaded = { file, destination, bytes: (await fs.stat(file)).size, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') };
    };
    const nativeSelect = dependencies.selectComposition;
    const nativeRender = dependencies.renderMedia;
    for (const [name, fn] of [['selectComposition', nativeSelect], ['renderMedia', nativeRender]]) {
      dependencies[name] = async (options) => {
        try { return await fn(options); }
        catch (error) { console.error(`Synthetic ${name} diagnostic:`, String(error.message).slice(0, 2000)); throw error; }
      };
    }
    const result = await runGeneration(job, dependencies, (message) => {
      if (message.type === 'stage') stages.push({ stage: message.stage, time: new Date().toISOString() });
    });
    assert.equal(providerMocks, 3); assert.equal(uploads, 1); assert.equal(bundles, 1);
    assert.equal(result.gcs_uri, 'gs://fixture-bucket/renders/non-billable-fixture.mp4');
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', uploaded.file]));
    const picture = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(picture.width, 1920); assert.equal(picture.height, 1080);
    assert.equal(picture.r_frame_rate, '30/1'); assert.equal(Number(picture.nb_frames), 150);
    assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'));
    assert.ok(Number(probe.format.duration) >= 4.9 && Number(probe.format.duration) <= 5.2);
    const pcm = command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', uploaded.file, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '8000', 'pipe:1'], null);
    let squares = 0;
    for (let index = 0; index + 4 <= pcm.length; index += 4) squares += pcm.readFloatLE(index) ** 2;
    const rms = Math.sqrt(squares / (pcm.length / 4));
    assert.ok(Number.isFinite(rms) && rms > 0.0001, 'Synthetic speech must be audible in the rendered audio track');
    console.log(JSON.stringify({ fixture: 'real-remotion-loopback-audio', passed: true, paid_provider_calls: 0,
      gcs_network_uploads: 0, mocked_provider_steps: providerMocks, mocked_uploads: uploads, bundle_calls: bundles,
      output_bytes: uploaded.bytes, output_sha256: uploaded.sha256, audio_rms: rms, probe, stages }));
    try {
      await verifyNativeCancellation({ root, voice, videoUrl: media.url('video.mp4'), bundleDirectory: job.bundleDir });
    } catch (error) {
      if (error.unsafeToCleanup) safeToRemove = false;
      throw error;
    }
  } finally {
    if (media) await media.close();
    for (const [key, value] of Object.entries(priorTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('gatha-render-fixture-'));
    if (safeToRemove) await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error('Non-billable render fixture failed:', error.message); process.exitCode = 1; });

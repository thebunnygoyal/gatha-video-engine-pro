'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createMediaServer } = require('./media');
const { LIMITS, GenerationError, safeError } = require('./policy');

// Dependencies are explicit so the same pipeline can be checked without paid calls.
async function runGeneration(job, dependencies, report = () => {}) {
  let stage = 'starting';
  let media;
  const setStage = (next) => {
    if (next !== 'finalize') dependencies.signal?.throwIfAborted();
    stage = next; report({ type: 'stage', stage: next });
  };
  const serveUrl = path.join(job.bundleDir, 'site');
  try {
    setStage('bundle');
    if (!job.bundleReady) {
      await dependencies.bundle({ entryPoint: path.resolve(__dirname, '../src/index.ts'), outDir: serveUrl });
    }
    const bundleIndex = await fs.stat(path.join(serveUrl, 'index.html'));
    if (!bundleIndex.isFile()) throw new GenerationError('bundle_failed', stage);
    if (!job.bundleReady) report({ type: 'bundle_ready' });

    const composed = [];
    const audioFiles = [];
    let totalFrames = 0;
    for (let index = 0; index < job.scenes.length; index++) {
      const scene = job.scenes[index];
      setStage('voice');
      const audio = await dependencies.voice(scene.text);
      if (!Buffer.isBuffer(audio) || !audio.length || audio.length > LIMITS.voiceBytes) {
        throw new GenerationError('provider_response_invalid', stage);
      }
      const audioName = `scene-${index}.mp3`;
      const audioPath = path.join(job.tempDir, audioName);
      await fs.writeFile(audioPath, audio, { flag: 'wx' });
      audioFiles.push({ name: audioName, path: audioPath, type: 'audio/mpeg' });

      setStage('image');
      const imageUrl = await dependencies.image(scene.prompt);
      setStage('video');
      const prompt = scene.camera_move ? `${scene.prompt} [${scene.camera_move}]` : scene.prompt;
      const videoUrl = await dependencies.video(prompt, imageUrl);
      composed.push({ videoUrl, audioName, durationFrames: 150 });
      totalFrames += index === 0 ? 150 : 135;
    }

    setStage('render');
    media = await createMediaServer(audioFiles);
    const inputProps = { scenes: composed.map(({ audioName, ...scene }) => ({ ...scene, audioUrl: media.url(audioName) })) };
    const composition = await dependencies.selectComposition({ serveUrl, id: 'Main', inputProps });
    composition.durationInFrames = totalFrames;
    const outputPath = path.join(job.tempDir, 'output.mp4');
    await dependencies.renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: outputPath, inputProps });
    const output = await fs.stat(outputPath);
    if (!output.isFile() || !output.size) throw new GenerationError('render_failed', stage);
    if (output.size > LIMITS.outputBytes) throw new GenerationError('output_too_large', stage);

    setStage('upload');
    const object = `renders/${job.jobId}.mp4`;
    await dependencies.upload(outputPath, { bucket: job.bucket, object });
    return { bucket: job.bucket, object, gcs_uri: `gs://${job.bucket}/${object}` };
  } catch (error) {
    if (dependencies.signal?.aborted) throw dependencies.signal.reason;
    throw safeError(error, stage);
  } finally {
    setStage('finalize');
    try { await dependencies.close?.(); }
    finally { if (media) await media.close(); }
  }
}

module.exports = { runGeneration };

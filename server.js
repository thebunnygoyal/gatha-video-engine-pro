const express = require('express');
const { bundle } = require('@remotion/bundler');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const axios = require('axios');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const FAL_KEY = process.env.FAL_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const BUCKET = process.env.GCS_BUCKET_NAME || "mcp-box-atomic-backups";

app.post('/generate', async (req, res) => {
  const { scenes } = req.body; 
  const jobId = uuidv4();
  res.json({ job_id: jobId, status: "processing", message: "Flux I2V -> MiniMax -> Remotion Pipeline Started" });

  (async () => {
    try {
      console.log(`[${jobId}] Starting pro generation...`);
      let composedScenes = [];
      let totalFrames = 0;

      for (let i = 0; i < scenes.length; i++) {
         const s = scenes[i];
         console.log(`[${jobId}] Processing Scene ${i+1}`);
         
         // 1. Voice (ElevenLabs)
         const elevenRes = await axios.post('https://api.elevenlabs.io/v1/text-to-speech/pNInz6obbfIdGcilceT3',
           { text: s.text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.85 } },
           { headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
         );
         const fs = require('fs');
         const audioPath = `/tmp/${jobId}_scene_${i}.mp3`;
         fs.writeFileSync(audioPath, elevenRes.data);
         const durationFrames = 150; // In prod, parse audio length
         
         // 2. Keyframe (FLUX.1)
         const fluxRes = await axios.post('https://fal.run/fal-ai/flux/dev',
           { prompt: s.prompt, image_size: "landscape_16_9" },
           { headers: { Authorization: `Key ${FAL_KEY}` } }
         );
         const keyframeUrl = fluxRes.data.images[0].url;

         // 3. Animate (MiniMax Video-01 Image-to-Video)
         const fullPrompt = s.camera_move ? `${s.prompt} [${s.camera_move}]` : s.prompt;
         const falRes = await axios.post('https://fal.run/fal-ai/minimax/video-01/image-to-video',
           { prompt: fullPrompt, image_url: keyframeUrl },
           { headers: { Authorization: `Key ${FAL_KEY}` } }
         );
         
         composedScenes.push({ 
           videoUrl: falRes.data.video.url, 
           audioUrl: `file://${audioPath}`, 
           durationFrames 
         });
         
         // Account for transition overlap (15 frames)
         totalFrames += (i === 0) ? durationFrames : (durationFrames - 15);
      }

      console.log(`[${jobId}] Bundling Remotion...`);
      const bundled = await bundle({ entryPoint: path.resolve('./src/index.ts') });
      const composition = await selectComposition({
        serveUrl: bundled, id: 'Main', inputProps: { scenes: composedScenes }
      });
      composition.durationInFrames = totalFrames;

      const outPath = `/tmp/${jobId}.mp4`;
      console.log(`[${jobId}] Rendering composition...`);
      await renderMedia({
        composition, serveUrl: bundled, codec: 'h264', outputLocation: outPath, inputProps: { scenes: composedScenes }
      });

      console.log(`[${jobId}] Uploading to GCS...`);
      const storage = new Storage();
      const dest = `renders/${jobId}.mp4`;
      await storage.bucket(BUCKET).upload(outPath, { destination: dest });
      console.log(`[${jobId}] Finished: gs://${BUCKET}/${dest}`);
    } catch (e) {
      console.error(`[${jobId}] Error:`, e.response?.data || e.message);
    }
  })();
});

app.get('/health', (req, res) => res.send('OK'));
app.listen(process.env.PORT || 8080, () => console.log("Engine active on 8080"));

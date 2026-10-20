'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Test-only child, excluded from the production image.
process.on('message', ({ type, job }) => {
  if (type !== 'run') return;
  const finish = (message) => process.send(message, () => process.disconnect());
  const mode = job.scenes[0].text;
  process.send({ type: 'stage', stage: 'bundle' });
  process.send({ type: 'bundle_ready' });
  if (mode === 'result') {
    fs.writeFileSync(path.join(job.tempDir, 'pids.json'), JSON.stringify({ leader: process.pid }));
    finish({ type: 'result', result: { bucket: job.bucket, object: `renders/${job.jobId}.mp4`, gcs_uri: `gs://${job.bucket}/renders/${job.jobId}.mp4` } });
  } else if (mode === 'failure') {
    finish({ type: 'failure', code: 'provider_failed', stage: 'voice', private: 'must never surface' });
  } else {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    fs.writeFileSync(path.join(job.tempDir, 'pids.json'), JSON.stringify({ leader: process.pid, child: child.pid }));
    process.send({ type: 'stage', stage: 'voice' });
  }
});

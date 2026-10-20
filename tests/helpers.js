'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function temporary(t, prefix = 'gatha-fixture-') {
  const parent = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith(prefix)) {
      throw new Error('Refusing to clean an unowned fixture directory');
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const body = { scenes: [{ text: 'A fixture voice.', prompt: 'A red landscape.', camera_move: 'pan left' }] };
function resultFor(job) {
  return { bucket: job.bucket, object: `renders/${job.jobId}.mp4`, gcs_uri: `gs://${job.bucket}/renders/${job.jobId}.mp4` };
}

module.exports = { temporary, deferred, body, resultFor };

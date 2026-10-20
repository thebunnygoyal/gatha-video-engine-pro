'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { GenerationOwner } = require('../lib/owner');
const { runWorker } = require('../lib/worker-runner');
const { readStat, executing } = require('../lib/process-ledger');
const { GenerationError } = require('../lib/policy');

function nativeInventory() {
  const native = new Map();
  for (const name of fs.readdirSync('/proc').filter((value) => /^\d+$/.test(value))) {
    const record = readStat(Number(name));
    if (!executing(record)) continue;
    let executable;
    try { executable = path.basename(fs.readlinkSync('/proc/' + record.pid + '/exe')); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    if (/chrom(e|ium)|ffmpeg/i.test(executable)) native.set(record.pid + ':' + record.started, { ...record, executable });
  }
  return native;
}

function newNativeProcesses(baseline) {
  return [...nativeInventory().entries()].filter(([key]) => !baseline.has(key)).map(([, value]) => value);
}

async function verifyNativeCancellation({ root, voice, videoUrl, bundleDirectory }) {
  const tempRoot = path.join(root, 'cancellation');
  await fsp.mkdir(tempRoot);
  let current;
  const owner = new GenerationOwner({ tempRoot, bucket: 'fixture-bucket', overallMs: 120_000,
    worker: (job, controls) => {
      current.job = job;
      return runWorker({ ...job, fixtureMode: current.mode, fixtureVoice: voice,
        fixtureVideo: videoUrl, fixtureEvidence: tempRoot }, { ...controls,
        workerPath: path.join(__dirname, 'native-cancel-worker.js'),
        onProcesses: (snapshot) => {
          // Independent native inventory also catches an accidentally unmarked
          // browser/encoder omitted by the production ownership ledger.
          const independent = newNativeProcesses(current.baseline);
          for (const record of independent) current.independent.set(record.pid + ':' + record.started, record);
          if (current.controller.signal.aborted && snapshot.live.length === 0) {
            assert.equal(independent.length, 0, 'Independent inventory must be empty before owner cleanup');
          }
          const native = [];
          for (const record of snapshot.live) {
            let executable;
            try { executable = path.basename(fs.readlinkSync('/proc/' + record.pid + '/exe')); }
            catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
            if (/chrom(e|ium)|ffmpeg/i.test(executable)) {
              const entry = { ...record, executable };
              native.push(entry);
              current.observed.set(record.pid + ':' + record.started, entry);
            }
          }
          if (native.length) assert.equal(fs.statSync(job.tempDir).isDirectory(), true, 'Keep owned files while native processes run');
          if (current.controller.signal.aborted) return;
          const browser = native.find((record) => /chrom(e|ium)/i.test(record.executable));
          const encoder = native.find((record) => /ffmpeg/i.test(record.executable));
          if (!browser || !encoder) return;
          if (current.mode === 'cooperative-render') {
            if (!fs.existsSync(path.join(job.tempDir, 'render-active.json'))) return;
          } else {
            const recordPath = path.join(job.tempDir, 'orphan.json');
            if (!fs.existsSync(recordPath)) return;
            const orphan = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
            if (encoder.pid !== orphan.native || encoder.parent === orphan.wrapper) return;
            current.orphan = { ...orphan, reparented_to: encoder.parent };
          }
          current.atCancellation = native;
          current.independentAtCancellation = independent;
          current.controller.abort(new GenerationError('disconnected'));
        },
      });
    } });
  owner.bundle = { directory: await owner.allocate('gatha-bundle-'), ready: true };
  await fsp.cp(path.join(bundleDirectory, 'site'), path.join(owner.bundle.directory, 'site'), { recursive: true });
  // A separate native process must survive job cancellation.
  const foreign = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi',
    '-i', 'color=c=black:s=160x90:r=1', '-f', 'null', '-'], { detached: true, stdio: 'ignore' });
  const foreignClosed = new Promise((resolve) => foreign.once('close', resolve));
  const receipts = [];
  try {
    await new Promise((resolve, reject) => { foreign.once('spawn', resolve); foreign.once('error', reject); });
    for (const mode of ['cooperative-render', 'forced-orphan']) {
      current = { mode, controller: new AbortController(), observed: new Map(), independent: new Map(),
        baseline: nativeInventory(), atCancellation: null };
      const start = Date.now();
      await assert.rejects(owner.generate({ scenes: [{ text: 'Synthetic voice', prompt: 'Synthetic video' }] },
        { signal: current.controller.signal }), (error) => error.code === 'disconnected');
      assert.ok(current.atCancellation, 'Cancel only after real Chromium and ffmpeg are executing');
      for (const record of current.observed.values()) {
        const now = readStat(record.pid);
        assert.ok(!now || now.started !== record.started || !executing(now), 'No owned native process can execute after settlement');
      }
      assert.equal(owner.active, null);
      assert.equal(owner.available, true);
      assert.equal(newNativeProcesses(current.baseline).length, 0, 'Independent native inventory must stay empty after settlement');
      await assert.rejects(fsp.stat(current.job.tempDir), { code: 'ENOENT' });
      assert.ok(executing(readStat(foreign.pid)), 'Cancellation must preserve a foreign native process');
      receipts.push({ mode, passed: true, elapsed_ms: Date.now() - start,
        native_processes_at_cancellation: current.atCancellation,
        independently_observed_at_cancellation: current.independentAtCancellation,
        observed_native_process_count: current.observed.size,
        independently_observed_native_process_count: current.independent.size,
        ...(current.orphan ? { orphan: current.orphan } : {}),
        owned_directory_removed_after_settlement: true, foreign_process_preserved: true });
    }
    console.log(JSON.stringify({ fixture: 'real-linux-native-cancellation', paid_provider_calls: 0,
      gcs_network_uploads: 0, cases: receipts }));
  } catch (error) {
    const diagnostic = current && path.join(tempRoot, current.mode + '.json');
    if (diagnostic && fs.existsSync(diagnostic)) console.error('Synthetic cancellation diagnostic:', fs.readFileSync(diagnostic, 'utf8'));
    if (owner.processesUnsettled) error.unsafeToCleanup = true;
    throw error;
  } finally {
    foreign.kill('SIGKILL');
    await foreignClosed;
    if (!owner.processesUnsettled) await owner.shutdown();
  }
}

module.exports = { verifyNativeCancellation };

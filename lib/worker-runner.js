'use strict';

const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { LIMITS, GenerationError } = require('./policy');
const { ProcessLedger, OWNER_KEY } = require('./process-ledger');

// Remotion starts Chromium in a separate process group. Child.close alone is
// insufficient: verify every marked/tracked Linux descendant has stopped too.
function runWorker(job, { signal, onBundleReady = () => {}, stageLimits = LIMITS.stages,
  workerPath = path.join(__dirname, 'worker.js'), onProcesses = () => {},
  cancellationGraceMs = 1000, settlementMs = 6000 } = {}) {
  if (process.platform !== 'linux') return Promise.reject(new GenerationError('worker_failed', 'starting'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const marker = crypto.randomBytes(24).toString('hex');
    const child = fork(workerPath, [], {
      cwd: path.resolve(__dirname, '..'), detached: true, silent: true,
      env: { ...process.env, TMPDIR: job.tempDir, TMP: job.tempDir, TEMP: job.tempDir, [OWNER_KEY]: marker },
    });
    child.stdout?.resume(); // Never retain dependency/provider response logs.
    child.stderr?.resume();
    const ledger = child.pid ? new ProcessLedger(marker, child.pid) : null;
    let stage = 'starting';
    let stageTimer;
    let outcome;
    let finishingAt;
    let childClosed = false;
    let completed = false;
    let inspectionFailed = !ledger;
    let emptySamples = 0;

    function requestFinish(next) {
      if (outcome || completed) return;
      outcome = next;
      finishingAt = Date.now();
      clearTimeout(stageTimer);
      if (next.error && child.connected) child.send({ type: 'cancel', code: next.error.code, stage: next.error.stage }, () => {});
    }
    function setStage(next) {
      stage = next;
      clearTimeout(stageTimer);
      stageTimer = setTimeout(() => requestFinish({ error: new GenerationError('stage_timeout', stage) }), stageLimits[stage]);
    }
    function onAbort() {
      const reason = signal.reason;
      requestFinish({ error: reason instanceof GenerationError ? new GenerationError(reason.code, reason.stage || stage) : new GenerationError('disconnected', stage) });
    }
    function finish(error) {
      completed = true;
      clearTimeout(stageTimer);
      clearInterval(monitor);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        if (outcome?.result) error.result = outcome.result;
        reject(error);
      } else if (outcome?.result) resolve(outcome.result);
      else reject(outcome?.error || new GenerationError('worker_failed', stage));
    }
    function inspect() {
      if (completed) return;
      let snapshot;
      try {
        snapshot = ledger?.sample();
        if (snapshot) onProcesses(snapshot);
      } catch {
        inspectionFailed = true;
        requestFinish({ error: new GenerationError('cancellation_failed', 'finalize') });
      }
      if (!outcome) return;
      const elapsed = Date.now() - finishingAt;
      if (elapsed >= cancellationGraceMs) {
        try {
          // Freeze known owners before killing, then rescan for children that
          // were forked/reparented immediately before the freeze. Repeat on the
          // next tick; detached groups are included by their inherited marker.
          if (snapshot) {
            ledger.signal(snapshot.live, 'SIGSTOP');
            snapshot = ledger.sample();
            ledger.signal(snapshot.live, 'SIGKILL');
          } else if (ledger) ledger.signal([...ledger.records.values()], 'SIGKILL');
          if (!childClosed) child.kill('SIGKILL');
        } catch { inspectionFailed = true; }
      }
      if (childClosed && snapshot && snapshot.live.length === 0 && !inspectionFailed) {
        if (++emptySamples >= 2) { finish(); return; }
      } else emptySamples = 0;
      if (elapsed >= settlementMs) {
        // Do not delete files or admit another job when process cessation cannot
        // be established. The owner retains all paths until instance recovery.
        finish(new GenerationError('cancellation_failed', 'finalize'));
      }
    }
    const monitor = setInterval(inspect, 100);
    signal?.addEventListener('abort', onAbort, { once: true });
    setStage('starting');
    child.once('spawn', () => {
      inspect();
      if (!ledger?.records.has(child.pid)) {
        inspectionFailed = true;
        requestFinish({ error: new GenerationError('cancellation_failed', 'finalize') });
      }
      if (signal?.aborted) onAbort();
      if (!outcome) child.send({ type: 'run', job }, (error) => {
        if (error) requestFinish({ error: new GenerationError('worker_failed', stage) });
      });
    });
    child.on('message', (message) => {
      if (completed || outcome) return;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        requestFinish({ error: new GenerationError('worker_failed', stage) }); return;
      }
      if (message.type === 'stage' && Object.hasOwn(stageLimits, message.stage)) setStage(message.stage);
      else if (message.type === 'bundle_ready' && stage === 'bundle') onBundleReady();
      else if (message.type === 'result') {
        const expected = { bucket: job.bucket, object: 'renders/' + job.jobId + '.mp4',
          gcs_uri: 'gs://' + job.bucket + '/renders/' + job.jobId + '.mp4' };
        if (message.result?.bucket !== expected.bucket || message.result?.object !== expected.object || message.result?.gcs_uri !== expected.gcs_uri) {
          requestFinish({ error: new GenerationError('worker_failed', stage) }); return;
        }
        requestFinish({ result: expected });
      } else if (message.type === 'failure') requestFinish({ error: new GenerationError(message.code, message.stage) });
      else requestFinish({ error: new GenerationError('worker_failed', stage) });
    });
    child.once('error', () => requestFinish({ error: new GenerationError('worker_failed', stage) }));
    child.once('close', () => {
      childClosed = true;
      if (!outcome) requestFinish({ error: new GenerationError('worker_failed', stage) });
      inspect();
    });
  });
}

module.exports = { runWorker };

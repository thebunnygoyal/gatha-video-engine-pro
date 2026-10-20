'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LIMITS, GenerationError, validateScenes, safeError } = require('./policy');
const { runWorker } = require('./worker-runner');

class GenerationOwner {
  constructor({ bucket, isConfigured = () => true, worker = runWorker,
    tempRoot = os.tmpdir(), overallMs = LIMITS.overallMs, stageLimits = LIMITS.stages,
    removeDirectory = (directory) => fs.rm(directory, { recursive: true, force: true }), logger = () => {} } = {}) {
    this.bucket = bucket || 'mcp-box-atomic-backups';
    this.isConfigured = isConfigured;
    this.worker = worker;
    this.tempRoot = path.resolve(tempRoot);
    this.overallMs = overallMs;
    this.stageLimits = stageLimits;
    this.removeDirectory = removeDirectory;
    this.logger = logger;
    this.active = null;
    this.bundle = null;
    this.ownedDirectories = new Set();
    this.cleanupBlocked = false;
    this.processesUnsettled = false;
    this.stopping = false;
  }
  get available() { return !this.stopping && !this.cleanupBlocked; }
  async allocate(prefix) {
    const directory = await fs.mkdtemp(path.join(this.tempRoot, prefix));
    this.ownedDirectories.add(path.resolve(directory));
    return directory;
  }
  async removeOwned(directory) {
    if (!directory) return;
    const absolute = path.resolve(directory);
    // A matching prefix alone never grants removal authority.
    if (!this.ownedDirectories.has(absolute) || path.dirname(absolute) !== this.tempRoot || absolute === this.tempRoot) {
      throw new GenerationError('cleanup_failed', 'finalize');
    }
    try { await this.removeDirectory(absolute); this.ownedDirectories.delete(absolute); }
    catch { this.cleanupBlocked = true; throw new GenerationError('cleanup_failed', 'finalize'); }
  }
  generate(body, { signal } = {}) {
    let scenes;
    try {
      scenes = validateScenes(body);
      if (!this.available) throw new GenerationError('unavailable');
      if (!this.isConfigured()) throw new GenerationError('not_configured');
      if (this.active) throw new GenerationError('busy');
      if (signal?.aborted) throw new GenerationError('disconnected');
    } catch (error) { return Promise.reject(error); }
    const job = { jobId: crypto.randomUUID(), controller: new AbortController(), tempDir: null, result: null };
    this.active = job; // Admission is synchronous, before any filesystem/provider await.
    job.done = this.runOwned(job, scenes, signal);
    return job.done;
  }
  async runOwned(job, scenes, signal) {
    let error;
    const forwardAbort = () => job.controller.abort(signal.reason instanceof GenerationError ? signal.reason : new GenerationError('disconnected'));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => job.controller.abort(new GenerationError('overall_timeout')), this.overallMs);
    try {
      if (signal?.aborted) forwardAbort();
      job.controller.signal.throwIfAborted();
      job.tempDir = await this.allocate('gatha-job-');
      job.controller.signal.throwIfAborted();
      if (!this.bundle) this.bundle = { directory: await this.allocate('gatha-bundle-'), ready: false };
      job.controller.signal.throwIfAborted();
      const bundle = this.bundle;
      job.result = await this.worker({ jobId: job.jobId, scenes, tempDir: job.tempDir,
        bundleDir: bundle.directory, bundleReady: bundle.ready, bucket: this.bucket }, {
        signal: job.controller.signal, stageLimits: this.stageLimits,
        onBundleReady: () => { if (!job.controller.signal.aborted && this.bundle === bundle) bundle.ready = true; },
      });
      job.controller.signal.throwIfAborted();
    } catch (failure) {
      error = safeError(failure);
      if (error.result) job.result = error.result;
      if (error.code === 'cancellation_failed') {
        this.processesUnsettled = true;
        this.cleanupBlocked = true;
      }
      if (error.code === 'bundle_failed' && this.bundle) this.bundle.ready = false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      // Never remove paths while native process shutdown is unconfirmed.
      const failures = [];
      if (!this.processesUnsettled && this.bundle && !this.bundle.ready) {
        try { await this.removeOwned(this.bundle.directory); this.bundle = null; }
        catch (failure) { failures.push(failure); }
      }
      if (!this.processesUnsettled) {
        try { await this.removeOwned(job.tempDir); }
        catch (failure) { failures.push(failure); }
      }
      if (failures.length) error = failures[0];
      this.active = null;
    }
    if (error) {
      error.jobId = job.jobId;
      if (job.result) error.result = job.result;
      this.logger({ job_id: job.jobId, event: 'failed', code: error.code, stage: error.stage });
      throw error;
    }
    this.logger({ job_id: job.jobId, event: 'completed' });
    return { job_id: job.jobId, status: 'completed', result: job.result };
  }
  async shutdown() {
    this.stopping = true;
    if (this.active) {
      this.active.controller.abort(new GenerationError('shutting_down'));
      await this.active.done.catch(() => {});
    }
    if (this.processesUnsettled) throw new GenerationError('cancellation_failed', 'finalize');
    let failed = false;
    for (const directory of [...this.ownedDirectories]) {
      try { await this.removeOwned(directory); } catch { failed = true; }
    }
    this.bundle = null;
    if (failed) throw new GenerationError('cleanup_failed', 'finalize');
  }
}

module.exports = { GenerationOwner };

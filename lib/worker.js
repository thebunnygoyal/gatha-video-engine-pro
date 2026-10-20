'use strict';

const { runGeneration } = require('./generation');
const { createRuntimeDependencies } = require('./runtime');
const { safeError, GenerationError } = require('./policy');

if (require.main === module) {
  let started = false;
  const controller = new AbortController();
  process.on('disconnect', () => controller.abort(new GenerationError('shutting_down')));
  process.on('message', async (message) => {
    if (message?.type === 'cancel') {
      controller.abort(new GenerationError(message.code, message.stage));
      return;
    }
    if (started || message?.type !== 'run') return;
    started = true;
    const send = (value) => { if (process.connected) process.send(value, () => {}); };
    const finish = (value) => {
      if (process.connected) process.send(value, () => { if (process.connected) process.disconnect(); });
    };
    try {
      const result = await runGeneration(message.job, createRuntimeDependencies({ signal: controller.signal }), send);
      finish({ type: 'result', result });
    } catch (error) {
      const failure = safeError(error);
      finish({ type: 'failure', code: failure.code, stage: failure.stage });
    }
    // Parent waits for this leader AND all marked/tracked native descendants.
  });
}

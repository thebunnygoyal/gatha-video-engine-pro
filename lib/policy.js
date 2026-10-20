'use strict';

const LIMITS = Object.freeze({
  bodyBytes: 100 * 1024,
  scenes: 12,
  textCharacters: 4000,
  promptCharacters: 4000,
  cameraCharacters: 256,
  voiceBytes: 20 * 1024 * 1024,
  providerJsonBytes: 1024 * 1024,
  outputBytes: 512 * 1024 * 1024,
  overallMs: 3300 * 1000,
  stages: Object.freeze({ starting: 30_000, bundle: 180_000, voice: 90_000,
    image: 180_000, video: 600_000, render: 900_000, upload: 120_000, finalize: 10_000 }),
});

const ERRORS = Object.freeze({
  invalid_request: [400, 'Provide 1-12 scenes with valid text, prompt and optional camera_move.'],
  body_too_large: [413, 'The JSON request exceeds 100 KiB.'],
  busy: [503, 'A generation is already running. This request was not accepted.'],
  unavailable: [503, 'Generation is unavailable. This request was not accepted.'],
  not_configured: [503, 'Generation providers are not configured. This request was not accepted.'],
  overall_timeout: [504, 'The generation deadline was reached. Local processing stopped; a remote provider may still complete.'],
  stage_timeout: [504, 'A generation stage exceeded its deadline. Local processing stopped; a remote provider may still complete.'],
  disconnected: [499, 'The requesting client disconnected. Local processing stopped; a remote provider may still complete.'],
  shutting_down: [503, 'The instance is shutting down. Local processing stopped; a remote provider may still complete.'],
  provider_failed: [502, 'A generation provider failed. No paid request was retried.'],
  provider_response_invalid: [502, 'A generation provider returned an invalid or oversized response.'],
  bundle_failed: [500, 'The video bundle could not be prepared.'],
  render_failed: [500, 'The video could not be rendered.'],
  output_too_large: [502, 'The rendered output exceeds the supported size.'],
  upload_failed: [502, 'The output upload failed or its result is uncertain.'],
  worker_failed: [500, 'The generation worker failed.'],
  cancellation_failed: [500, 'Local process shutdown could not be confirmed. Further generation is blocked; a remote provider may still complete.'],
  cleanup_failed: [500, 'Owned temporary files could not be removed. Further generation is blocked.'],
});

class GenerationError extends Error {
  constructor(code, stage) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'worker_failed';
    super(ERRORS[safeCode][1]);
    this.name = 'GenerationError';
    this.code = safeCode;
    this.status = ERRORS[safeCode][0];
    this.stage = Object.hasOwn(LIMITS.stages, stage) ? stage : undefined;
  }
}

function validateScenes(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Array.isArray(body.scenes) || body.scenes.length < 1 || body.scenes.length > LIMITS.scenes) {
    throw new GenerationError('invalid_request');
  }
  const validText = (text, max, required) => typeof text === 'string' &&
    Array.from(text).length <= max && (!required || text.trim().length > 0);
  return body.scenes.map((scene) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene) ||
        !validText(scene.text, LIMITS.textCharacters, true) ||
        !validText(scene.prompt, LIMITS.promptCharacters, true) ||
        (scene.camera_move !== undefined && !validText(scene.camera_move, LIMITS.cameraCharacters, false))) {
      throw new GenerationError('invalid_request');
    }
    return { text: scene.text, prompt: scene.prompt,
      ...(scene.camera_move !== undefined ? { camera_move: scene.camera_move } : {}) };
  });
}

function safeError(error, stage) {
  if (error instanceof GenerationError) return error;
  const code = stage === 'bundle' ? 'bundle_failed' : stage === 'render' ? 'render_failed'
    : stage === 'upload' ? 'upload_failed' : ['voice', 'image', 'video'].includes(stage)
      ? 'provider_failed' : 'worker_failed';
  return new GenerationError(code, stage);
}

function errorBody(error, jobId, result) {
  const failure = safeError(error);
  return { ...(jobId ? { job_id: jobId } : {}), status: 'failed',
    error: { code: failure.code, message: failure.message,
      ...(failure.stage ? { stage: failure.stage } : {}), retryable: false },
    ...(result ? { result } : {}) };
}

module.exports = { LIMITS, GenerationError, validateScenes, safeError, errorBody };

'use strict';

const http = require('node:http');
const { GenerationOwner } = require('./lib/owner');
const { LIMITS, GenerationError, safeError, errorBody } = require('./lib/policy');

function createApp({ owner, express = require('express') } = {}) {
  if (!owner) throw new Error('Generation owner is required');
  const app = express();
  app.disable('x-powered-by');
  // Cloud Run IAM authenticates invocation before this application. Never trust
  // caller-supplied identity headers as an application authentication decision.
  app.use(express.json({ limit: LIMITS.bodyBytes, strict: true }));
  app.get('/health', (_req, res) => {
    res.status(owner.available ? 200 : 503).type('text/plain').send(owner.available ? 'OK' : 'UNAVAILABLE');
  });
  app.post('/generate', async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(new GenerationError('disconnected')); };
    res.once('close', onClose);
    try {
      const result = await owner.generate(req.body, { signal: controller.signal });
      if (!res.destroyed) res.status(200).json(result);
    } catch (error) {
      const failure = safeError(error);
      if (!res.destroyed) {
        if (failure.code === 'busy') res.set('Retry-After', '10');
        res.status(failure.status).json(errorBody(failure, failure.jobId, failure.result));
      }
    } finally { res.removeListener('close', onClose); }
  });
  app.use((error, _req, res, _next) => {
    const failure = new GenerationError(error?.type === 'entity.too.large' ? 'body_too_large' : 'invalid_request');
    if (!res.headersSent) res.status(failure.status).json(errorBody(failure));
    else res.destroy();
  });
  return app;
}

function start() {
  const owner = new GenerationOwner({
    bucket: process.env.GCS_BUCKET_NAME || 'mcp-box-atomic-backups',
    isConfigured: () => Boolean(process.env.FAL_API_KEY?.trim() && process.env.ELEVENLABS_API_KEY?.trim()),
    logger: (entry) => console.log(JSON.stringify(entry)),
  });
  const server = http.createServer(createApp({ owner }));
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000; // Body receipt only; the response has its own generation deadline.
  server.listen(process.env.PORT || 8080, () => console.log('Video engine ready'));
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    try { await owner.shutdown(); process.exitCode = 0; }
    catch { console.error('Owned temporary file cleanup failed during shutdown'); process.exitCode = 1; }
    server.closeAllConnections();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { server, owner, shutdown };
}

if (require.main === module) start();
module.exports = { createApp, start };

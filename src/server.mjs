import Hapi from '@hapi/hapi';

/**
 * Creates and starts the consumer control server.
 * Exposes endpoints for pause/resume/cancel and health checks.
 *
 * @param {number} port - Port to listen on
 * @param {object} batchRunner - Batch runner instance with control methods
 * @returns {Promise<string>} The control URL (e.g. "http://localhost:9100")
 */
export async function startControlServer(port, batchRunner) {
  const server = Hapi.server({
    port,
    host: '0.0.0.0',
    routes: { cors: { origin: ['*'] } },
  });

  server.route({
    method: 'GET',
    path: '/health',
    handler: () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  });

  server.route({
    method: 'POST',
    path: '/jobs/{job_id}/pause',
    handler: (request) => {
      const jobId = Number(request.params.job_id);
      batchRunner.setPaused(jobId);
      return { ok: true };
    },
  });

  server.route({
    method: 'POST',
    path: '/jobs/{job_id}/resume',
    handler: (request) => {
      const jobId = Number(request.params.job_id);
      batchRunner.setResumed(jobId);
      return { ok: true };
    },
  });

  server.route({
    method: 'POST',
    path: '/jobs/{job_id}/cancel',
    handler: (request) => {
      const jobId = Number(request.params.job_id);
      batchRunner.setCancelled(jobId);
      return { ok: true };
    },
  });

  await server.start();
  const controlUrl = `http://localhost:${server.info.port}`;
  console.log(`control server listening on ${controlUrl}`);
  return controlUrl;
}


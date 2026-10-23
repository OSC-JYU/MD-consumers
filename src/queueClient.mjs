import got from 'got';

import { mdHeaders } from './funcs.mjs';

/**
 * HTTP client for backend queue API.
 * Consumers poll the backend to claim jobs and report status.
 */
export function createQueueClient({ mdUrl, topic, adapterId }) {

  const headers = mdHeaders();

  async function claim() {
    const res = await got.post(`${mdUrl}/api/queue/claim`, {
      json: { topic, adapter_id: adapterId },
      headers,
    }).json();
    return res.job || null;
  }

  async function heartbeat(jobId) {
    await got.post(`${mdUrl}/api/queue/${jobId}/heartbeat`, {
      json: { adapter_id: adapterId },
      headers,
    });
  }

  async function complete(jobId) {
    await got.post(`${mdUrl}/api/queue/${jobId}/complete`, {
      json: { adapter_id: adapterId },
      headers,
    });
  }

  // Resolves to the backend's answer: `permanent` is true when the job will not be retried.
  async function fail(jobId, error) {
    return got.post(`${mdUrl}/api/queue/${jobId}/fail`, {
      json: { error: error?.message || String(error), adapter_id: adapterId },
      headers,
    }).json();
  }

  return { claim, heartbeat, complete, fail };
}

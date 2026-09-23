import got from 'got';

const DEFAULT_USER = 'local.user@localhost';

/**
 * HTTP client for backend queue API.
 * Consumers poll the backend to claim jobs and report status.
 */
export function createQueueClient({ mdUrl, topic, adapterId, user = DEFAULT_USER }) {

  const headers = { mail: user };

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

  async function fail(jobId, error) {
    await got.post(`${mdUrl}/api/queue/${jobId}/fail`, {
      json: { error: error?.message || String(error), adapter_id: adapterId },
      headers,
    });
  }

  return { claim, heartbeat, complete, fail };
}

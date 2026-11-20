// Thin client for CSC's FirecREST HPC API (FirecREST v2, https://docs.csc.fi/computing/firecrest/).
// Only what the roihu adapter needs: submit a Slurm job, ask its state, cancel it, read small
// files and list directories on the cluster. Data moves through Allas (s3.mjs), not through here.

import fs from 'node:fs';
import got from 'got';

export const DEFAULT_URL = 'https://api.roihu.csc.fi/v1';

const COMPLETED_STATES = ['BOOT_FAIL', 'CANCELLED', 'COMPLETED', 'DEADLINE', 'FAILED', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'TIMEOUT'];

/** An expired or missing token: nothing is wrong with the request, a person has to fetch a new one. */
export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

/** The state of a job as one upper-case word: `CANCELLED by 123` -> `CANCELLED`. */
export function stateName(state) {
  const text = Array.isArray(state) ? state.join(',') : String(state || '');
  return text.split(',')[0].trim().split(/[\s+]/)[0].toUpperCase();
}

export function isTerminalState(state) {
  const text = Array.isArray(state) ? state.join(',') : String(state || '');
  if (!text) return false;
  return text.split(',').every((part) => COMPLETED_STATES.some((s) => part.toUpperCase().includes(s)));
}

/** Expiry (seconds since epoch) of a JWT, read without verifying it; null when it has none. */
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? Number(payload.exp) : null;
  } catch {
    return null;
  }
}

/**
 * Where the access token comes from. A personal token lives 24 hours, so it is read again for
 * every request: put the new one in the file (or the environment) and the consumer picks it up.
 * `FIRECREST_TOKEN_FILE` wins over `FIRECREST_TOKEN`.
 */
export function tokenFromEnv(env = process.env) {
  return () => {
    let token = null;
    if (env.FIRECREST_TOKEN_FILE) {
      try {
        token = fs.readFileSync(env.FIRECREST_TOKEN_FILE, 'utf8').trim();
      } catch (e) {
        throw new TokenError(`cannot read FIRECREST_TOKEN_FILE ${env.FIRECREST_TOKEN_FILE}: ${e.message}`);
      }
    }
    token = token || String(env.FIRECREST_TOKEN || env.firecrest_token || '').trim();
    if (!token) throw new TokenError('no FirecREST token: set FIRECREST_TOKEN_FILE or FIRECREST_TOKEN (https://my.csc.fi/firecrest-token)');
    const exp = tokenExpiry(token);
    if (exp !== null && exp * 1000 <= Date.now()) {
      throw new TokenError('the FirecREST token has expired, get a new one from https://my.csc.fi/firecrest-token');
    }
    return token;
  };
}

/**
 * A token that was given for one run (the user's own, from the vault). It cannot be replaced while the
 * run lasts, so an expired one is an error for the caller to report, not something to wait for.
 */
export function tokenFromValue(token) {
  return () => {
    const exp = tokenExpiry(token);
    if (exp !== null && exp * 1000 <= Date.now()) {
      throw new TokenError('the FirecREST token has expired, create a new one at https://my.csc.fi/firecrest-token');
    }
    return token;
  };
}

/** Error text of a failed request, with FirecREST's own message when it sent one. */
function describe(error) {
  const body = error?.response?.body;
  let message = '';
  try {
    message = (typeof body === 'string' ? JSON.parse(body) : body)?.message || '';
  } catch {
    message = String(body || '').slice(0, 300);
  }
  const status = error?.response?.statusCode;
  return `${error.message}${message ? `: ${String(message).slice(0, 500)}` : ''}${status ? ` (HTTP ${status})` : ''}`;
}

/**
 * @param {object} options
 * @param {string} [options.url] API base, ends with the generation (`/v1`)
 * @param {string} options.system `cpu` or `gpu`
 * @param {string} options.account Slurm account (the billing project), `project_2018805`
 * @param {() => string} options.token returns the current access token, see tokenFromEnv
 */
export function createFirecrest({ url = DEFAULT_URL, system, account, token, timeoutMs = 30000 }) {
  const base = url.replace(/\/+$/, '');

  // `once`: the request must not be repeated after it may have reached FirecREST (a job submission:
  // a lost answer would start a second Slurm job). Only 429 is retried then, which means "not processed".
  async function request(method, endpoint, { searchParams, json, once = false } = {}) {
    // Read before the request: an expired token is a TokenError, not a failed request to retry.
    const bearer = token();
    try {
      const response = await got(`${base}${endpoint}`, {
        method,
        searchParams,
        json,
        headers: { Authorization: `Bearer ${bearer}` },
        timeout: { request: timeoutMs },
        // 429 carries Retry-After, which got honours; 5xx and network errors are retried a few times
        retry: once
          ? { limit: 4, methods: ['POST'], statusCodes: [429], errorCodes: [] }
          : { limit: 4, methods: ['GET', 'DELETE', 'POST'], statusCodes: [408, 429, 500, 502, 503, 504] },
        responseType: 'json',
      });
      return response.body;
    } catch (error) {
      const wrapped = new Error(`FirecREST ${method} ${endpoint} failed: ${describe(error)}`);
      // no `cause`: the failed request holds the job script, which can carry the user's keys
      wrapped.statusCode = error?.response?.statusCode;
      throw wrapped;
    }
  }

  return {
    system,
    account,

    userinfo: () => request('GET', `/status/${system}/userinfo`),

    /** Submits a batch script; resolves to the Slurm job id (a string). */
    async submit({ script, workingDirectory }) {
      const body = await request('POST', `/compute/${system}/jobs`, {
        json: { job: { script, working_directory: workingDirectory, account } },
        once: true,
      });
      const id = body?.jobId ?? body?.job_id;
      if (id === undefined || id === null) throw new Error(`FirecREST did not return a job id: ${JSON.stringify(body).slice(0, 300)}`);
      return String(id);
    },

    /**
     * { state, terminal, reason } of a job; state is `UNKNOWN` while Slurm has not registered a job
     * just submitted (FirecREST answers 404 for a few seconds).
     */
    async jobInfo(jobId) {
      try {
        const body = await request('GET', `/compute/${system}/jobs/${jobId}`);
        const job = (body?.jobs || [])[0];
        if (!job) return { state: 'UNKNOWN', terminal: false };
        const state = job.status?.state;
        return { state: stateName(state), terminal: isTerminalState(state), reason: job.status?.stateReason || job.status?.reason || '' };
      } catch (error) {
        if (error.statusCode === 404) return { state: 'UNKNOWN', terminal: false };
        throw error;
      }
    },

    async cancel(jobId) {
      try {
        await request('DELETE', `/compute/${system}/jobs/${jobId}`);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    },

    /** Whole content of a text file up to 5 MB, or null when it does not exist. */
    async view(path) {
      try {
        return (await request('GET', `/filesystem/${system}/ops/view`, { searchParams: { path } }))?.output ?? '';
      } catch (error) {
        if (error.statusCode === 404) return null;
        throw error;
      }
    },

    /** Names in a directory, or null when it does not exist. */
    async list(path) {
      try {
        const body = await request('GET', `/filesystem/${system}/ops/ls`, { searchParams: { path } });
        return (body?.output || []).map((entry) => entry.name);
      } catch (error) {
        if (error.statusCode === 404) return null;
        throw error;
      }
    },

    async mkdir(path) {
      await request('POST', `/filesystem/${system}/ops/mkdir`, { json: { sourcePath: path, parent: true } });
    },
  };
}

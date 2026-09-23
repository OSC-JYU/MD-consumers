import path from 'path';
import fs from 'fs';
import got from 'got';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

import {
  getServiceURL,
  createService,
  createDataDir,
  printInfo,
  resolveDescriptorSourceChain,
  resolveNomadHclPath,
  getRuntimeConfigDescriptor,
  stopService,
  registerServiceDescriptorWithRetry,
} from './funcs.mjs';

import { createQueueClient } from './queueClient.mjs';
import { startControlServer } from './server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOPIC = process.env.TOPIC;
const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1';
const MD_URL = process.env.MD_URL || 'http://localhost:8200';
const DEV_URL = process.env.DEV_URL || null;
const HELP_URL = process.env.HELP_URL || null;
const SERVICE_JSON_PATH = process.env.SERVICE_JSON_PATH || process.env.SERVICE_DESCRIPTOR_PATH || null;
const NOMAD_HCL_PATH_ENV = process.env.NOMAD_HCL_PATH || null;
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 0);

const DEFAULT_USER = 'local.user@localhost';
const REGISTRATION_MAX_ATTEMPTS = Number(process.env.REGISTRATION_MAX_ATTEMPTS || 5);
const REGISTRATION_INITIAL_DELAY_MS = Number(process.env.REGISTRATION_INITIAL_DELAY_MS || 500);
const HAS_EXPLICIT_DESCRIPTOR_PATH = Boolean(SERVICE_JSON_PATH);
const STRICT_TOPIC_ID = !['0', 'false', 'no', 'off'].includes(String(process.env.STRICT_TOPIC_ID || 'true').toLowerCase());

const POLL_MIN_MS = Number(process.env.POLL_MIN_MS || 100);
const POLL_MAX_MS = Number(process.env.POLL_MAX_MS || 2000);
const REQUIRE_DEV_URL_UP = Boolean(DEV_URL)
  && !NOMAD_HCL_PATH_ENV
  && !['0', 'false', 'no', 'off'].includes(String(process.env.REQUIRE_DEV_URL_UP || 'true').toLowerCase());
const DEV_URL_WAIT_MAX_MS = Number(process.env.DEV_URL_WAIT_MAX_MS || 10000);
const DEV_URL_WAIT_STEP_MS = Number(process.env.DEV_URL_WAIT_STEP_MS || 1000);
const DEV_URL_PROBE_TIMEOUT_MS = Number(process.env.DEV_URL_PROBE_TIMEOUT_MS || 3000);
const DESCRIPTOR_WAIT_MAX_MS = Number(process.env.DESCRIPTOR_WAIT_MAX_MS || 15000);
const DESCRIPTOR_WAIT_STEP_MS = Number(process.env.DESCRIPTOR_WAIT_STEP_MS || 1000);

if (!TOPIC) {
  throw new Error('TOPIC environment variable is required');
}

function resolveDescriptorPathForRuntime(inputPath) {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  const candidates = [
    path.resolve(process.cwd(), inputPath),
    path.resolve(__dirname, '..', inputPath),
    path.resolve('/src', inputPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolvePathForRuntime(inputPath) {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  const candidates = [
    path.resolve(process.cwd(), inputPath),
    path.resolve(__dirname, '..', inputPath),
    path.resolve('/src', inputPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const EFFECTIVE_SERVICE_JSON_PATH = resolveDescriptorPathForRuntime(SERVICE_JSON_PATH);
const EFFECTIVE_NOMAD_HCL_PATH = resolvePathForRuntime(NOMAD_HCL_PATH_ENV);
const NOMAD_MODE = Boolean(EFFECTIVE_NOMAD_HCL_PATH);

if (NOMAD_HCL_PATH_ENV && !fs.existsSync(EFFECTIVE_NOMAD_HCL_PATH)) {
  throw new Error(`NOMAD_HCL_PATH file not found: ${EFFECTIVE_NOMAD_HCL_PATH}`);
}

if (SERVICE_JSON_PATH && SERVICE_JSON_PATH !== EFFECTIVE_SERVICE_JSON_PATH) {
  console.log(`resolved SERVICE_JSON_PATH: ${SERVICE_JSON_PATH} -> ${EFFECTIVE_SERVICE_JSON_PATH}`);
}

function validateTopicIdMatch(descriptor, source = 'descriptor') {
  if (!descriptor || typeof descriptor !== 'object') {
    return;
  }

  const descriptorId = descriptor.id;
  if (!descriptorId || descriptorId === TOPIC) {
    return;
  }

  const message = `Descriptor id mismatch from ${source}: TOPIC (${TOPIC}) does not match descriptor id (${descriptorId}). Fix service /config id or use matching TOPIC. Set STRICT_TOPIC_ID=false to bypass (not recommended).`;
  if (STRICT_TOPIC_ID) {
    throw new Error(message);
  }
  console.log(`WARN: ${message}`);
}

function normalizeServiceUrl(serviceUrl) {
  if (!serviceUrl) return serviceUrl;
  return serviceUrl.startsWith('http') ? serviceUrl : `http://${serviceUrl}`;
}

async function checkDevUrlConfig(baseUrl) {
  try {
    await got.get(`${baseUrl}/config`, {
      timeout: { request: DEV_URL_PROBE_TIMEOUT_MS },
    }).json();
    return { ok: true, status: 200, source: '/config', error: null };
  } catch (error) {
    const status = error?.response?.statusCode || null;
    return { ok: false, status, source: '/config', error: error.message };
  }
}

async function checkDevUrlHealth(baseUrl) {
  try {
    const response = await got.get(`${baseUrl}/health`, {
      timeout: { request: DEV_URL_PROBE_TIMEOUT_MS },
      throwHttpErrors: false,
    });
    const ok = response.statusCode >= 200 && response.statusCode < 300;
    return { ok, status: response.statusCode, source: '/health', error: null };
  } catch (error) {
    const status = error?.response?.statusCode || null;
    return { ok: false, status, source: '/health', error: error.message };
  }
}

async function ensureDevUrlServiceReachable(serviceUrl) {
  const baseUrl = normalizeServiceUrl(serviceUrl);
  const startedAt = Date.now();
  let lastProbe = { ok: false, status: null, source: 'n/a', error: 'not checked' };

  while (Date.now() - startedAt <= DEV_URL_WAIT_MAX_MS) {
    const configProbe = await checkDevUrlConfig(baseUrl);
    if (configProbe.ok) {
      return { source: '/config' };
    }

    const healthProbe = await checkDevUrlHealth(baseUrl);
    if (healthProbe.ok) {
      return { source: '/health' };
    }

    lastProbe = healthProbe.status ? healthProbe : configProbe;

    if (Date.now() - startedAt >= DEV_URL_WAIT_MAX_MS) {
      break;
    }
    await sleep(DEV_URL_WAIT_STEP_MS);
  }

  const statusInfo = lastProbe.status ? `status ${lastProbe.status}` : (lastProbe.error || 'unreachable');
  throw new Error(
    `DEV_URL preflight failed for ${TOPIC} at ${baseUrl}: service did not answer /config or healthy /health within ${DEV_URL_WAIT_MAX_MS} ms (last ${lastProbe.source}: ${statusInfo}). Start service first, set REQUIRE_DEV_URL_UP=false for debugging, or use NOMAD_HCL_PATH startup.`
  );
}

async function waitForRuntimeDescriptor(serviceUrl) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= DESCRIPTOR_WAIT_MAX_MS) {
    const descriptor = await getRuntimeConfigDescriptor(serviceUrl, TOPIC);
    if (descriptor) {
      return descriptor;
    }

    if (Date.now() - startedAt >= DESCRIPTOR_WAIT_MAX_MS) {
      break;
    }
    await sleep(DESCRIPTOR_WAIT_STEP_MS);
  }

  return null;
}

async function resolveRequiredDescriptor({
  topic,
  adapterName,
  descriptorPath,
  mdUrl,
  serviceUrl,
  user,
  waitForRuntime = false,
}) {
  if (descriptorPath) {
    const resolved = await resolveDescriptorSourceChain({
      topic,
      adapterName,
      descriptorPath,
      mdUrl,
      serviceUrl: null,
      user,
    });
    return resolved;
  }

  const runtimeDescriptor = waitForRuntime
    ? await waitForRuntimeDescriptor(serviceUrl)
    : await getRuntimeConfigDescriptor(serviceUrl, topic);

  if (runtimeDescriptor) {
    return { descriptor: runtimeDescriptor, source: 'runtime-config' };
  }

  throw new Error(
    `Service descriptor not available for ${topic}. Provide SERVICE_JSON_PATH or make ${serviceUrl}/config return descriptor JSON.`
  );
}

async function triggerServiceHelpIngest(serviceId, descriptor = null) {
  const ingestUrl = `${MD_URL}/api/services/${serviceId}/help/ingest`;
  const configuredHelpUrl = HELP_URL || descriptor?.help_url || null;
  try {
    const options = { headers: { mail: DEFAULT_USER } };
    if (configuredHelpUrl) {
      options.searchParams = { help_url: configuredHelpUrl };
    }
    await got.post(ingestUrl, options).json();
    console.log('service help ingested:', serviceId);
  } catch (error) {
    const status = error?.response?.statusCode;
    const detail = error?.response?.body || error.message;
    console.log(`WARN: service help ingest failed for ${serviceId}${status ? ` (${status})` : ''}`);
    if (detail) console.log(detail);
  }
}

// --- Batch Runner ---

function createBatchRunner() {
  let paused = false;
  let cancelled = false;
  let currentJobId = null;
  let pauseResolve = null;

  function setPaused(jobId) {
    if (jobId === currentJobId) paused = true;
  }

  function setResumed(jobId) {
    if (jobId === currentJobId) {
      paused = false;
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
    }
  }

  function setCancelled(jobId) {
    if (jobId === currentJobId) {
      cancelled = true;
      paused = false;
      if (pauseResolve) {
        pauseResolve();
        pauseResolve = null;
      }
    }
  }

  function reset() {
    paused = false;
    cancelled = false;
    currentJobId = null;
    pauseResolve = null;
  }

  function setCurrentJob(jobId) {
    currentJobId = jobId;
  }

  function isPaused() { return paused; }
  function isCancelled() { return cancelled; }

  async function waitUntilResumedOrCancelled() {
    if (!paused) return;
    await new Promise((resolve) => { pauseResolve = resolve; });
  }

  return { setPaused, setResumed, setCancelled, reset, setCurrentJob, isPaused, isCancelled, waitUntilResumedOrCancelled };
}

// --- Main ---

let adapter_id = null;
let interval = null;
let stopped = false;
let shutdownInProgress = false;
let serviceStartedByConsumer = false;
let serviceRegisteredInBackend = false;

const batchRunner = createBatchRunner();

async function shutdown(signal = 'SIGINT') {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  stopped = true;
  clearInterval(interval);

  const options = { headers: { mail: DEFAULT_USER } };

  try {
    if (adapter_id) {
      await got.delete(`${MD_URL}/api/services/${TOPIC}/adapter/${adapter_id}`, options);
      console.log('adapter deregistered:', adapter_id);
    }
  } catch (e) {
    console.log('cleanup error (adapter deregistration):', e.message);
  }

  try {
    if (serviceStartedByConsumer && NOMAD_MODE) {
      await stopService(MD_URL, TOPIC);
      console.log('nomad service stopped:', TOPIC);
    }
  } catch (e) {
    console.log('cleanup error (nomad stop):', e.message);
  }

  try {
    if (serviceRegisteredInBackend) {
      await got.delete(`${MD_URL}/api/services/${TOPIC}`, options);
      console.log('service registration deleted:', TOPIC);
    }
  } catch (e) {
    console.log('cleanup error (service registration delete):', e.message);
  }

  process.exit(0);
}

process.on('SIGINT', async function () {
  await shutdown('SIGINT');
});

process.on('SIGTERM', async function () {
  await shutdown('SIGTERM');
});

async function main() {
  printInfo(TOPIC, NOMAD_URL, MD_URL);
  console.log('creating data directory...');
  await createDataDir();

  adapter_id = uuidv4();
  const request_json = { topic: TOPIC };

  // --- Resolve initial descriptor for startup overrides ---
  let service_json = { id: TOPIC, tasks: {} };
  if (HAS_EXPLICIT_DESCRIPTOR_PATH) {
    const bootstrap = await resolveRequiredDescriptor({
      topic: TOPIC,
      adapterName: process.env.ADAPTER || null,
      descriptorPath: EFFECTIVE_SERVICE_JSON_PATH,
      mdUrl: MD_URL,
      serviceUrl: null,
      user: DEFAULT_USER,
      waitForRuntime: false,
    });
    service_json = bootstrap.descriptor;
    validateTopicIdMatch(service_json, bootstrap.source || 'explicit-descriptor');
  }

  let adapter_name = process.env.ADAPTER || service_json.adapter || null;

  // --- Resolve service URL ---
  let service_url = DEV_URL || await getServiceURL(NOMAD_URL, request_json, service_json, NOMAD_MODE);

  const nomadHclPath = EFFECTIVE_NOMAD_HCL_PATH || await resolveNomadHclPath({
    descriptorPath: EFFECTIVE_SERVICE_JSON_PATH,
  });

  if (!service_url) {
    console.log(TOPIC, ': no service found');
    console.log('starting service...');
    try {
      if (nomadHclPath) console.log('using nomad spec from:', nomadHclPath);
      await createService(MD_URL, TOPIC, { nomadHclPath });
      serviceStartedByConsumer = true;
      service_url = await waitForService(request_json, service_json, NOMAD_MODE);
    } catch (e) {
      console.log('Error starting service:', e);
      process.exit(1);
    }
  }

  if (!service_url) {
    throw new Error(`Service URL for ${TOPIC} not available`);
  }

  service_url = normalizeServiceUrl(service_url);

  if (REQUIRE_DEV_URL_UP) {
    console.log(`checking DEV_URL service availability: ${service_url}`);
    const preflight = await ensureDevUrlServiceReachable(service_url);
    console.log(`DEV_URL preflight ok via ${preflight.source}`);
  }

  // --- Registration ---
  const resolvedRegistration = await resolveRequiredDescriptor({
    topic: TOPIC,
    adapterName: adapter_name,
    descriptorPath: EFFECTIVE_SERVICE_JSON_PATH,
    mdUrl: MD_URL,
    serviceUrl: service_url,
    user: DEFAULT_USER,
    waitForRuntime: true,
  });
  service_json = resolvedRegistration.descriptor;
  const registrationSource = resolvedRegistration.source;
  validateTopicIdMatch(service_json, registrationSource);

  if (!adapter_name && service_json?.adapter) {
    adapter_name = service_json.adapter;
  }
  if (!adapter_name) {
    throw new Error('No adapter specified in environment variable or service descriptor');
  }

  await registerServiceDescriptorWithRetry({
    mdUrl: MD_URL,
    descriptor: service_json,
    source: registrationSource,
    user: DEFAULT_USER,
    maxAttempts: REGISTRATION_MAX_ATTEMPTS,
    initialDelayMs: REGISTRATION_INITIAL_DELAY_MS,
  });
  serviceRegisteredInBackend = true;

  await triggerServiceHelpIngest(TOPIC, service_json);

  // --- Start control server ---
  const controlUrl = await startControlServer(CONTROL_PORT, batchRunner);

  // --- Register adapter with backend ---
  const registerUrl = `${MD_URL}/api/services/${TOPIC}/adapter/${adapter_id}`;
  console.log('registering consumer:', registerUrl);
  const options = { headers: { mail: DEFAULT_USER } };
  await got.post(registerUrl, { ...options, json: { control_url: controlUrl } }).json();

  // --- Load adapter ---
  const process_msg = (await import(`./adapters/${adapter_name}.mjs`)).process_msg;

  // --- Heartbeat interval (re-registration every 30s) ---
  interval = setInterval(async () => {
    try {
      const resolvedHeartbeat = await resolveRequiredDescriptor({
        topic: TOPIC,
        adapterName: adapter_name,
        descriptorPath: EFFECTIVE_SERVICE_JSON_PATH,
        mdUrl: MD_URL,
        serviceUrl: service_url,
        user: DEFAULT_USER,
        waitForRuntime: false,
      });
      service_json = resolvedHeartbeat.descriptor;
      const heartbeatSource = resolvedHeartbeat.source;
      validateTopicIdMatch(service_json, heartbeatSource);
      await registerServiceDescriptorWithRetry({
        mdUrl: MD_URL,
        descriptor: service_json,
        source: heartbeatSource,
        user: DEFAULT_USER,
        maxAttempts: 3,
        initialDelayMs: REGISTRATION_INITIAL_DELAY_MS,
      });
      await got.post(registerUrl, { ...options, json: { control_url: controlUrl } }).json();
    } catch (e) {
      console.log('heartbeat error:', e.message);
    }
  }, 30000);

  // --- Create queue client ---
  const queueClient = createQueueClient({
    mdUrl: MD_URL,
    topic: TOPIC,
    adapterId: adapter_id,
    user: DEFAULT_USER,
  });

  // --- Main processing loop ---
  console.log(`${TOPIC}: ready for messages (HTTP queue polling)`);
  console.log('SERVICE URL:', service_url);

  let backoff = POLL_MIN_MS;

  while (!stopped) {
    let job = null;
    try {
      job = await queueClient.claim();
    } catch (e) {
      if (e?.response?.statusCode === 404) {
        // Queue endpoint not available yet (backend hasn't implemented it)
        await sleep(POLL_MAX_MS);
        continue;
      }
      console.log('claim error:', e.message);
      await sleep(POLL_MAX_MS);
      continue;
    }

    if (!job) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, POLL_MAX_MS);
      continue;
    }

    backoff = POLL_MIN_MS;
    batchRunner.reset();
    batchRunner.setCurrentJob(job.id);

    // Heartbeat for this specific job (extend lease)
    const heartbeatTimer = setInterval(async () => {
      try {
        await queueClient.heartbeat(job.id);
      } catch (e) {
        console.log(`job heartbeat failed for ${job.id}:`, e.message);
      }
    }, 40_000);

    try {
      const m = { json: () => job.payload };
      await process_msg(service_url, m);
      await queueClient.complete(job.id);
    } catch (e) {
      console.log(`ERROR processing job ${job.id}:`, e.message);
      try {
        await queueClient.fail(job.id, e);
      } catch (fe) {
        console.log('fail report error:', fe.message);
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}

async function waitForService(request_json, service_json, nomadMode) {
  let service_url = '';
  while (!service_url && !stopped) {
    console.log('waiting for service...');
    service_url = await getServiceURL(NOMAD_URL, request_json, service_json, nomadMode);
    if (!service_url) await sleep(2000);
  }
  return service_url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  if (String(e?.message || '').includes('/config is not available')) {
    console.log(`ERROR: Service registration cancelled for "${TOPIC}"`);
    console.log(e.message);
    console.log('HINT: start the service first, then run the consumer.');
  } else {
    console.log('ERROR:', e.message);
  }
  process.exit(1);
});


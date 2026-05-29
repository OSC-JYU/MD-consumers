import path from 'path';
import got from 'got';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseSync } from 'node:sqlite';

import {
  getServiceURL,
  createService,
  createDataDir,
  printInfo,
  resolveDescriptorSourceChain,
  resolveNomadHclPath,
  getRuntimeConfigDescriptor,
  registerServiceDescriptorWithRetry,
} from './funcs.mjs';

const TOPIC = process.env.TOPIC;
const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1';
const MD_URL = process.env.MD_URL || 'http://localhost:8200';
const DEV_URL = process.env.DEV_URL || null;
const SERVICE_JSON_PATH = process.env.SERVICE_JSON_PATH || process.env.SERVICE_DESCRIPTOR_PATH || null;
const NOMAD = process.env.NOMAD || null;
const NOMAD_HCL_PATH_ENV = process.env.NOMAD_HCL_PATH || null;
const NOMAD_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(NOMAD || '').toLowerCase());
const USE_LEGACY_NOMAD_METADATA = NOMAD_ENABLED && !NOMAD_HCL_PATH_ENV;

const QUEUE_DB_PATH = process.env.QUEUE_DB_PATH || '/tmp/messydesk-queue.sqlite';
const POLL_MIN_MS = Number(process.env.QUEUE_DB_POLL_MIN_MS || 100);
const POLL_MAX_MS = Number(process.env.QUEUE_DB_POLL_MAX_MS || 2000);
const LEASE_SECONDS = Number(process.env.QUEUE_DB_LEASE_SECONDS || 120);
const DEFAULT_MAX_ATTEMPTS = Number(process.env.QUEUE_DB_MAX_ATTEMPTS || 3);

const DEFAULT_USER = 'local.user@localhost';
const REGISTRATION_MAX_ATTEMPTS = Number(process.env.REGISTRATION_MAX_ATTEMPTS || 5);
const REGISTRATION_INITIAL_DELAY_MS = Number(process.env.REGISTRATION_INITIAL_DELAY_MS || 500);

if (!TOPIC) {
  throw new Error('TOPIC environment variable is required');
}

let db;
let interval = null;
let adapter_id;
let stopped = false;

const consumerId = `${TOPIC}:${process.pid}:${uuidv4()}`;
const queues = [TOPIC, `${TOPIC}_batch`];

printInfo(TOPIC, NOMAD_URL, 'sqlite', MD_URL, DEFAULT_MAX_ATTEMPTS);

process.on('SIGINT', async function () {
  stopped = true;
  clearInterval(interval);
  try {
    const options = { headers: { mail: DEFAULT_USER } };
    if (adapter_id) {
      await got.delete(`${MD_URL}/api/services/${TOPIC}/adapter/${adapter_id}`, options);
    }
  } catch (e) {
    console.log('cleanup error:', e.message);
  }

  if (db) db.close();
  process.exit();
});

function openDb() {
  if (db) return db;
  db = new DatabaseSync(QUEUE_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      process_rid TEXT,
      set_process_rid TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_until TEXT,
      next_retry_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_queue_claim
      ON queue_jobs(queue, status, next_retry_at, created_at);
  `);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function plusSecondsIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function nextBackoffMs(attempts) {
  const base = 500;
  return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), 30000);
}

function claimNext(queueName) {
  const sqlite = openDb();
  const now = nowIso();
  const leaseUntil = plusSecondsIso(LEASE_SECONDS);

  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const row = sqlite.prepare(`
      SELECT id, payload_json, attempts, max_attempts
      FROM queue_jobs
      WHERE queue = ?
        AND (
          (status = 'queued' AND next_retry_at <= ?)
          OR (status = 'running' AND lease_until < ?)
        )
      ORDER BY created_at ASC
      LIMIT 1
    `).get(queueName, now, now);

    if (!row) {
      sqlite.exec('COMMIT');
      return null;
    }

    sqlite.prepare(`
      UPDATE queue_jobs
      SET status = 'running',
          claimed_by = ?,
          claimed_at = ?,
          lease_until = ?,
          attempts = attempts + 1,
          updated_at = ?
      WHERE id = ?
    `).run(consumerId, now, leaseUntil, now, row.id);

    sqlite.exec('COMMIT');

    return {
      id: row.id,
      payloadJson: row.payload_json,
      attempts: Number(row.attempts || 0) + 1,
      maxAttempts: Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS),
    };
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

function heartbeat(jobId) {
  const sqlite = openDb();
  sqlite.prepare(`
    UPDATE queue_jobs
    SET lease_until = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND claimed_by = ?
  `).run(plusSecondsIso(LEASE_SECONDS), nowIso(), jobId, consumerId);
}

function complete(jobId) {
  const sqlite = openDb();
  const now = nowIso();
  sqlite.prepare(`
    UPDATE queue_jobs
    SET status = 'done',
        lease_until = NULL,
        claimed_by = NULL,
        claimed_at = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(now, now, jobId);
}

function fail(jobId, attempts, maxAttempts, errorMessage) {
  const sqlite = openDb();
  const now = nowIso();
  if (attempts >= maxAttempts) {
    sqlite.prepare(`
      UPDATE queue_jobs
      SET status = 'failed',
          lease_until = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(String(errorMessage || 'processing failed'), now, jobId);
    return;
  }

  const retryAt = new Date(Date.now() + nextBackoffMs(attempts)).toISOString();
  sqlite.prepare(`
    UPDATE queue_jobs
    SET status = 'queued',
        lease_until = NULL,
        claimed_by = NULL,
        claimed_at = NULL,
        next_retry_at = ?,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(retryAt, String(errorMessage || 'processing failed'), now, jobId);
}

async function resolveService(request_json, service_json) {
  if (DEV_URL) return DEV_URL;

  let service_url = '';
  while (!service_url && !stopped) {
    console.log('waiting for service...');
    service_url = await getServiceURL(NOMAD_URL, request_json, service_json);
    if (!service_url) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return service_url;
}

async function processQueue(queueName, process_msg, service_url) {
  let idleBackoff = POLL_MIN_MS;

  while (!stopped) {
    let job = null;
    try {
      job = claimNext(queueName);
    } catch (e) {
      console.log(`claim error on ${queueName}:`, e.message);
      await new Promise((resolve) => setTimeout(resolve, POLL_MAX_MS));
      continue;
    }

    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, idleBackoff));
      idleBackoff = Math.min(idleBackoff * 2, POLL_MAX_MS);
      continue;
    }

    idleBackoff = POLL_MIN_MS;
    const heartbeatTimer = setInterval(() => {
      try {
        heartbeat(job.id);
      } catch (e) {
        console.log(`heartbeat failed for job ${job.id}:`, e.message);
      }
    }, Math.max(1000, Math.floor((LEASE_SECONDS * 1000) / 3)));

    try {
      const m = {
        json: () => JSON.parse(job.payloadJson),
      };
      await process_msg(service_url, m);
      complete(job.id);
    } catch (e) {
      console.log(`ERROR processing job ${job.id} on ${queueName}:`, e.message);
      fail(job.id, job.attempts, job.maxAttempts, e.message);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}

async function main() {
  console.log('creating data directory...');
  await createDataDir();
  openDb();

  adapter_id = uuidv4();
  const request_json = { topic: TOPIC, nomad: NOMAD };

  const bootstrap = await resolveDescriptorSourceChain({
    topic: TOPIC,
    adapterName: process.env.ADAPTER || null,
    descriptorPath: SERVICE_JSON_PATH,
    mdUrl: MD_URL,
    serviceUrl: null,
    user: DEFAULT_USER,
  });
  let service_json = bootstrap.descriptor;

  let adapter_name = process.env.ADAPTER || service_json.adapter || null;

  const nomadHclPath = NOMAD_HCL_PATH_ENV || await resolveNomadHclPath(TOPIC, {
    descriptorPath: SERVICE_JSON_PATH,
    adapterName: adapter_name,
  });

  let service_url = await resolveService(request_json, service_json);
  if (!service_url) {
    console.log(TOPIC, ': no service found');
    console.log('starting service...');
    if (nomadHclPath) {
      console.log('using nomad spec from:', nomadHclPath);
    }
    await createService(MD_URL, TOPIC, { nomadHclPath: nomadHclPath });
    service_url = await resolveService(request_json, service_json);
  }

  if (!service_url) {
    throw new Error(`Service URL for ${TOPIC} not available`);
  }

  let registrationSource = 'runtime-config';
  if (USE_LEGACY_NOMAD_METADATA) {
    console.log('using legacy Nomad metadata from MessyDesk services directory...');
    const resolved = await resolveDescriptorSourceChain({
      topic: TOPIC,
      adapterName: adapter_name,
      descriptorPath: SERVICE_JSON_PATH,
      mdUrl: MD_URL,
      serviceUrl: null,
      user: DEFAULT_USER,
    });
    service_json = resolved.descriptor;
    registrationSource = resolved.source;
  } else {
    const runtimeDescriptor = await getRuntimeConfigDescriptor(service_url, TOPIC);
    if (!runtimeDescriptor) {
      throw new Error(`Registration cancelled: service ${TOPIC} /config is not available`);
    }
    service_json = runtimeDescriptor;
  }

  if (!adapter_name && service_json?.adapter) {
    adapter_name = service_json.adapter;
  }

  if (!adapter_name) {
    throw new Error('No adapter specified in environment variable or service descriptor (including runtime /config)');
  }

  await registerServiceDescriptorWithRetry({
    mdUrl: MD_URL,
    descriptor: service_json,
    source: registrationSource,
    user: DEFAULT_USER,
    maxAttempts: REGISTRATION_MAX_ATTEMPTS,
    initialDelayMs: REGISTRATION_INITIAL_DELAY_MS,
  });

  const registerUrl = `${MD_URL}/api/services/${TOPIC}/adapter/${adapter_id}`;
  console.log('registering db-consumer: ', registerUrl);
  const options = { headers: { mail: DEFAULT_USER } };

  await got.post(registerUrl, options).json();

  const process_msg = (await import(`./adapters/${adapter_name}.mjs`)).process_msg;

  interval = setInterval(async () => {
    try {
      let heartbeatSource = 'runtime-config';
      if (USE_LEGACY_NOMAD_METADATA) {
        const resolved = await resolveDescriptorSourceChain({
          topic: TOPIC,
          adapterName: adapter_name,
          descriptorPath: SERVICE_JSON_PATH,
          mdUrl: MD_URL,
          serviceUrl: null,
          user: DEFAULT_USER,
        });
        service_json = resolved.descriptor;
        heartbeatSource = resolved.source;
      } else {
        const liveDescriptor = await getRuntimeConfigDescriptor(service_url, TOPIC);
        if (!liveDescriptor) {
          console.log('Registration skipped: /config is not available');
          return;
        }
        service_json = liveDescriptor;
      }
      await registerServiceDescriptorWithRetry({
        mdUrl: MD_URL,
        descriptor: service_json,
        source: heartbeatSource,
        user: DEFAULT_USER,
        maxAttempts: 3,
        initialDelayMs: REGISTRATION_INITIAL_DELAY_MS,
      });
      await got.post(registerUrl, options).json();
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  }, 30000);

  if (!service_url.startsWith('http')) {
    service_url = `http://${service_url}`;
  }

  console.log(TOPIC, ': ready for db queue messages...');
  console.log('SERVICE URL: ', service_url);
  console.log('QUEUE_DB_PATH:', QUEUE_DB_PATH);

  for (const queueName of queues) {
    processQueue(queueName, process_msg, service_url).catch((e) => {
      console.log(`queue loop failed for ${queueName}:`, e.message);
    });
  }
}

main().catch((e) => {
  if (String(e?.message || '').includes('/config is not available')) {
    console.log(`ERROR: Service registration cancelled for "${TOPIC}"`);
    console.log(e.message);
    console.log('HINT: start the service first, then run the consumer.');
  } else {
    console.log('ERROR in index-db:', e.message);
  }
  process.exit(1);
});

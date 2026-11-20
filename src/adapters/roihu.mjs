// roihu adapter: image files in, text recognised on CSC's Roihu supercomputer out.
//
// The consumer claims many queue jobs at once (maxConcurrentJobs), groups the jobs of one process,
// copies the images to Allas and submits ONE Slurm job per chunk through FirecREST. The job pulls
// the images from Allas, runs the model, and pushes every finished page back to Allas. The consumer
// polls Allas, downloads each page as soon as it is complete and reports it to MessyDesk, so the
// user sees results while the job is still running.
//
// Nothing here knows about a model. What runs on Roihu is the pipeline script named in the
// provider config (see MD-roihu-slurm); the contract between the two:
//
//   Allas      <prefix>/in/<id><ext>      the images, id = p0001, p0002, ...
//              <prefix>/out/<path>        results, paths listed in provider.pipeline.outputs
//              <prefix>/out/status.json   written LAST: {"finished": true, "empty": [ids], "failed": [ids], "rc": 0}
//   Script     placeholders {{SBATCH}} {{ENV}} {{ROOT}} {{REMOTE}} {{BUCKET}} {{PREFIX}} {{RUN_ID}} {{PAGES}}
//
// Runs survive a restart of the consumer: the run of every file is kept in a small state file, so a
// job claimed again after a restart joins the Slurm job that already exists instead of starting another.
//
// Whose account? Two modes, chosen by the service descriptor's `api_key_source`:
//   service  one account for everything: FirecREST token and Allas keys from the consumer's environment
//            (local use, `API_KEY_MODE=service` and a .env file)
//   user     every run brings its own credentials (hpc/credentials.mjs): the task's `secret_ref` is traded
//            for them at MessyDesk's vault; the user's project, Roihu directory, Allas bucket and keys
//            are then used for that run only. Nothing of them is written to disk or to a log.

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import got from 'got';

import { mdHeaders, mdRoot, resolveMdPath, tmpDirFor, getApiKey, getFile, sendDone, sendError } from '../funcs.mjs';
import { callbackMessage } from './elg.mjs';
import { createFirecrest, tokenFromEnv, tokenFromValue, TokenError, DEFAULT_URL } from '../hpc/firecrest.mjs';
import { createS3, DEFAULT_ENDPOINT } from '../hpc/s3.mjs';
import { CredentialsError, PermanentError, decodeCredentials } from '../hpc/credentials.mjs';
import { allasKeysFromConf } from '../hpc/rclone.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200';
const STATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

let settings = null;
let shared = null; // service mode: { firecrest, s3 } of the one account
let factory = null; // user mode: makes the clients of one run
let template = '';
let setupTemplate = '';
let topic = 'md-roihu';
let state = { runs: {} };

const groups = new Map(); // group key -> { key, items, timer }
const received = new Map(); // group key -> jobs of the batch seen so far
const itemsByJob = new Map(); // queue job id -> item
const liveRuns = new Map(); // run id -> run
const setups = new Map(); // account|remote root -> the setup job being waited for
let sharedBucketReady = null;
const warned = new Map();


// ---- pure helpers (exported for tests) ------------------------------------------------------

/**
 * The settings of a provider config with defaults; throws on what cannot work. In user mode the
 * account, the Roihu directory and the Allas bucket come from each run's credentials instead.
 */
export function normalizeSettings(provider = {}, env = process.env, { userMode = false } = {}) {
  const pipeline = provider.pipeline || {};
  const batching = provider.batching || {};
  const account = env.FIRECREST_ACCOUNT || provider.account || null;
  if (!account && !userMode) throw new Error('roihu: set "account" (the Slurm project, project_NNN) in the provider config or FIRECREST_ACCOUNT');
  if (!provider.remote_root) throw new Error('roihu: "remote_root" (a directory on Roihu for models, environments and job logs, /scratch/{project}/...) is not set');
  if (!pipeline.script) throw new Error('roihu: "pipeline.script" (the job script template) is not set');
  if (!Array.isArray(pipeline.outputs) || !pipeline.outputs.length) throw new Error('roihu: "pipeline.outputs" must list what the job produces per page');
  const allasProject = env.ALLAS_PROJECT || provider.allas_project || account;
  const maxPages = Number(batching.max_pages ?? 300);
  return {
    userMode,
    system: provider.system || 'gpu',
    firecrestUrl: env.FIRECREST_URL || provider.firecrest_url || DEFAULT_URL,
    account,
    remoteRootTemplate: provider.remote_root,
    remoteRoot: account ? remoteRootFor(provider.remote_root, account) : null,
    homeTemplate: provider.home_directory || '/users/{user}',
    partition: provider.partition || 'gpumedium',
    gres: provider.gres === undefined ? 'gpu:gh200:1' : provider.gres,
    sbatch: provider.sbatch || [],
    allasProject,
    rcloneRemote: provider.rclone_remote || (allasProject ? `s3allas-${allasProject}` : null),
    // bucket names are unique across Allas and take no underscores
    bucket: env.ALLAS_BUCKET || provider.bucket || (allasProject ? bucketFor(allasProject) : null),
    endpoint: env.ALLAS_ENDPOINT || provider.s3_endpoint || DEFAULT_ENDPOINT,
    script: pipeline.script,
    setupScript: pipeline.setup_script || null,
    setupMarker: pipeline.setup_marker || '.setup-done',
    autoSetup: provider.auto_setup !== false,
    pipelineEnv: pipeline.env || {},
    outputs: pipeline.outputs,
    formats: (provider.formats || ['jpg', 'jpeg', 'png', 'tif', 'tiff']).map((f) => String(f).toLowerCase()),
    startupSeconds: Number(pipeline.startup_seconds ?? 600),
    secondsPerPage: Number(pipeline.seconds_per_page ?? 4),
    maxPages,
    gatherMs: Number(batching.gather_seconds ?? 8) * 1000,
    pollMs: Number(batching.poll_seconds ?? 15) * 1000,
    maxClaimed: Number(batching.max_claimed ?? maxPages * 2),
    maxQueueHours: Number(batching.max_queue_hours ?? 48),
    uploadConcurrency: Number(batching.upload_concurrency ?? 4),
    tokenRetryMs: Number(batching.token_retry_seconds ?? 60) * 1000,
    keepData: provider.keep_data === true,
    statePath: provider.state_path || env.ROIHU_STATE_PATH || path.resolve(process.cwd(), 'data', 'roihu-state.json'),
  };
}

/** The Roihu directory of a project: `/scratch/{project}/messydesk/nafrec` -> `/scratch/project_NNN/...`. */
export function remoteRootFor(template, project) {
  return String(template).replace('{project}', project).replace(/\/+$/, '');
}

export function bucketFor(allasProject) {
  return `project-${String(allasProject).replace('project_', '')}-md-roihu`;
}

/** What differs from run to run: the account, the Roihu directory and the Allas bucket and remote. */
export function runConfig(cfg, creds = null) {
  if (!creds) return { account: cfg.account, allasProject: cfg.allasProject, remoteRoot: cfg.remoteRoot, bucket: cfg.bucket, rcloneRemote: cfg.rcloneRemote };
  return {
    account: creds.project,
    allasProject: creds.allasProject,
    remoteRoot: remoteRootFor(cfg.remoteRootTemplate, creds.project),
    bucket: bucketFor(creds.allasProject),
    // the remote that allas-conf made in the user's home on Roihu; the job needs no copy of the keys
    rcloneRemote: `s3allas-${creds.allasProject}`,
  };
}

/** Jobs of one process belong to one group (one Slurm job, up to max_pages); a single file is its own. */
export function groupKey(msg) {
  return String(msg?.set_process || msg?.process?.['@rid'] || msg?.file?.['@rid'] || 'single');
}

/** The input file id inside a run: p0001, p0002, ... */
export function pageId(index) {
  return `p${String(index + 1).padStart(4, '0')}`;
}

/** Slurm time limit: start-up plus the pages with a margin, between 20 minutes and 36 hours. */
export function timeLimit(pages, { startupSeconds, secondsPerPage }) {
  const seconds = startupSeconds + pages * secondsPerPage * 1.5;
  const minutes = Math.min(36 * 60, Math.max(20, Math.ceil(seconds / 60)));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
}

export function timeLimitSeconds(limit) {
  const [h, m, s] = limit.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** Fills {{NAME}} placeholders; an unknown placeholder is an error, so a typo cannot reach Roihu. */
export function renderTemplate(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`roihu: the job script uses an unknown placeholder {{${name}}}`);
    return values[name];
  });
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * `export NAME=...` lines. The operator's pipeline env goes in double quotes, so `$ROOT` and the like
 * expand; user parameters are single-quoted and never expand.
 */
export function envBlock(pipelineEnv, params = {}) {
  const lines = Object.entries(pipelineEnv).map(([name, value]) => `export ${name}="${String(value).replace(/[\\"]/g, '\\$&')}"`);
  for (const [name, value] of Object.entries(params || {})) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      lines.push(`export PARAM_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}=${shellQuote(value)}`);
    }
  }
  return lines.join('\n');
}

export function sbatchBlock(cfg, pages, jobName = 'md-roihu') {
  const lines = [
    `--job-name=${jobName}`,
    `--account=${cfg.account}`,
    `--partition=${cfg.partition}`,
    ...(cfg.gres ? [`--gres=${cfg.gres}`] : []),
    `--time=${timeLimit(pages, cfg)}`,
    '--output=slurm-%j.out',
    ...cfg.sbatch,
  ];
  return lines.map((line) => `#SBATCH ${line}`).join('\n');
}

export function outputKey(run, output, id) {
  return `${run.prefix}/out/${output.path.replace('{id}', id)}`;
}

/** Label of an output file: `{stem}` is the input's name without extension. */
export function outputLabel(output, inputLabel) {
  const stem = String(inputLabel || 'output').replace(/\.[^./]+$/, '');
  return output.label.replace('{stem}', stem);
}

export function parseStatus(text) {
  try {
    const status = JSON.parse(text);
    return { finished: status.finished === true, empty: status.empty || [], failed: status.failed || [], rc: status.rc };
  } catch {
    return null;
  }
}

async function mapLimit(list, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      await fn(list[index], index);
    }
  });
  await Promise.all(workers);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log('roihu:', ...args);
}

function warnOnce(key, message, everyMs = 5 * 60 * 1000) {
  const last = warned.get(key) || 0;
  if (Date.now() - last < everyMs) return;
  warned.set(key, Date.now());
  log(`WARN: ${message}`);
}


// ---- state: runs that survive a restart -----------------------------------------------------

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(settings.statePath, 'utf8'));
    if (!state.runs) state.runs = {};
  } catch {
    state = { runs: {} };
  }
  for (const [id, run] of Object.entries(state.runs)) {
    if (Date.now() - Number(run.submittedAt || 0) > STATE_MAX_AGE_MS) delete state.runs[id];
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(settings.statePath), { recursive: true });
    const tmp = `${settings.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, settings.statePath);
  } catch (e) {
    warnOnce('state', `cannot write the state file ${settings.statePath}: ${e.message}`);
  }
}

function itemKey(msg) {
  return `${msg.file?.['@rid']}|${msg.process?.['@rid'] || msg.set_process || ''}`;
}


// ---- adapter interface ----------------------------------------------------------------------

/**
 * Called by index.mjs with the provider block of CONFIG_JSON_PATH. The fourth argument is for tests:
 * { firecrest, s3 } for service mode, { firecrestFor(creds), s3For(cfg, keys) } for user mode.
 */
export function configure(provider = {}, descriptor = null, _serviceUrl = null, injected = null) {
  const userMode = descriptor?.api_key_source === 'user';
  settings = normalizeSettings(provider, process.env, { userMode });
  topic = descriptor?.id || 'md-roihu';

  const configDir = process.env.CONFIG_JSON_PATH ? path.dirname(path.resolve(process.cwd(), process.env.CONFIG_JSON_PATH)) : process.cwd();
  const read = (file, what) => {
    try {
      return fs.readFileSync(path.resolve(configDir, file), 'utf8');
    } catch (e) {
      throw new Error(`roihu: cannot read the ${what} ${path.resolve(configDir, file)}: ${e.message}`);
    }
  };
  template = read(settings.script, 'job script');
  setupTemplate = settings.setupScript && settings.autoSetup ? read(settings.setupScript, 'setup script') : '';

  if (userMode) {
    shared = null;
    factory = injected?.firecrestFor ? injected : {
      firecrestFor: (creds, cfg) => createFirecrest({ url: settings.firecrestUrl, system: settings.system, account: cfg.account, token: tokenFromValue(creds.token) }),
      s3For: (cfg, keys) => createS3({ accessKey: keys.accessKey, secretKey: keys.secretKey, bucket: cfg.bucket, endpoint: settings.endpoint }),
    };
  } else {
    factory = null;
    shared = injected?.firecrest ? injected : {
      firecrest: createFirecrest({ url: settings.firecrestUrl, system: settings.system, account: settings.account, token: tokenFromEnv() }),
      s3: createS3({ accessKey: process.env.ALLAS_ACCESS_KEY, secretKey: process.env.ALLAS_SECRET_KEY, bucket: settings.bucket, endpoint: settings.endpoint }),
    };
  }
  loadState();
  log(userMode
    ? `${topic}: every run brings its own credentials; ${settings.system} partition ${settings.partition}, up to ${settings.maxPages} pages per Slurm job`
    : `${topic}: ${settings.system} partition ${settings.partition}, account ${settings.account}, Allas bucket ${settings.bucket}, up to ${settings.maxPages} pages per Slurm job`);
}

/** Checks the token, Allas and the installation on Roihu before the consumer registers itself (service mode only). */
export async function preflight() {
  if (!shared) return;
  const info = await shared.firecrest.userinfo();
  log(`FirecREST ok, user ${info?.user?.name || info?.user || '?'}`);
  await shared.s3.ensureBucket();
  log(`Allas bucket ${settings.bucket} ok`);
  const names = await shared.firecrest.list(settings.remoteRoot);
  if (names === null) log(`WARN: ${settings.remoteRoot} does not exist on Roihu yet: it is installed on the first run (or run the setup, see MD-roihu-slurm README)`);
}

/** How many queue jobs index.mjs may hold at once: a whole chunk waits for its Slurm job. */
export function maxConcurrentJobs() {
  return settings ? settings.maxClaimed : 1;
}

/** index.mjs saw that the backend no longer lists this job as ours (the batch was cancelled). */
export function jobLost(jobId) {
  const item = itemsByJob.get(jobId);
  if (!item || item.done) return;
  log(`job ${jobId} was cancelled`);
  item.lost = true;
  finishItem(item);
  item.resolve();
  const group = item.group;
  if (group && group.items.includes(item)) {
    group.items = group.items.filter((other) => other !== item);
    if (!group.items.length) {
      clearTimeout(group.timer);
      if (groups.get(group.key) === group) groups.delete(group.key);
    }
  }
  if (item.run) item.run.items.delete(item.id);
}

export async function process_msg(_serviceUrl, message) {
  if (!settings) throw new Error('roihu adapter is not configured (it needs CONFIG_JSON_PATH)');
  let msg;
  try {
    msg = message.json();
  } catch (e) {
    await sendError({}, { error: 'invalid message payload!' }, MD_URL);
    return;
  }
  if (!msg.file?.['@rid']) throw new Error('No file found in message');

  const extension = String(msg.file.extension || path.extname(msg.file.label || '')).replace('.', '').toLowerCase();
  if (!settings.formats.includes(extension)) {
    await sendError(msg, new Error(`${topic} reads ${settings.formats.join(', ')} files, not ${extension || 'this file type'}`), MD_URL);
    return;
  }

  await new Promise((resolve, reject) => {
    const item = { msg, jobId: message.jobId, extension, startedAt: process.hrtime(), resolve, reject, done: false, lost: false, key: itemKey(msg) };
    if (item.jobId !== undefined) itemsByJob.set(item.jobId, item);
    enqueue(item);
  });
}

function finishItem(item) {
  item.done = true;
  if (item.jobId !== undefined) itemsByJob.delete(item.jobId);
}

function succeed(item) {
  if (item.done) return;
  finishItem(item);
  item.resolve();
}

function fail(item, error) {
  if (item.done) return;
  finishItem(item);
  item.reject(error instanceof Error ? error : new Error(String(error)));
}


// ---- grouping: the jobs of one process become one Slurm job ---------------------------------

function enqueue(item) {
  const key = groupKey(item.msg);
  let group = groups.get(key);
  if (!group) {
    group = { key, items: [], timer: null };
    groups.set(key, group);
  }
  group.items.push(item);
  item.group = group;

  // a batch says how many jobs it has (total_files): when all have arrived nothing more will join
  const total = Number(item.msg.total_files || 0);
  let batchComplete = false;
  if (total > 0) {
    const count = (received.get(key) || 0) + 1;
    received.set(key, count);
    batchComplete = count >= total;
    if (batchComplete) received.delete(key);
  }

  clearTimeout(group.timer);
  if (batchComplete || group.items.length >= settings.maxPages) {
    flush(group);
  } else {
    group.timer = setTimeout(() => flush(group), settings.gatherMs);
  }
}

function flush(group) {
  clearTimeout(group.timer);
  if (groups.get(group.key) === group) groups.delete(group.key);
  const items = group.items.filter((item) => !item.done);
  group.items = [];
  if (!items.length) return;
  startRun(items).catch((error) => failStart(items, error));
}

/**
 * A run that could not start. What a retry cannot fix (bad credentials, a refused job) is reported to
 * MessyDesk once per file and the queue jobs are done; anything else goes back to the queue.
 */
async function failStart(items, error) {
  log(`could not start a run for ${items.length} file(s): ${error.message}`);
  if (!(error instanceof PermanentError)) {
    for (const item of items) fail(item, error);
    return;
  }
  await mapLimit(items, 8, async (item) => {
    if (item.done) return;
    await sendError(item.msg, error, MD_URL);
    succeed(item);
  });
}


// ---- whose run is it ------------------------------------------------------------------------

/** A request FirecREST or Allas answered with 401/403 means the user's credentials are wrong. */
function refusal(error, what, hint) {
  if (error instanceof TokenError) return new CredentialsError(`${error.message}. Start the run again.`);
  if ([401, 403].includes(error?.statusCode)) return new CredentialsError(`${what} refused the credentials (HTTP ${error.statusCode}). ${hint}`);
  return error;
}

/**
 * The Allas keys of the user's project, read from the rclone.conf that allas-conf wrote in their
 * Roihu home. They stay in this process's memory; the file is read with the user's own token.
 */
async function allasKeysOf(firecrest, info, creds) {
  const user = info?.user?.name;
  if (!user) throw new CredentialsError('FirecREST did not say who you are, so the Allas keys cannot be read from your Roihu account.');
  const confPath = `${settings.homeTemplate.replace('{user}', user)}/.config/rclone/rclone.conf`;
  let text;
  try {
    text = await firecrest.view(confPath);
  } catch (error) {
    throw refusal(error, 'FirecREST', `It would not read ${confPath}, where your Allas keys are.`);
  }
  if (text === null) {
    throw new CredentialsError(`There is no ${confPath} on Roihu. Log in to Roihu and run "module load allas; allas-conf ${creds.allasProject}" once, then start the run again.`);
  }
  return allasKeysFromConf(text, creds.allasProject, confPath);
}

/** What the run of these files needs: clients, account, directory, bucket and the rclone remote's definition. */
async function contextFor(items) {
  if (!settings.userMode) {
    sharedBucketReady = sharedBucketReady || shared.s3.ensureBucket().catch((e) => {
      sharedBucketReady = null;
      throw e;
    });
    await sharedBucketReady;
    return { deps: shared, cfg: runConfig(settings) };
  }

  const msg = items[0].msg;
  const ref = msg.task?.secret_ref;
  if (!ref) throw new CredentialsError('This run has no credentials. Start it again from the MessyDesk page and fill in the form.');
  const raw = await getApiKey(MD_URL, ref, msg.userId, topic);
  if (!raw) throw new CredentialsError('Your credentials are no longer available in MessyDesk (it was restarted, or the run waited too long). Start the run again and fill in the form.');
  const creds = decodeCredentials(raw);
  const cfg = runConfig(settings, creds);

  const firecrest = factory.firecrestFor(creds, cfg);
  let info;
  try {
    info = await firecrest.userinfo();
  } catch (error) {
    throw refusal(error, 'FirecREST', 'Create a new token at https://my.csc.fi/firecrest-token and start the run again.');
  }
  // The keys are the user's own, from allas-conf on Roihu. The consumer needs them to reach Allas from
  // outside CSC; the job on Roihu reads the same rclone.conf and gets no copy of them.
  const keys = await allasKeysOf(firecrest, info, creds);

  const s3 = factory.s3For(cfg, keys);
  try {
    await s3.ensureBucket();
  } catch (error) {
    if ([401, 403].includes(error?.statusCode)) throw new CredentialsError(`${error.message}. Check the Allas keys, and that Allas is enabled for ${creds.allasProject}.`);
    throw error;
  }
  return { deps: { firecrest, s3 }, cfg };
}


// ---- runs ----------------------------------------------------------------------------------

/** The Slurm job that already exists for a file (after a restart), when it can still deliver. */
async function reattachable(item, ctx) {
  for (const [runId, saved] of Object.entries(state.runs)) {
    const id = Object.keys(saved.items).find((pid) => saved.items[pid] === item.key);
    if (!id) continue;
    if (liveRuns.has(runId)) return { run: liveRuns.get(runId), id };
    try {
      const info = await ctx.deps.firecrest.jobInfo(saved.slurmJobId);
      const hasStatus = (await ctx.deps.s3.getText(`${saved.prefix}/out/status.json`)) !== null;
      if (info.state === 'UNKNOWN' ? hasStatus : (!info.terminal || info.state === 'COMPLETED')) {
        const run = { id: runId, prefix: saved.prefix, workdir: saved.workdir, slurmJobId: saved.slurmJobId, items: new Map(), submittedAt: saved.submittedAt, limitMs: saved.limitMs, deps: ctx.deps, cfg: ctx.cfg };
        liveRuns.set(runId, run);
        log(`${runId}: joined Slurm job ${run.slurmJobId} that was started before (${info.state})`);
        watchRun(run);
        return { run, id };
      }
    } catch (e) {
      // cannot tell (token, network): start again rather than wait on a job that may be gone
      warnOnce('reattach', `cannot check Slurm job ${saved.slurmJobId}: ${e.message}`);
    }
    // this run cannot deliver any more, for none of its files
    delete state.runs[runId];
    saveState();
  }
  return null;
}

async function inputFile(item) {
  const local = mdRoot() ? resolveMdPath(item.msg.file.path) : null;
  if (local) return { path: local, temporary: false };
  return { path: await getFile(MD_URL, item.msg.file['@rid'], item.msg.userId), temporary: true };
}

async function startRun(items) {
  const ctx = await contextFor(items);
  const fresh = [];
  for (const item of items) {
    if (item.lost || item.done) continue;
    const found = await reattachable(item, ctx);
    if (found) {
      item.id = found.id;
      item.run = found.run;
      found.run.items.set(item.id, item);
    } else {
      fresh.push(item);
    }
  }
  if (!fresh.length) return;

  const runId = `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${uuidv4().slice(0, 6)}`;
  const run = {
    id: runId,
    prefix: `${topic}/${runId}`,
    workdir: `${ctx.cfg.remoteRoot}/jobs/${runId}`,
    items: new Map(),
    submittedAt: Date.now(),
    deps: ctx.deps,
    cfg: ctx.cfg,
  };
  fresh.forEach((item, index) => {
    item.id = pageId(index);
    item.run = run;
    run.items.set(item.id, item);
  });

  await ensureInstalled(run);
  const submitted = await stageRun(run, fresh);
  if (!submitted) return;
  run.slurmJobId = submitted.slurmJobId;
  run.limitMs = submitted.limitMs;
  run.submittedAt = Date.now();
  liveRuns.set(run.id, run);
  state.runs[run.id] = {
    system: settings.system,
    slurmJobId: run.slurmJobId,
    prefix: run.prefix,
    workdir: run.workdir,
    submittedAt: run.submittedAt,
    limitMs: run.limitMs,
    items: Object.fromEntries(submitted.pages.map((item) => [item.id, item.key])),
  };
  saveState();
  log(`${run.id}: Slurm job ${run.slurmJobId} on ${settings.system}/${settings.partition}, ${submitted.pages.length} page(s), time limit ${submitted.limit}`);
  watchRun(run);
}

/** Uploads the pages of a run to Allas and submits its Slurm job. Resolves to null when every page was cancelled meanwhile. */
async function stageRun(run, fresh) {
  const { firecrest, s3 } = run.deps;
  try {
    log(`${run.id}: ${fresh.length} page(s): uploading to Allas`);
    await mapLimit(fresh, settings.uploadConcurrency, async (item) => {
      if (item.lost || item.done) return;
      const input = await inputFile(item);
      try {
        await s3.putFile(`${run.prefix}/in/${item.id}.${item.extension}`, input.path);
      } finally {
        if (input.temporary) fs.promises.rm(input.path, { force: true }).catch(() => {});
      }
    });

    // An expired token must not fail the pages of a consumer-wide account: they stay claimed until a
    // new token is in place. A user's token cannot be replaced, so there it is reported.
    const submitted = await whenTokenValid(async () => {
      const pages = fresh.filter((item) => !item.lost && !item.done);
      if (!pages.length) return null;
      const cfg = { ...settings, account: run.cfg.account };
      const limit = timeLimit(pages.length, settings);
      const limitMs = timeLimitSeconds(limit) * 1000;
      const script = renderTemplate(template, {
        SBATCH: sbatchBlock(cfg, pages.length),
        ENV: envBlock(settings.pipelineEnv, pages[0].msg.task?.params),
        ROOT: run.cfg.remoteRoot,
        REMOTE: run.cfg.rcloneRemote,
        BUCKET: run.cfg.bucket,
        PREFIX: run.prefix,
        RUN_ID: run.id,
        PAGES: String(pages.length),
      });
      await firecrest.mkdir(run.workdir);
      const slurmJobId = await firecrest.submit({ script, workingDirectory: run.workdir }).catch((error) => {
        if ([400, 401, 403, 422].includes(error.statusCode)) throw new PermanentError(`Roihu refused the job: ${error.message}`);
        throw error;
      });
      return { pages, limit, limitMs, slurmJobId };
    });
    if (!submitted) await s3.deletePrefix(`${run.prefix}/`);
    return submitted;
  } catch (error) {
    // no Slurm job will use what was uploaded
    await s3.deletePrefix(`${run.prefix}/`).catch(() => {});
    throw error;
  }
}

async function whenTokenValid(fn) {
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      if (settings.userMode) throw new CredentialsError(`${error.message}. Start the run again.`);
      warnOnce('token', `${error.message}; waiting for a new token (the pages stay queued)`);
      await sleep(settings.tokenRetryMs);
    }
  }
}


// ---- the installation on Roihu (environment and models) -------------------------------------

async function isInstalled(run) {
  const names = await run.deps.firecrest.list(run.cfg.remoteRoot);
  if (!names) return false;
  // the marker of the setup script, or an installation made by hand before there was one
  return names.includes(settings.setupMarker) || (names.includes('models') && names.some((name) => name.startsWith('venv')));
}

/** Installs the pipeline in the user's project on the first run: one setup job per Roihu directory. */
async function ensureInstalled(run) {
  if (!setupTemplate) return;
  if (await isInstalled(run)) return;
  const key = `${run.cfg.account}|${run.cfg.remoteRoot}`;
  let pending = setups.get(key);
  if (!pending) {
    pending = runSetup(run).finally(() => setups.delete(key));
    setups.set(key, pending);
  }
  await pending;
}

async function runSetup(run) {
  const { firecrest } = run.deps;
  const root = run.cfg.remoteRoot;
  log(`${root} is not installed: running the setup job on ${settings.system} (a few minutes, once for this project)`);
  const workdir = `${root}/jobs/setup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const limitSeconds = 40 * 60;
  const script = renderTemplate(setupTemplate, {
    SBATCH: sbatchBlock({ ...settings, account: run.cfg.account, startupSeconds: limitSeconds, secondsPerPage: 0 }, 0, 'md-roihu-setup'),
    ENV: envBlock(settings.pipelineEnv),
    ROOT: root,
  });
  const jobId = await whenTokenValid(async () => {
    await firecrest.mkdir(workdir);
    return firecrest.submit({ script, workingDirectory: workdir }).catch((error) => {
      if ([400, 401, 403, 422].includes(error.statusCode)) throw new PermanentError(`Roihu refused the setup job: ${error.message}`);
      throw error;
    });
  });

  const deadline = Date.now() + (settings.maxQueueHours * 3600 + limitSeconds) * 1000;
  let info = { state: 'UNKNOWN', terminal: false };
  while (!info.terminal) {
    await sleep(settings.pollMs);
    try {
      info = await firecrest.jobInfo(jobId);
    } catch (error) {
      warnOnce(`setup-${jobId}`, `cannot read the state of the setup job ${jobId}: ${error.message}`);
    }
    if (!info.terminal && Date.now() > deadline) {
      await firecrest.cancel(jobId).catch(() => {});
      throw new PermanentError(`The setup job ${jobId} on Roihu did not finish in time and was cancelled.`);
    }
  }
  if (await isInstalled(run)) {
    log(`${root}: installed`);
    return;
  }
  let tail = '';
  try {
    const text = await firecrest.view(`${workdir}/slurm-${jobId}.out`);
    if (text) tail = ` Last lines of its log: ${text.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`;
  } catch {
    // the log is a bonus
  }
  throw new PermanentError(`The setup job ${jobId} on Roihu ended as ${info.state} and the installation in ${root} is not complete.${tail}`);
}


// ---- watching a run -------------------------------------------------------------------------

function forgetRun(run, itemId = null) {
  const saved = state.runs[run.id];
  if (saved) {
    if (itemId) delete saved.items[itemId];
    if (!itemId || !Object.keys(saved.items).length) delete state.runs[run.id];
    saveState();
  }
}

async function watchRun(run) {
  if (run.watching) return;
  run.watching = true;
  let lastState = '';
  const deadline = run.submittedAt + settings.maxQueueHours * 3600 * 1000 + (run.limitMs || 0);
  try {
    for (;;) {
      await sleep(settings.pollMs);

      if (run.items.size === 0 && !run.allDelivered) {
        // every page was cancelled: the Slurm job is of no use any more
        await cancelSlurm(run);
        break;
      }

      let info = null;
      try {
        info = await run.deps.firecrest.jobInfo(run.slurmJobId);
        if (info.state !== lastState) {
          log(`${run.id}: Slurm job ${run.slurmJobId} is ${info.state}${info.reason ? ` (${info.reason})` : ''}`);
          lastState = info.state;
        }
      } catch (e) {
        // an expired token blocks only this check: results are fetched from Allas without it
        warnOnce(`job-${run.slurmJobId}`, e instanceof TokenError ? `${e.message}; results already in Allas are still collected` : `cannot read the state of Slurm job ${run.slurmJobId}: ${e.message}`);
      }

      const done = await collect(run, info);
      if (done) break;

      if (Date.now() > deadline) {
        await cancelSlurm(run);
        failRemaining(run, `Slurm job ${run.slurmJobId} did not finish in time and was cancelled`);
        break;
      }
    }
  } catch (error) {
    log(`${run.id}: stopped by an error: ${error.stack || error.message}`);
    failRemaining(run, error);
  } finally {
    liveRuns.delete(run.id);
    forgetRun(run);
    if (!settings.keepData) {
      run.deps.s3.deletePrefix(`${run.prefix}/`).catch((e) => warnOnce('cleanup', `cannot remove ${run.prefix} from Allas: ${e.message}`));
    }
  }
}

async function cancelSlurm(run) {
  try {
    const info = await run.deps.firecrest.jobInfo(run.slurmJobId);
    if (!info.terminal) {
      await run.deps.firecrest.cancel(run.slurmJobId);
      log(`${run.id}: Slurm job ${run.slurmJobId} cancelled`);
    }
  } catch (e) {
    warnOnce(`cancel-${run.slurmJobId}`, `cannot cancel Slurm job ${run.slurmJobId}: ${e.message}`);
  }
}

function failRemaining(run, reason) {
  for (const item of [...run.items.values()]) {
    run.items.delete(item.id);
    fail(item, reason instanceof Error ? reason : new Error(reason));
  }
}

/** One look at Allas: delivers the finished pages and settles the run once the job has ended. Returns true when the run is over. */
async function collect(run, info) {
  const { s3 } = run.deps;
  let listing = await s3.list(`${run.prefix}/out/`);
  await deliverReady(run, listing);
  const statusKey = `${run.prefix}/out/status.json`;
  let status = listing.some((o) => o.key === statusKey) ? parseStatus(await s3.getText(statusKey)) : null;

  // The run is over when the job says it finished, or Slurm says it ended. Even with every page
  // delivered the run stays open until then: cleaning Allas earlier would let the job's last sync refill it.
  if (!status && info?.terminal) {
    // outputs may have arrived between the two calls
    listing = await s3.list(`${run.prefix}/out/`);
    await deliverReady(run, listing);
    status = listing.some((o) => o.key === statusKey) ? parseStatus(await s3.getText(statusKey)) : null;
    if (!status) {
      if (run.items.size) failRemaining(run, new Error(await endedMessage(run, info)));
      return true;
    }
  }
  if (!status) return false;

  await settle(run, status, listing);
  return true;
}

async function endedMessage(run, info) {
  let tail = '';
  try {
    const text = await run.deps.firecrest.view(`${run.workdir}/slurm-${run.slurmJobId}.out`);
    if (text) tail = ` Last lines of the job log: ${text.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`;
  } catch {
    // the log is a bonus
  }
  return `Slurm job ${run.slurmJobId} ended as ${info.state}${info.reason ? ` (${info.reason})` : ''} before all pages were done.${tail}`;
}

/** The job finished its work: what is still missing is empty, failed, or lost. */
async function settle(run, status, listing) {
  const keys = new Set(listing.map((o) => o.key));
  for (const item of [...run.items.values()]) {
    if (status.empty.includes(item.id)) {
      await deliver(run, item, keys, true);
    } else if (status.failed.includes(item.id)) {
      run.items.delete(item.id);
      fail(item, new Error('the model could not process this page'));
    } else {
      run.items.delete(item.id);
      fail(item, new Error(`the Slurm job produced no output for this page${status.rc ? ` (exit code ${status.rc})` : ''}`));
    }
  }
}

async function deliverReady(run, listing) {
  const keys = new Set(listing.map((o) => o.key));
  for (const item of [...run.items.values()]) {
    if (item.done) continue;
    const required = settings.outputs.filter((o) => o.required !== false);
    if (required.every((o) => keys.has(outputKey(run, o, item.id)))) await deliver(run, item, keys, false);
  }
}

async function reportTmpFile(message, tmpName) {
  await got.post(`${MD_URL}/api/nomad/process/files/tmp`, {
    json: tmpName ? { message, tmp_path: tmpName } : { message },
    headers: mdHeaders(),
  }).json();
}

/** Downloads the outputs of one page to data/<db>/tmp and reports them; then the queue job is done. */
async function deliver(run, item, keys, empty) {
  run.items.delete(item.id);
  const planned = settings.outputs
    .map((output) => ({ output, key: outputKey(run, output, item.id) }))
    .filter(({ output, key }) => (empty ? typeof output.on_empty === 'string' : keys.has(key)));
  let sent = 0;
  try {
    const dir = tmpDirFor(item.msg);
    for (let i = 0; i < planned.length; i += 1) {
      const { output, key } = planned[i];
      const name = `roihu_${uuidv4()}.${output.extension}`;
      const partial = path.join(dir, `.${name}.part`);
      if (empty) await fs.promises.writeFile(partial, output.on_empty);
      else await run.deps.s3.getToFile(key, partial);
      await fs.promises.rename(partial, path.join(dir, name));
      const out = { tmpName: name, label: outputLabel(output, item.msg.file.label), extension: output.extension, type: output.type };
      await reportTmpFile(callbackMessage(item.msg, {}, out, i, planned.length, item.startedAt), name);
      sent += 1;
    }
    if (empty) log(`${run.id}: ${item.id} (${item.msg.file.label}) had no text`);
    // nothing to report for this page: tell the backend it is done, as the elg adapter does
    if (planned.length === 0) await sendDone(item.msg, MD_URL);
    forgetRun(run, item.id);
    succeed(item);
  } catch (error) {
    log(`${run.id}: cannot deliver ${item.id}: ${error.message}`);
    if (sent > 0) {
      // some outputs exist: a retry would duplicate them, so record the error instead
      await sendError(item.msg, error, MD_URL);
      succeed(item);
    } else {
      fail(item, error);
    }
  }
  if (run.items.size === 0) run.allDelivered = true;
}

/** For tests: forget everything held in memory. */
export function _reset() {
  for (const group of groups.values()) clearTimeout(group.timer);
  groups.clear();
  received.clear();
  itemsByJob.clear();
  liveRuns.clear();
  setups.clear();
  warned.clear();
  sharedBucketReady = null;
  state = { runs: {} };
}

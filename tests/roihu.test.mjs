// roihu adapter: grouping, Slurm submission, collecting pages from Allas, failures, cancel, restart.
// Everything outside the adapter is faked: FirecREST/Slurm, Allas and the MessyDesk backend. Run: npm test

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { TokenError, tokenExpiry, tokenFromEnv, tokenFromValue, stateName, isTerminalState } from '../src/hpc/firecrest.mjs';
import { encodeCredentials, decodeCredentials, CredentialsError } from '../src/hpc/credentials.mjs';
import { parseRcloneConf, allasKeysFromConf } from '../src/hpc/rclone.mjs';

// MD_URL and MD_PATH are read when the adapter is loaded
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roihu-test-'));
const posts = [];
const vault = new Map(); // secret_ref -> the user's credentials string, as MessyDesk's vault would hold it
const backend = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/queue/secret') {
      if (!vault.has(json.ref)) { res.statusCode = 404; return res.end('{"message":"gone"}'); }
      return res.end(JSON.stringify({ key: vault.get(json.ref) }));
    }
    posts.push({ path: req.url, body: json });
    res.end('{}');
  });
});
await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
process.env.MD_URL = `http://127.0.0.1:${backend.address().port}`;
process.env.MD_PATH = root;
const roihu = await import('../src/adapters/roihu.mjs');

after(() => {
  backend.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 3000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > ms) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}


// ---- fakes ----------------------------------------------------------------------------------

class FakeS3 {
  objects = new Map();
  async ensureBucket() {}
  async putFile(key, file) { this.objects.set(key, fs.readFileSync(file)); }
  async putText(key, text) { this.objects.set(key, Buffer.from(text)); }
  async list(prefix) { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.length })); }
  async getToFile(key, file) { fs.writeFileSync(file, this.objects.get(key)); }
  async getText(key) { return this.objects.has(key) ? this.objects.get(key).toString() : null; }
  async deletePrefix(prefix) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) this.objects.delete(key);
    return keys.length;
  }
}

class FakeCluster {
  submits = [];
  cancels = [];
  states = new Map();
  logs = new Map();
  tokenFailures = 0;
  onSubmit = null;
  installed = true;
  userinfoError = null;
  submitError = null;
  viewed = [];
  async userinfo() {
    if (this.userinfoError) throw this.userinfoError;
    return { user: { id: '1', name: 'jdoe' } };
  }
  async list() { return this.installed ? ['venv-aarch64-gpu', 'models'] : null; }
  async mkdir() {}
  async submit({ script, workingDirectory }) {
    if (this.submitError) throw this.submitError;
    if (this.tokenFailures > 0) {
      this.tokenFailures -= 1;
      throw new TokenError('the FirecREST token has expired');
    }
    const id = String(1000 + this.submits.length);
    this.submits.push({ id, script, workingDirectory });
    this.states.set(id, { state: 'RUNNING', terminal: false });
    this.onSubmit?.(id, script, workingDirectory);
    return id;
  }
  async jobInfo(id) { return this.states.get(id) || { state: 'UNKNOWN', terminal: false }; }
  async cancel(id) {
    this.cancels.push(id);
    this.states.set(id, { state: 'CANCELLED', terminal: true });
  }
  async view(file) {
    this.viewed.push(file);
    return this.logs.get(file) ?? null;
  }
}

const OUTPUTS = [
  { path: 'page/{id}.xml', label: '{stem}.page.xml', extension: 'xml', type: 'xml' },
  { path: 'txt/{id}.txt', label: '{stem}.txt', extension: 'txt', type: 'text', on_empty: '' },
];
const scriptPath = path.join(root, 'job.sh');
fs.writeFileSync(scriptPath, '#!/bin/bash -l\n{{SBATCH}}\n{{ENV}}\nPREFIX={{PREFIX}}\nPAGES={{PAGES}}\nRUN={{RUN_ID}}\nB={{REMOTE}}:{{BUCKET}}\n');

const statePath = path.join(root, 'state.json');
function provider(extra = {}) {
  return {
    account: 'project_1',
    remote_root: '/scratch/p/x',
    partition: 'gpumedium',
    state_path: statePath,
    pipeline: { script: scriptPath, env: { NAFREC_OPTIONS: '--a 1' }, outputs: OUTPUTS },
    batching: { gather_seconds: 0.05, poll_seconds: 0.03, token_retry_seconds: 0.03 },
    ...extra,
  };
}

let s3;
let cluster;
let counter = 0;
function setup(extra = {}, savedState = null, configure = true) {
  roihu._reset();
  posts.length = 0;
  vault.clear();
  fs.rmSync(statePath, { force: true });
  if (savedState) fs.writeFileSync(statePath, JSON.stringify(savedState));
  s3 = new FakeS3();
  cluster = new FakeCluster();
  if (configure) roihu.configure(provider(extra), { id: 'md-roihu' }, null, { firecrest: cluster, s3 });
}
beforeEach(() => setup());

function makeMsg(name, { total = 0, processRid = '#1:1' } = {}) {
  const rel = `data/testdb/files/${name}`;
  fs.mkdirSync(path.join(root, 'data/testdb/files'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), `bytes of ${name}`);
  counter += 1;
  return {
    userId: 'u@example.com',
    file: { '@rid': `#9:${counter}`, label: name, extension: path.extname(name).slice(1), type: 'image', path: rel },
    process: { '@rid': processRid },
    set_process: processRid,
    output_set: '#5:1',
    total_files: total,
    current_file: 1,
    task: { id: 'htr', params: {} },
  };
}

const run = (msg, jobId) => roihu.process_msg('provider', { json: () => msg, jobId });

// ---- user mode: every run brings its own credentials ----
const jwt = (secondsFromNow) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url')}.s`;
const TOKEN = jwt(3600);
const CONF = '[s3allas]\ntype = s3\naccess_key_id = AKdefault\nsecret_access_key = SKdefault\n\n[s3allas-project_77]\ntype = s3\nprovider = Other\naccess_key_id = AK77\nsecret_access_key = SK77\nendpoint = a3s.fi\n\n[s3allas-project_5]\ntype = s3\naccess_key_id = AK5\nsecret_access_key = SK5\n';
const CONF_PATH = '/users/jdoe/.config/rclone/rclone.conf';
let made; // what the factory was asked for
let refCounter = 0;

function setupUser(extra = {}, installed = true) {
  setup({ remote_root: '/scratch/{project}/messydesk/x', ...extra }, null, false);
  made = { firecrest: [], s3: [], s3ensure: null };
  cluster.installed = installed;
  s3.ensureBucket = async () => { if (made.s3ensure) throw made.s3ensure; };
  roihu._reset();
  roihu.configure(provider({ remote_root: '/scratch/{project}/messydesk/x', ...extra }), { id: 'md-roihu', api_key_source: 'user' }, null, {
    firecrestFor: (creds, cfg) => { made.firecrest.push({ creds, cfg }); return cluster; },
    s3For: (cfg, keys) => { made.s3.push({ cfg, keys }); return s3; },
  });
}

/** A message whose task carries the ref of credentials in the vault. */
function userMsg(name, credentials, opts = {}) {
  const msg = makeMsg(name, { total: opts.total ?? 1 });
  refCounter += 1;
  msg.task.secret_ref = `ref-${refCounter}`;
  if (credentials !== null) vault.set(msg.task.secret_ref, credentials);
  return msg;
}
const creds = (values = {}) => encodeCredentials({ token: TOKEN, project: 'project_77', ...values });
const sentErrors = () => posts.filter((p) => p.path.endsWith('/files/error'));
const prefixOf = (script) => /PREFIX=(\S+)/.exec(script)[1];

/** A Slurm job that finishes pages: `pages` are done, the rest is described by `status`. */
function job({ done = [], status = { finished: true, rc: 0, empty: [], failed: [] }, state = 'COMPLETED', delay = 60 } = {}) {
  cluster.onSubmit = (id, script) => {
    const prefix = prefixOf(script);
    setTimeout(async () => {
      for (const p of done) {
        await s3.putText(`${prefix}/out/page/${p}.xml`, `<xml ${p}/>`);
        await s3.putText(`${prefix}/out/txt/${p}.txt`, `text of ${p}\n`);
      }
      if (status) await s3.putText(`${prefix}/out/status.json`, JSON.stringify(status));
      cluster.states.set(id, { state, terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(state), reason: state === 'FAILED' ? 'OutOfMemory' : '' });
    }, delay);
  };
}

const tmpFiles = () => fs.readdirSync(path.join(root, 'data/testdb/tmp')).filter((n) => !n.startsWith('.'));
const callbacks = () => posts.filter((p) => p.path.endsWith('/files/tmp'));


// ---- pure helpers ---------------------------------------------------------------------------

test('settings: defaults, and what is required', () => {
  const s = roihu.normalizeSettings(provider(), {});
  assert.equal(s.system, 'gpu');
  assert.equal(s.gres, 'gpu:gh200:1');
  assert.equal(s.maxPages, 300);
  assert.equal(s.maxClaimed, 600);
  assert.equal(s.rcloneRemote, 's3allas-project_1');
  assert.equal(s.bucket, 'project-1-md-roihu', 'no underscore in a bucket name');
  assert.equal(roihu.normalizeSettings(provider(), { FIRECREST_ACCOUNT: 'project_7', ALLAS_BUCKET: 'mine' }).account, 'project_7');
  assert.throws(() => roihu.normalizeSettings({ ...provider(), account: undefined }, {}), /account/);
  assert.throws(() => roihu.normalizeSettings({ ...provider(), remote_root: undefined }, {}), /remote_root/);
  assert.throws(() => roihu.normalizeSettings({ ...provider(), pipeline: { script: 'x' } }, {}), /outputs/);
});

test('time limit: start-up plus pages with a margin, 20 minutes to 36 hours', () => {
  const cfg = { startupSeconds: 600, secondsPerPage: 2 };
  assert.equal(roihu.timeLimit(1, cfg), '00:20:00');
  assert.equal(roihu.timeLimit(300, cfg), '00:25:00');
  assert.equal(roihu.timeLimit(100000, cfg), '36:00:00');
  assert.equal(roihu.timeLimitSeconds('01:30:00'), 5400);
});

test('page ids, group keys, labels and status files', () => {
  assert.equal(roihu.pageId(0), 'p0001');
  assert.equal(roihu.pageId(1234), 'p1235');
  assert.equal(roihu.groupKey({ set_process: '#1:2', process: { '@rid': '#1:9' } }), '#1:2');
  assert.equal(roihu.groupKey({ process: { '@rid': '#1:9' } }), '#1:9');
  assert.equal(roihu.groupKey({ file: { '@rid': '#3:3' } }), '#3:3');
  assert.equal(roihu.outputLabel(OUTPUTS[0], 'book.p1.png'), 'book.p1.page.xml');
  assert.deepEqual(roihu.parseStatus('{"finished":true,"rc":0,"empty":["p0003"]}'), { finished: true, empty: ['p0003'], failed: [], rc: 0 });
  assert.equal(roihu.parseStatus('not json'), null);
});

test('template: unknown placeholders are errors; env values are quoted, parameters never expand', () => {
  assert.equal(roihu.renderTemplate('a {{X}} b', { X: '1' }), 'a 1 b');
  assert.throws(() => roihu.renderTemplate('{{TYPO}}', { X: '1' }), /TYPO/);
  assert.equal(roihu.renderTemplate('{{...}} stays', {}), '{{...}} stays');
  const block = roihu.envBlock({ A: '$ROOT/venv', B: 'say "hi"' }, { model: "x'; rm -rf ~; '", n: 3, skip: { a: 1 } });
  assert.match(block, /^export A="\$ROOT\/venv"$/m);
  assert.match(block, /^export B="say \\"hi\\""$/m);
  assert.match(block, /^export PARAM_MODEL='x'\\''; rm -rf ~; '\\'''$/m);
  assert.match(block, /^export PARAM_N='3'$/m);
  assert.doesNotMatch(block, /SKIP/);
});

test('real job script template of MD-roihu-slurm renders without leftovers', { skip: !fs.existsSync(path.resolve('../MD-roihu-slurm/pipelines/nafrec/job.sh')) }, () => {
  const text = fs.readFileSync(path.resolve('../MD-roihu-slurm/pipelines/nafrec/job.sh'), 'utf8');
  const s = roihu.normalizeSettings(provider(), {});
  const out = roihu.renderTemplate(text, {
    SBATCH: roihu.sbatchBlock(s, 10), ENV: roihu.envBlock(s.pipelineEnv), ROOT: s.remoteRoot, REMOTE: s.rcloneRemote,
    BUCKET: s.bucket, PREFIX: 'md-roihu/run-1', RUN_ID: 'run-1', PAGES: '10',
  });
  assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/);
  assert.match(out, /#SBATCH --account=project_1/);
  assert.match(out, /s3allas-project_1:project-1-md-roihu\/md-roihu\/run-1/);
});

test('real setup script of MD-roihu-slurm renders without leftovers', { skip: !fs.existsSync(path.resolve('../MD-roihu-slurm/pipelines/nafrec/setup.sh')) }, () => {
  const text = fs.readFileSync(path.resolve('../MD-roihu-slurm/pipelines/nafrec/setup.sh'), 'utf8');
  const s = roihu.normalizeSettings(provider(), {});
  const out = roihu.renderTemplate(text, { SBATCH: roihu.sbatchBlock({ ...s, startupSeconds: 2400, secondsPerPage: 0 }, 0, 'md-roihu-setup'), ENV: roihu.envBlock(s.pipelineEnv), ROOT: s.remoteRoot });
  assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/);
  assert.match(out, /^#SBATCH --time=00:40:00$/m);
  assert.match(out, /^#SBATCH --job-name=md-roihu-setup$/m);
});

test('FirecREST: token expiry, states', () => {
  const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
  assert.equal(tokenExpiry(jwt(123)), 123);
  assert.equal(tokenExpiry('garbage'), null);
  const future = jwt(Math.floor(Date.now() / 1000) + 3600);
  assert.equal(tokenFromEnv({ FIRECREST_TOKEN: future })(), future);
  assert.throws(() => tokenFromEnv({ FIRECREST_TOKEN: jwt(1) })(), TokenError);
  assert.throws(() => tokenFromEnv({})(), /no FirecREST token/);
  const file = path.join(root, 'token.txt');
  fs.writeFileSync(file, `${future}\n`);
  assert.equal(tokenFromEnv({ FIRECREST_TOKEN_FILE: file })(), future);
  fs.writeFileSync(file, `${jwt(1)}\n`);
  assert.throws(() => tokenFromEnv({ FIRECREST_TOKEN_FILE: file })(), TokenError, 'the file is read again every time');
  assert.equal(stateName('CANCELLED by 123'), 'CANCELLED');
  assert.equal(stateName(['RUNNING']), 'RUNNING');
  assert.ok(isTerminalState('COMPLETED'));
  assert.ok(isTerminalState('FAILED'));
  assert.ok(!isTerminalState('PENDING'));
  assert.ok(!isTerminalState('RUNNING'));
  assert.ok(!isTerminalState(''));
});


// ---- runs -----------------------------------------------------------------------------------

test('a set becomes one Slurm job; pages are reported as they finish; empty pages give an empty text', async () => {
  const msgs = ['a.png', 'b.png', 'c.png'].map((name) => makeMsg(name, { total: 3 }));
  job({ done: ['p0001', 'p0002'], status: { finished: true, rc: 0, empty: ['p0003'], failed: [] } });

  await Promise.all(msgs.map((m, i) => run(m, 100 + i)));

  assert.equal(cluster.submits.length, 1, 'three jobs, one Slurm job');
  const { script, workingDirectory } = cluster.submits[0];
  assert.match(script, /^#SBATCH --account=project_1$/m);
  assert.match(script, /^#SBATCH --partition=gpumedium$/m);
  assert.match(script, /^#SBATCH --gres=gpu:gh200:1$/m);
  assert.match(script, /^#SBATCH --time=00:20:00$/m);
  assert.match(script, /^export NAFREC_OPTIONS="--a 1"$/m);
  assert.match(script, /^PAGES=3$/m);
  assert.match(script, /^B=s3allas-project_1:project-1-md-roihu$/m);
  assert.match(workingDirectory, /^\/scratch\/p\/x\/jobs\/run-/);

  const labels = callbacks().map((p) => p.body.message.file.label).sort();
  assert.deepEqual(labels, ['a.page.xml', 'a.txt', 'b.page.xml', 'b.txt', 'c.txt']);
  const byLabel = Object.fromEntries(callbacks().map((p) => [p.body.message.file.label, p.body]));
  assert.equal(byLabel['a.page.xml'].message.file.type, 'xml');
  assert.equal(byLabel['a.txt'].message.file.type, 'text');
  assert.equal(byLabel['a.txt'].message.file.source['@rid'], msgs[0].file['@rid'], 'derived from the input');
  assert.equal(byLabel['a.txt'].message.file_total, 2);
  assert.equal(byLabel['c.txt'].message.file_total, 1, 'an empty page has the text only');
  for (const call of callbacks()) assert.ok(fs.existsSync(path.join(root, 'data/testdb/tmp', call.body.tmp_path)), 'the file is in tmp for the backend');
  assert.equal(fs.readFileSync(path.join(root, 'data/testdb/tmp', byLabel['a.txt'].tmp_path), 'utf8'), 'text of p0001\n');
  assert.equal(fs.statSync(path.join(root, 'data/testdb/tmp', byLabel['c.txt'].tmp_path)).size, 0);

  await until(() => s3.objects.size === 0, 'Allas to be cleaned');
  await until(() => Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).runs).length === 0, 'the state to be cleared');
  assert.ok(![...s3.objects.keys()].length);
  assert.ok(tmpFiles().length >= 5);
});

test('the inputs are uploaded under the run prefix with plain ids', async () => {
  const seen = [];
  const original = FakeS3.prototype.putFile;
  setup();
  s3.putFile = async function (key, file) { seen.push([key, fs.readFileSync(file, 'utf8')]); return original.call(this, key, file); };
  const msgs = ['one.png', 'two.jpg'].map((name) => makeMsg(name, { total: 2 }));
  job({ done: ['p0001', 'p0002'] });
  await Promise.all(msgs.map((m, i) => run(m, 200 + i)));
  assert.deepEqual(seen.map(([key]) => key.split('/').slice(-2).join('/')), ['in/p0001.png', 'in/p0002.jpg']);
  assert.deepEqual(seen.map(([, content]) => content), ['bytes of one.png', 'bytes of two.jpg']);
  assert.match(seen[0][0], /^md-roihu\/run-\d{14}-[0-9a-f]{6}\/in\//);
});

test('a page the model failed on is rejected, the others succeed', async () => {
  const msgs = ['a.png', 'b.png'].map((name) => makeMsg(name, { total: 2 }));
  job({ done: ['p0001'], status: { finished: true, rc: 0, empty: [], failed: ['p0002'] } });
  const results = await Promise.allSettled(msgs.map((m, i) => run(m, 300 + i)));
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /could not process this page/);
});

test('a page without output when the job says it finished is rejected with the exit code', async () => {
  const msg = makeMsg('a.png', { total: 1 });
  job({ done: [], status: { finished: true, rc: 3, empty: [], failed: [] } });
  await assert.rejects(run(msg, 400), /no output for this page \(exit code 3\)/);
});

test('a Slurm job that dies without a status rejects every page, with the end of its log', async () => {
  const msgs = ['a.png', 'b.png'].map((name) => makeMsg(name, { total: 2 }));
  cluster.onSubmit = (id, _script, workdir) => {
    cluster.logs.set(`${workdir}/slurm-${id}.out`, 'starting\nCUDA out of memory\n');
    setTimeout(() => cluster.states.set(id, { state: 'FAILED', terminal: true, reason: 'OutOfMemory' }), 60);
  };
  const results = await Promise.allSettled(msgs.map((m, i) => run(m, 500 + i)));
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /ended as FAILED \(OutOfMemory\)/);
    assert.match(result.reason.message, /CUDA out of memory/);
  }
  await until(() => s3.objects.size === 0, 'Allas to be cleaned');
});

test('pages delivered before the job ends are kept; the rest of a dead job is rejected', async () => {
  const msgs = ['a.png', 'b.png'].map((name) => makeMsg(name, { total: 2 }));
  job({ done: ['p0001'], status: null, state: 'TIMEOUT' });
  const results = await Promise.allSettled(msgs.map((m, i) => run(m, 600 + i)));
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /ended as TIMEOUT/);
});

test('jobs of one process that arrive without a total are gathered for a moment', async () => {
  const msgs = ['a.png', 'b.png'].map((name) => makeMsg(name));
  job({ done: ['p0001', 'p0002'] });
  await Promise.all([run(msgs[0], 700), sleep(10).then(() => run(msgs[1], 701))]);
  assert.equal(cluster.submits.length, 1);
  assert.match(cluster.submits[0].script, /^PAGES=2$/m);
});

test('jobs of different processes never share a Slurm job', async () => {
  const a = makeMsg('a.png', { total: 1, processRid: '#1:1' });
  const b = makeMsg('b.png', { total: 1, processRid: '#1:2' });
  job({ done: ['p0001'] });
  await Promise.all([run(a, 800), run(b, 801)]);
  assert.equal(cluster.submits.length, 2);
});

test('a set larger than max_pages is split into several Slurm jobs', async () => {
  setup({ batching: { max_pages: 2, gather_seconds: 0.05, poll_seconds: 0.03 } });
  const msgs = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map((name) => makeMsg(name, { total: 5 }));
  job({ done: ['p0001', 'p0002'], status: { finished: true, rc: 0, empty: ['p0003'], failed: [] } });
  await Promise.allSettled(msgs.map((m, i) => run(m, 900 + i)));
  assert.deepEqual(cluster.submits.map((s) => /PAGES=(\d)/.exec(s.script)[1]).sort(), ['1', '2', '2']);
});

test('a cancelled batch: lost jobs end quietly and the Slurm job is cancelled', async () => {
  const msgs = ['a.png', 'b.png'].map((name) => makeMsg(name, { total: 2 }));
  const pending = msgs.map((m, i) => run(m, 1000 + i));
  await until(() => cluster.submits.length === 1, 'the Slurm job');
  roihu.jobLost(1000);
  roihu.jobLost(1001);
  await Promise.all(pending);
  await until(() => cluster.cancels.length === 1, 'the Slurm job to be cancelled');
  assert.equal(cluster.cancels[0], '1000');
  assert.equal(callbacks().length, 0, 'nothing is reported for cancelled pages');
  await until(() => s3.objects.size === 0, 'Allas to be cleaned');
});

test('a job cancelled while it still waits for its group starts nothing', async () => {
  const msg = makeMsg('a.png');
  const pending = run(msg, 1100);
  roihu.jobLost(1100);
  await pending;
  await sleep(150);
  assert.equal(cluster.submits.length, 0);
});

test('an expired token does not fail the pages: they wait for a new one', async () => {
  cluster.tokenFailures = 2;
  const msg = makeMsg('a.png', { total: 1 });
  job({ done: ['p0001'] });
  await run(msg, 1200);
  assert.equal(cluster.submits.length, 1);
  assert.equal(callbacks().length, 2);
});

test('after a restart a file joins the Slurm job that already exists', async () => {
  const msg = makeMsg('a.png', { total: 1 });
  const prefix = 'md-roihu/run-old';
  setup({}, {
    runs: {
      'run-old': { system: 'gpu', slurmJobId: '777', prefix, workdir: '/scratch/p/x/jobs/run-old', submittedAt: Date.now(), limitMs: 3600000, items: { p0001: `${msg.file['@rid']}|${msg.process['@rid']}` } },
    },
  });
  await s3.putText(`${prefix}/out/page/p0001.xml`, '<xml/>');
  await s3.putText(`${prefix}/out/txt/p0001.txt`, 'from the old job\n');
  await s3.putText(`${prefix}/out/status.json`, JSON.stringify({ finished: true, rc: 0, empty: [], failed: [] }));
  cluster.states.set('777', { state: 'COMPLETED', terminal: true });

  await run(msg, 1300);
  assert.equal(cluster.submits.length, 0, 'no second Slurm job');
  assert.equal(callbacks().length, 2);
});

test('after a restart a file whose Slurm job failed starts again', async () => {
  const msg = makeMsg('a.png', { total: 1 });
  setup({}, {
    runs: {
      'run-old': { system: 'gpu', slurmJobId: '777', prefix: 'md-roihu/run-old', workdir: '/w', submittedAt: Date.now(), limitMs: 1, items: { p0001: `${msg.file['@rid']}|${msg.process['@rid']}` } },
    },
  });
  cluster.states.set('777', { state: 'FAILED', terminal: true });
  job({ done: ['p0001'] });
  await run(msg, 1400);
  assert.equal(cluster.submits.length, 1);
  assert.equal(callbacks().length, 2);
});

test('a file type the model cannot read is reported once and not retried', async () => {
  const msg = makeMsg('anim.gif', { total: 1 });
  await run(msg, 1500);
  assert.equal(cluster.submits.length, 0);
  assert.equal(posts.filter((p) => p.path.endsWith('/error')).length, 1);
  assert.match(JSON.stringify(posts.find((p) => p.path.endsWith('/error')).body), /jpg, jpeg, png, tif, tiff/);
});

test('a failed upload rejects the pages and leaves nothing in Allas', async () => {
  const msgs = ['a.png', 'b.png'].map((name) => makeMsg(name, { total: 2 }));
  const put = s3.putFile.bind(s3);
  let uploads = 0;
  s3.putFile = async (key, file) => {
    uploads += 1;
    if (uploads === 2) throw new Error('Allas is down');
    return put(key, file);
  };
  const results = await Promise.allSettled(msgs.map((m, i) => run(m, 1600 + i)));
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Allas is down/);
  }
  assert.equal(cluster.submits.length, 0, 'no Slurm job for pages that are not in Allas');
  assert.equal(s3.objects.size, 0, 'the page that did upload is removed again');
});

test('a page with nothing to report is still marked done in the backend', async () => {
  setup({ pipeline: { script: scriptPath, env: {}, outputs: [OUTPUTS[0]] } });
  const msg = makeMsg('blank.png', { total: 1 });
  job({ done: [], status: { finished: true, rc: 0, empty: ['p0001'], failed: [] } });
  await run(msg, 1700);
  assert.equal(callbacks().length, 0);
  const done = posts.filter((p) => p.path.endsWith('/files/done'));
  assert.equal(done.length, 1);
  assert.equal(done[0].body.file['@rid'], msg.file['@rid']);
});

test('the consumer may hold as many jobs as a few chunks need', () => {
  assert.equal(roihu.maxConcurrentJobs(), 600);
});


// ---- credentials, keys from Roihu, helpers ---------------------------------------------------

test('credentials: pack, unpack and say what is wrong', () => {
  assert.deepEqual(decodeCredentials(creds()), { token: TOKEN, project: 'project_77', allasProject: 'project_77' });
  assert.equal(decodeCredentials(creds({ allas_project: 'project_5' })).allasProject, 'project_5');
  assert.throws(() => decodeCredentials('plain-key'), CredentialsError);
  assert.throws(() => decodeCredentials('mdcred1.%%%'), /could not be read/);
  assert.throws(() => decodeCredentials(encodeCredentials({ project: 'project_1' })), /token is missing/);
  assert.throws(() => decodeCredentials(encodeCredentials({ token: jwt(-5), project: 'project_1' })), /expired/);
  assert.throws(() => decodeCredentials(encodeCredentials({ token: jwt(60), project: 'project_1' })), /expires within minutes/);
  assert.throws(() => decodeCredentials(encodeCredentials({ token: TOKEN, project: 'my project' })), /not a CSC project/);
  assert.equal(tokenFromValue(TOKEN)(), TOKEN);
  assert.throws(() => tokenFromValue(jwt(-5))(), TokenError);
});

test('rclone.conf: the keys of one Allas project, and a message that names no secret when missing', () => {
  assert.deepEqual(Object.keys(parseRcloneConf(CONF)), ['s3allas', 's3allas-project_77', 's3allas-project_5']);
  assert.deepEqual(allasKeysFromConf(CONF, 'project_77'), { accessKey: 'AK77', secretKey: 'SK77' });
  assert.throws(() => allasKeysFromConf(CONF, 'project_9'), (e) => e instanceof CredentialsError && /s3allas-project_77/.test(e.message) && /allas-conf project_9/.test(e.message) && !/AK77|SK77/.test(e.message));
  assert.throws(() => allasKeysFromConf('', 'project_9'), /allas-conf/);
});

test('run config: what comes from the user\'s project', () => {
  assert.deepEqual(roihu.runConfig({ remoteRootTemplate: '/scratch/{project}/m', bucket: 'b' }, { project: 'project_7', allasProject: 'project_8' }),
    { account: 'project_7', allasProject: 'project_8', remoteRoot: '/scratch/project_7/m', bucket: 'project-8-md-roihu', rcloneRemote: 's3allas-project_8' });
});


// ---- user mode -------------------------------------------------------------------------------

test('user mode: the run uses the user\'s project and the Allas keys read from their Roihu account', async () => {
  setupUser();
  cluster.logs.set(CONF_PATH, CONF);
  const lines = [];
  const originals = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const msgs = ['a.png', 'b.png'].map((n) => userMsg(n, null));
    msgs.forEach((m) => { m.task.secret_ref = 'shared-ref'; m.total_files = 2; });
    vault.set('shared-ref', creds());
    job({ done: ['p0001', 'p0002'] });
    await Promise.all(msgs.map((m, i) => run(m, 2000 + i)));
  } finally {
    Object.assign(console, originals);
  }

  assert.equal(cluster.submits.length, 1);
  const { script, workingDirectory } = cluster.submits[0];
  assert.match(script, /^#SBATCH --account=project_77$/m);
  // read from the user's rclone.conf on Roihu: the job uses that file's remote and gets no copy of the keys
  assert.doesNotMatch(script, /RCLONE|AK77|SK77/);
  assert.match(script, /^B=s3allas-project_77:project-77-md-roihu$/m);
  assert.match(workingDirectory, /^\/scratch\/project_77\/messydesk\/x\/jobs\/run-/);
  assert.deepEqual(cluster.viewed.filter((f) => f === CONF_PATH), [CONF_PATH], 'one read of the user\'s rclone.conf');
  assert.equal(made.firecrest[0].creds.project, 'project_77');
  assert.deepEqual(made.s3[0].keys, { accessKey: 'AK77', secretKey: 'SK77' });
  assert.equal(made.s3[0].cfg.bucket, 'project-77-md-roihu');
  assert.equal(callbacks().length, 4);

  const everything = lines.join('\n') + JSON.stringify(posts);
  for (const secret of ['AK77', 'SK77', TOKEN]) assert.ok(!everything.includes(secret), `${secret.slice(0, 6)}... must not be logged or sent to MessyDesk`);
  assert.ok(!fs.readFileSync(statePath, 'utf8').match(/AK77|SK77|h\./), 'nor written to the state file');
});

test('user mode: an Allas project that is not the Slurm project uses its own keys, bucket and remote', async () => {
  setupUser();
  cluster.logs.set(CONF_PATH, CONF);
  const msg = userMsg('a.png', creds({ allas_project: 'project_5' }));
  job({ done: ['p0001'] });
  await run(msg, 2100);
  assert.deepEqual(made.s3[0].keys, { accessKey: 'AK5', secretKey: 'SK5' });
  assert.match(cluster.submits[0].script, /^B=s3allas-project_5:project-5-md-roihu$/m);
  assert.match(cluster.submits[0].script, /^#SBATCH --account=project_77$/m, 'billing stays on the Slurm project');
  assert.doesNotMatch(cluster.submits[0].script, /AK5|SK5|RCLONE/);
});

test('user mode: what the user can fix is reported once, not retried', async () => {
  const cases = [
    ['an expired token', () => userMsg('a.png', encodeCredentials({ token: jwt(-5), project: 'project_77' })), null, /expired/],
    ['no credentials in the vault', () => userMsg('a.png', null), null, /no longer available in MessyDesk/],
    ['a task without a secret_ref', () => { const m = makeMsg('a.png', { total: 1 }); return m; }, null, /has no credentials/],
    ['a token FirecREST refuses', () => userMsg('a.png', creds()), () => { cluster.userinfoError = Object.assign(new Error('nope'), { statusCode: 401 }); }, /FirecREST refused the credentials \(HTTP 401\)/],
    ['a project without Allas keys in the Roihu account', () => userMsg('a.png', creds()), () => { cluster.logs.set(CONF_PATH, '[s3allas-project_1]\naccess_key_id = x\nsecret_access_key = y\n'); }, /allas-conf project_77/],
    ['no rclone.conf on Roihu at all', () => userMsg('a.png', creds()), null, /There is no \/users\/jdoe\/\.config\/rclone\/rclone\.conf/],
    ['Allas refusing the keys', () => userMsg('a.png', creds()), () => { cluster.logs.set(CONF_PATH, CONF); made.s3ensure = Object.assign(new Error('Allas could not create the bucket (HTTP 403)'), { statusCode: 403 }); }, /Allas is enabled for project_77/],
    ['a job Roihu refuses (bad project)', () => userMsg('a.png', creds()), () => { cluster.logs.set(CONF_PATH, CONF); cluster.submitError = Object.assign(new Error('FirecREST POST failed: Invalid account or account/partition combination specified (HTTP 400)'), { statusCode: 400 }); }, /Roihu refused the job: .*Invalid account/],
    ['a token that expires before the job is submitted', () => userMsg('a.png', creds()), () => { cluster.logs.set(CONF_PATH, CONF); cluster.tokenFailures = 1; }, /expired.*Start the run again/],
  ];
  for (const [what, makeIt, arrange, pattern] of cases) {
    setupUser();
    const msg = makeIt();
    arrange?.();
    await run(msg, 2200); // resolves: the queue job is done
    const errors = sentErrors();
    assert.equal(errors.length, 1, `${what}: one error for the file`);
    assert.match(JSON.stringify(errors[0].body), pattern, what);
    assert.equal(cluster.submits.length, 0, `${what}: nothing submitted`);
    assert.equal(s3.objects.size, 0, `${what}: nothing left in Allas`);
  }
});

test('user mode: a failure that may pass (Allas unreachable) goes back to the queue', async () => {
  setupUser();
  cluster.logs.set(CONF_PATH, CONF);
  made.s3ensure = new Error('connect ETIMEDOUT');
  await assert.rejects(run(userMsg('a.png', creds()), 2300), /ETIMEDOUT/);
  assert.equal(sentErrors().length, 0);
});


// ---- the installation on Roihu ---------------------------------------------------------------

const setupScriptPath = path.join(root, 'setup.sh');
fs.writeFileSync(setupScriptPath, '#!/bin/bash -l\n{{SBATCH}}\n{{ENV}}\nROOT={{ROOT}}\n');
const setupProvider = (extra = {}) => ({ pipeline: { script: scriptPath, setup_script: setupScriptPath, env: {}, outputs: OUTPUTS }, ...extra });

/** A cluster where the setup job installs the pipeline (or fails to) and ordinary jobs finish their pages. */
function installingCluster({ succeed = true } = {}) {
  cluster.installed = false;
  cluster.onSubmit = (id, script, workdir) => {
    if (/--job-name=md-roihu-setup/.test(script)) {
      setTimeout(() => {
        cluster.installed = succeed;
        cluster.logs.set(`${workdir}/slurm-${id}.out`, 'pip install failed\n');
        cluster.states.set(id, { state: succeed ? 'COMPLETED' : 'FAILED', terminal: true });
      }, 40);
      return;
    }
    const prefix = prefixOf(script);
    setTimeout(async () => {
      await s3.putText(`${prefix}/out/page/p0001.xml`, '<xml/>');
      await s3.putText(`${prefix}/out/txt/p0001.txt`, 'text\n');
      await s3.putText(`${prefix}/out/status.json`, JSON.stringify({ finished: true, rc: 0, empty: [], failed: [] }));
      cluster.states.set(id, { state: 'COMPLETED', terminal: true });
    }, 40);
  };
}

test('first run in a project: the setup job runs first, then the pages', async () => {
  setup(setupProvider());
  installingCluster();
  const msg = makeMsg('a.png', { total: 1 });
  await run(msg, 2400);
  assert.equal(cluster.submits.length, 2);
  assert.match(cluster.submits[0].script, /^#SBATCH --job-name=md-roihu-setup$/m);
  assert.match(cluster.submits[0].script, /^#SBATCH --time=00:40:00$/m);
  assert.match(cluster.submits[0].script, /^ROOT=\/scratch\/p\/x$/m);
  assert.match(cluster.submits[1].script, /^PAGES=1$/m);
  assert.equal(callbacks().length, 2);
});

test('an installation that is there is not set up again', async () => {
  setup(setupProvider());
  job({ done: ['p0001'] });
  await run(makeMsg('a.png', { total: 1 }), 2500);
  assert.equal(cluster.submits.length, 1);
  assert.doesNotMatch(cluster.submits[0].script, /md-roihu-setup/);
});

test('two runs for the same project share one setup job', async () => {
  setup(setupProvider());
  installingCluster();
  const a = makeMsg('a.png', { total: 1, processRid: '#1:11' });
  const b = makeMsg('b.png', { total: 1, processRid: '#1:12' });
  await Promise.all([run(a, 2600), run(b, 2601)]);
  const setups = cluster.submits.filter((s) => /md-roihu-setup/.test(s.script));
  assert.equal(setups.length, 1, 'one setup job');
  assert.equal(cluster.submits.length, 3, 'and the two runs');
});

test('a setup job that does not install reports why, with its log, and runs nothing', async () => {
  setup(setupProvider());
  installingCluster({ succeed: false });
  await run(makeMsg('a.png', { total: 1 }), 2700);
  assert.equal(cluster.submits.length, 1, 'only the setup job');
  assert.match(JSON.stringify(sentErrors()[0].body), /setup job .* ended as FAILED.*pip install failed/);
});

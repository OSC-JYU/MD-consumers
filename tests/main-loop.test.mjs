// The consumer's main loop: one job at a time unless the adapter asks for more (maxConcurrentJobs).
// Runs the real src/index.mjs against a mock backend. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const indexPath = path.resolve(here, '../src/index.mjs');

/** Starts the consumer on `jobs` queued jobs; resolves with what the adapter logged and what the backend saw. */
async function runConsumer({ jobs, concurrency }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-loop-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ service: { id: 'md-fixture', tasks: {} }, provider: {} }));
  const logPath = path.join(dir, 'adapter.log');
  fs.writeFileSync(logPath, '');

  const queue = Array.from({ length: jobs }, (_, i) => ({ id: i + 1, queue: 'md-fixture', payload: { n: i + 1 }, attempts: 1, max_attempts: 3 }));
  const completed = [];
  const failed = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/queue/claim') return res.end(JSON.stringify({ job: queue.shift() || null }));
      const done = /^\/api\/queue\/(\d+)\/(complete|fail)$/.exec(req.url);
      if (done) (done[2] === 'complete' ? completed : failed).push(Number(done[1]));
      res.end(JSON.stringify(done?.[2] === 'fail' ? { permanent: false } : {}));
    });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));

  const child = spawn(process.execPath, [indexPath], {
    cwd: dir,
    env: {
      ...process.env,
      TOPIC: 'md-fixture',
      MD_URL: `http://127.0.0.1:${backend.address().port}`,
      CONFIG_JSON_PATH: configPath,
      ADAPTER: '../../tests/fixtures/slow-adapter',
      FIXTURE_LOG: logPath,
      ...(concurrency ? { FIXTURE_CONCURRENCY: String(concurrency) } : {}),
      CONTROL_PORT: '0',
      POLL_MIN_MS: '10',
      POLL_MAX_MS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const started = Date.now();
  while (completed.length < jobs && Date.now() - started < 15000) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill('SIGKILL');
  backend.close();
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { lines, completed, failed, output };
}

const maxInFlight = (lines) => Math.max(...lines.filter((l) => l.startsWith('start')).map((l) => Number(/inFlight=(\d+)/.exec(l)[1])));

test('an adapter without maxConcurrentJobs gets one job at a time, as before', async () => {
  const { lines, completed, failed, output } = await runConsumer({ jobs: 4 });
  assert.deepEqual(completed.sort(), [1, 2, 3, 4], output);
  assert.deepEqual(failed, []);
  assert.equal(maxInFlight(lines), 1);
});

test('an adapter that asks for several jobs gets that many at once, with their job ids', async () => {
  const { lines, completed, failed, output } = await runConsumer({ jobs: 7, concurrency: 3 });
  assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5, 6, 7], output);
  assert.deepEqual(failed, []);
  assert.equal(maxInFlight(lines), 3, 'three at once, never more');
  assert.ok(lines.includes('start 1 jobId=1 inFlight=1'), 'the message carries the queue job id');
});

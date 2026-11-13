// FirecREST client and Allas client against local mock servers (no network, no credentials).
// The request shapes are those of CSC's FirecREST v2 (as PyFirecREST sends them) and plain S3. Run: npm test

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createFirecrest, TokenError } from '../src/hpc/firecrest.mjs';
import { createS3 } from '../src/hpc/s3.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function listen(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}


// ---- FirecREST ------------------------------------------------------------------------------

test('FirecREST: submit, state, cancel, view, list, mkdir', async () => {
  const seen = [];
  const { url } = await listen((req, res, body) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body.length ? JSON.parse(body) : null });
    const json = (status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/compute/gpu/jobs' && req.method === 'POST') return json(201, { jobId: 2910144 });
    if (req.url === '/v1/compute/gpu/jobs/2910144') return req.method === 'DELETE' ? (res.statusCode = 204, res.end()) : json(200, { jobs: [{ jobId: 2910144, status: { state: 'RUNNING', stateReason: 'None' } }] });
    if (req.url === '/v1/compute/gpu/jobs/1') return json(200, { jobs: [{ status: { state: ['CANCELLED by 123'] } }] });
    if (req.url === '/v1/compute/gpu/jobs/2') return json(404, { message: 'Job not found' });
    if (req.url.startsWith('/v1/filesystem/gpu/ops/view')) return req.url.includes('missing') ? json(404, { message: 'No such file' }) : json(200, { output: 'hello\nworld\n' });
    if (req.url.startsWith('/v1/filesystem/gpu/ops/ls')) return json(200, { output: [{ name: 'models' }, { name: 'venv-aarch64-gpu' }] });
    if (req.url === '/v1/filesystem/gpu/ops/mkdir') return json(201, { output: {} });
    if (req.url === '/v1/status/gpu/userinfo') return json(200, { user: { id: '1', name: 'ahayrine' } });
    json(500, { message: 'unexpected ' + req.url });
  });
  const fc = createFirecrest({ url: `${url}/v1/`, system: 'gpu', account: 'project_2018805', token: () => 'T0KEN' });

  assert.equal(await fc.submit({ script: '#!/bin/bash\necho hi\n', workingDirectory: '/scratch/p/run' }), '2910144');
  assert.deepEqual(seen[0].body, { job: { script: '#!/bin/bash\necho hi\n', working_directory: '/scratch/p/run', account: 'project_2018805' } });
  assert.equal(seen[0].auth, 'Bearer T0KEN');

  assert.deepEqual(await fc.jobInfo('2910144'), { state: 'RUNNING', terminal: false, reason: 'None' });
  assert.deepEqual(await fc.jobInfo('1'), { state: 'CANCELLED', terminal: true, reason: '' });
  assert.deepEqual(await fc.jobInfo('2'), { state: 'UNKNOWN', terminal: false }, 'a job Slurm does not know yet');

  await fc.cancel('2910144');
  assert.equal(seen.at(-1).method, 'DELETE');

  assert.equal(await fc.view('/scratch/p/run/slurm-1.out'), 'hello\nworld\n');
  assert.equal(await fc.view('/scratch/missing'), null);
  assert.deepEqual(await fc.list('/scratch/p'), ['models', 'venv-aarch64-gpu']);
  await fc.mkdir('/scratch/p/new');
  assert.deepEqual(seen.at(-1).body, { sourcePath: '/scratch/p/new', parent: true });
  assert.equal((await fc.userinfo()).user.name, 'ahayrine');
});

test('FirecREST: an expired token is a TokenError and no request is made', async () => {
  let requests = 0;
  const { url } = await listen((_req, res) => { requests += 1; res.end('{}'); });
  const fc = createFirecrest({ url, system: 'gpu', account: 'a', token: () => { throw new TokenError('expired'); } });
  await assert.rejects(fc.jobInfo('1'), TokenError);
  await assert.rejects(fc.submit({ script: 'x', workingDirectory: '/x' }), TokenError);
  assert.equal(requests, 0);
});

test('FirecREST: FirecREST\'s own message is in the error; 429 and 5xx are retried', async () => {
  let calls = 0;
  const { url } = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/compute/gpu/jobs/9') {
      calls += 1;
      if (calls === 1) { res.statusCode = 429; res.setHeader('retry-after', '0'); return res.end('{}'); }
      if (calls === 2) { res.statusCode = 503; return res.end('{}'); }
      res.statusCode = 200;
      return res.end(JSON.stringify({ jobs: [{ status: { state: 'PENDING' } }] }));
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ message: 'Invalid account or account/partition combination specified' }));
  });
  const fc = createFirecrest({ url: `${url}/v1`, system: 'gpu', account: 'a', token: () => 't' });
  assert.equal((await fc.jobInfo('9')).state, 'PENDING');
  assert.equal(calls, 3, 'two retries, then the answer');
  await assert.rejects(fc.submit({ script: 'x', workingDirectory: '/x' }), /Invalid account or account\/partition combination.*HTTP 400/);
});


// ---- Allas ----------------------------------------------------------------------------------

/** Just enough of S3 (path style) for the client: buckets, objects, list, multi-delete. */
async function mockS3() {
  const buckets = new Map();
  const puts = [];
  const xml = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/xml'); res.end(body); };
  const { url } = await listen((req, res, body) => {
    const u = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (!bucket) return xml(res, 200, '<ListAllMyBucketsResult/>');
    if (!key) {
      if (req.method === 'HEAD') return buckets.has(bucket) ? (res.statusCode = 200, res.end()) : (res.statusCode = 404, res.end());
      if (req.method === 'PUT') { buckets.set(bucket, new Map()); return xml(res, 200, ''); }
      if (req.method === 'POST' && u.searchParams.has('delete')) {
        const keys = [...body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
        keys.forEach((k) => buckets.get(bucket).delete(k));
        return xml(res, 200, '<DeleteResult/>');
      }
      if (req.method === 'GET') {
        const prefix = u.searchParams.get('prefix') || '';
        const all = [...buckets.get(bucket)].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
        const start = u.searchParams.get('continuation-token') ? Number(u.searchParams.get('continuation-token')) : 0;
        const page = all.slice(start, start + 2);
        const truncated = start + 2 < all.length;
        return xml(res, 200, `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}${page.map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')}</ListBucketResult>`);
      }
    }
    if (req.method === 'PUT') {
      puts.push({ key, length: req.headers['content-length'], encoding: req.headers['content-encoding'], transfer: req.headers['transfer-encoding'], checksum: Object.keys(req.headers).filter((h) => h.startsWith('x-amz-checksum') || h.startsWith('x-amz-sdk-checksum')) });
      buckets.get(bucket).set(key, body);
      return xml(res, 200, '');
    }
    if (req.method === 'GET') {
      if (!buckets.get(bucket)?.has(key)) return xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
      res.statusCode = 200;
      return res.end(buckets.get(bucket).get(key));
    }
    xml(res, 501, '<Error/>');
  });
  return { url, buckets, puts };
}

test('FirecREST: a job submission is never repeated after a server error', async () => {
  let posts = 0;
  const { url } = await listen((req, res) => {
    posts += 1;
    res.statusCode = posts === 1 ? 502 : 201;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jobId: 5 }));
  });
  const fc = createFirecrest({ url: `${url}/v1`, system: 'gpu', account: 'a', token: () => 't' });
  await assert.rejects(fc.submit({ script: 'x', workingDirectory: '/x' }), /HTTP 502/);
  assert.equal(posts, 1, 'one request: the job may have been created');
});

test('Allas: bucket, upload with a known length, list with paging, download, delete', async () => {
  const mock = await mockS3();
  const s3 = createS3({ accessKey: 'AK', secretKey: 'SK', bucket: 'project-1-md-roihu', endpoint: mock.url });

  await s3.ensureBucket();
  assert.ok(mock.buckets.has('project-1-md-roihu'));
  await s3.ensureBucket(); // exists: nothing to do

  const file = path.join(dir, 'page.png');
  fs.writeFileSync(file, Buffer.from('not really a png'));
  await s3.putFile('md-roihu/run-1/in/p0001.png', file);
  await s3.putText('md-roihu/run-1/out/status.json', '{"finished":true}');
  for (const n of [1, 2, 3, 4]) await s3.putText(`md-roihu/run-1/out/txt/p000${n}.txt`, `t${n}`);

  const put = mock.puts.find((p) => p.key.endsWith('p0001.png'));
  assert.equal(put.length, String(Buffer.from('not really a png').length), 'Content-Length is sent, Allas takes no chunked uploads');
  assert.notEqual(put.transfer, 'chunked');
  assert.deepEqual(put.checksum, [], 'no streaming checksum headers, Allas answers MissingContentLength to them');

  const listed = await s3.list('md-roihu/run-1/out/');
  assert.equal(listed.length, 5, 'all pages of a paged listing');
  assert.deepEqual(listed.find((o) => o.key.endsWith('p0002.txt')), { key: 'md-roihu/run-1/out/txt/p0002.txt', size: 2 });
  assert.equal(await s3.getText('md-roihu/run-1/out/status.json'), '{"finished":true}');
  assert.equal(await s3.getText('md-roihu/run-1/out/none'), null);

  const target = path.join(dir, 'got.txt');
  await s3.getToFile('md-roihu/run-1/out/txt/p0003.txt', target);
  assert.equal(fs.readFileSync(target, 'utf8'), 't3');

  assert.equal(await s3.deletePrefix('md-roihu/run-1/'), 6);
  assert.equal((await s3.list('md-roihu/run-1/')).length, 0);
});

test('Allas: missing keys are a clear error', () => {
  assert.throws(() => createS3({ bucket: 'b' }), /ALLAS_ACCESS_KEY/);
});

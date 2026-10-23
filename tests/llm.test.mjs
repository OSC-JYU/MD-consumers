// LLM adapters: the shared core, the OpenAI-compatible request against a fake server, and Gemini
// request building. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';

import {
  toJsonSchema, parseLabels, autotagRequest, autotagResult, parseJsonReply, withRetry, isRetryable,
  buildRequest, runJob, prepareImage, checkTextSize, outputLabel, PermanentError,
} from '../src/adapters/llm/core.mjs';
import * as openaiAdapter from '../src/adapters/llm-openai.mjs';
import { geminiRequest, fromGemini } from '../src/adapters/llm-gemini.mjs';

test('json schema: real schemas pass, examples are converted', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  assert.deepEqual(toJsonSchema(JSON.stringify(schema)), schema);
  assert.deepEqual(toJsonSchema('{"title":"","year":1,"authors":[""],"ok":true}'), {
    type: 'object',
    properties: {
      title: { type: 'string' }, year: { type: 'number' },
      authors: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' },
    },
    required: ['title', 'year', 'authors', 'ok'],
    additionalProperties: false,
  });
  assert.equal(toJsonSchema(''), null);
  assert.throws(() => toJsonSchema('{nope'), PermanentError);
  assert.throws(() => toJsonSchema('[1]'), PermanentError);
});

test('labels from text or existing tags', () => {
  assert.deepEqual(parseLabels('sports, politics,, sports'), [{ label: 'sports', description: '' }, { label: 'politics', description: '' }]);
  assert.deepEqual(parseLabels([{ label: 'Music', description: 'songs and bands' }, { name: 'Art' }, 'Dance']), [
    { label: 'Music', description: 'songs and bands' }, { label: 'Art', description: '' }, { label: 'Dance', description: '' },
  ]);
});

test('autotag: closed mode keeps only listed labels', () => {
  const multi = autotagRequest({ labels: [{ label: 'Music', description: 'songs' }, { label: 'Sports' }] }, 'text');
  assert.match(multi.system, /- Music: songs/);
  assert.deepEqual(multi.schema.properties.categories.items.enum, ['Music', 'Sports']);
  assert.deepEqual(autotagResult({ categories: ['music', 'Cooking', 'Sports', 'Music'] }, multi), ['Music', 'Sports']);

  const single = autotagRequest({ labels: 'a, b', multi_label: false }, 'image');
  assert.match(single.system, /an image/);
  assert.deepEqual(autotagResult({ category: 'b' }, single), ['b']);
  assert.deepEqual(autotagResult({ category: 'z' }, single), []);
});

test('autotag: open mode suggests up to max_tags tags', () => {
  const open = autotagRequest({ labels: '', max_tags: 2 }, 'text');
  assert.deepEqual(Object.keys(open.schema.properties), ['tags']);
  assert.deepEqual(autotagResult({ tags: ['Black holes', ' black  holes', 'Physics', 'Planck'] }, open), ['Black holes', 'Physics']);
});

test('json replies, also fenced', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply(' {"a":1} '), { a: 1 });
  assert.throws(() => parseJsonReply('Sure! here'), /did not answer with valid JSON/);
});

test('retries on 429 and 5xx with Retry-After, not on 400', async () => {
  const waits = [];
  let calls = 0;
  const { value, retries } = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '2' } });
    if (calls === 2) throw Object.assign(new Error('down'), { status: 503 });
    return 'ok';
  }, { sleep: async (ms) => waits.push(ms), initialDelayMs: 100 });
  assert.equal(value, 'ok');
  assert.equal(retries, 2);
  assert.deepEqual(waits, [2000, 200]);
  await assert.rejects(withRetry(async () => { throw Object.assign(new Error('bad'), { status: 400 }); }, { sleep: async () => {} }), /bad/);
  assert.equal(isRetryable(new PermanentError('x')), false);
});

test('request for a prompt run: model map, params, schema', () => {
  const msg = {
    task: {
      id: 'summary',
      model: { id: 'gemma3', name: 'Gemma 3', max_output_tokens: 1000 },
      params: { prompts: { content: 'Summarise.' }, temperature: '0.3', output_type: 'json', json_schema: '{"summary":""}' },
    },
  };
  const request = buildRequest(msg, { kind: 'text', text: 'Hello' }, { model_map: { gemma3: 'gemma3:4b' } });
  assert.equal(request.model, 'gemma3:4b');
  assert.equal(request.temperature, 0.3);
  assert.equal(request.maxOutputTokens, 1000);
  assert.equal(request.kind, 'json');
  assert.deepEqual(request.schema.required, ['summary']);
  // reasoning models that take no temperature
  const noTemp = buildRequest({ task: { ...msg.task, model: { id: 'o', temperature: false } } }, { kind: 'text', text: 'x' }, {});
  assert.equal(noTemp.temperature, undefined);
  assert.throws(() => buildRequest({ task: { id: 'x', model: 'm', params: {} } }, { kind: 'text', text: 'x' }, {}), /prompt text is missing/);
  assert.throws(() => buildRequest({ task: { id: 'x', params: {} } }, { kind: 'text', text: 'x' }, {}), /No model/);
});

test('text size guard and output labels', () => {
  assert.doesNotThrow(() => checkTextSize('x'.repeat(400), { max_input_tokens: 100 }, 'm'));
  assert.throws(() => checkTextSize('x'.repeat(401), { max_input_tokens: 100, name: 'M' }, 'm'), /too long for M: about 101 tokens/);
  assert.equal(outputLabel({ original_filename: 'a.txt', label: 'b' }, 'json'), 'a.txt.json');
  assert.equal(outputLabel({}, 'txt'), 'result.txt');
});

test('images: TIFF converted to PNG, large images scaled down', async () => {
  const tif = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#ffffff' } }).tiff().toBuffer();
  const out = await prepareImage(tif, 'tif', 1000);
  assert.equal(out.mime, 'image/png');
  const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
  assert.deepEqual([meta.width, meta.height], [1000, 333]);
  const small = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer();
  assert.equal((await prepareImage(small, 'jpg')).base64, small.toString('base64'));
});

function fakeIo(input) {
  const sent = { text: [], json: [], metadata: [], errors: [] };
  return {
    sent,
    io: {
      readInput: async () => Buffer.from(input),
      sendText: async (f, m) => sent.text.push({ f, m: structuredClone(m) }),
      sendJson: async (f, m) => sent.json.push({ f, m: structuredClone(m) }),
      sendMetadata: async (f, m) => sent.metadata.push({ f, m: structuredClone(m) }),
      sendError: async (m, e) => sent.errors.push(e.message),
    },
  };
}

const job = (task, file = { '@rid': '#1:2', type: 'text', extension: 'txt', label: 'doc.txt' }) => ({
  json: () => ({ file, task, userId: '#5:5' }),
});

const reply = (text) => async () => ({ text, model: 'm-1', usage: { in: 10, out: 5, total: 15 }, finishReason: 'stop', raw: {} });

test('runJob: text prompt sends the answer and the token usage', async () => {
  const { sent, io } = fakeIo('Some text');
  await runJob(job({ id: 'p', model: { id: 'm' }, params: { prompts: { content: 'Say hi' } } }), { generate: reply('Hi!'), provider: { name: 'md-llm-test' }, io, log: () => {} });
  assert.equal(sent.text[0].f.content, 'Hi!');
  assert.equal(sent.text[0].f.label, 'doc.txt.txt');
  const meta = sent.metadata[0].f.content.metadata;
  assert.equal(meta.provider, 'md-llm-test');
  assert.deepEqual(meta.tokens, { in: { count: 10, modality: 'TEXT' }, out: { count: 5, modality: 'TEXT' }, total: 15 });
  assert.equal(sent.errors.length, 0);
});

test('runJob: autotag writes the classification shape the backend tags from', async () => {
  const { sent, io } = fakeIo('Bach wrote fugues');
  await runJob(job({ id: 'autotag', model: { id: 'm' }, params: { labels: [{ label: 'Music' }, { label: 'Sports' }] } }), {
    generate: reply('{"categories":["Music","Cooking"]}'), provider: {}, io, log: () => {},
  });
  assert.deepEqual(sent.json[0].f.content.result, { category: ['Music'] });
  assert.equal(sent.json[0].f.type, 'json');
});

test('runJob: permanent failures become the job error, provider outages are thrown for a retry', async () => {
  const bad = fakeIo('x');
  await runJob(job({ id: 'p', model: { id: 'm' }, params: { prompts: { content: 'p' }, output_type: 'json' } }), { generate: reply('not json'), provider: {}, io: bad.io, log: () => {} });
  assert.match(bad.sent.errors[0], /valid JSON/);

  const long = fakeIo('x'.repeat(1000));
  await runJob(job({ id: 'p', model: { id: 'm', max_input_tokens: 10 }, params: { prompts: { content: 'p' } } }), { generate: reply('x'), provider: {}, io: long.io, log: () => {} });
  assert.match(long.sent.errors[0], /too long/);

  const rejected = fakeIo('x');
  const status400 = async () => { throw Object.assign(new Error('model not found'), { status: 404 }); };
  await runJob(job({ id: 'p', model: { id: 'm' }, params: { prompts: { content: 'p' } } }), { generate: status400, provider: {}, io: rejected.io, log: () => {} });
  assert.match(rejected.sent.errors[0], /model not found/);

  const down = fakeIo('x');
  const status503 = async () => { throw Object.assign(new Error('overloaded'), { status: 503, headers: { 'retry-after': '0' } }); };
  await assert.rejects(runJob(job({ id: 'p', model: { id: 'm' }, params: { prompts: { content: 'p' } } }), { generate: status503, provider: { retry: { max_attempts: 2 } }, io: down.io, log: () => {} }), /overloaded/);
});

/** A minimal OpenAI-compatible server that records requests. */
async function fakeOpenAi(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      const [status, payload] = handler(req, parsed);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) };
}

test('llm-openai: Azure-style config against a fake OpenAI-compatible server', async () => {
  process.env.TEST_LLM_KEY = 'secret-key';
  const server = await fakeOpenAi((req) => {
    if (req.url.startsWith('/v1/models')) return [200, { object: 'list', data: [] }];
    return [200, {
      id: 'c1', object: 'chat.completion', model: 'gpt-x-2026',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"title":"T"}' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }];
  });
  try {
    openaiAdapter.configure({ base_url: server.url, api_key_env: 'TEST_LLM_KEY', auth_header: 'api-key', api_version: '2025-04-01', model_map: { gpt: 'my-deployment' }, store: false, max_tokens_param: 'max_tokens' }, { id: 'md-llm-azure' });
    await openaiAdapter.preflight();
    const request = buildRequest({ task: { id: 'p', model: { id: 'gpt' }, params: { prompts: { content: 'Title?' }, output_type: 'json', json_schema: '{"title":""}', max_output_tokens: 50 } } }, { kind: 'image', image: { mime: 'image/png', base64: 'AAAA' } }, { model_map: { gpt: 'my-deployment' } });
    const result = await openaiAdapter.generate(request);
    assert.equal(result.text, '{"title":"T"}');
    assert.deepEqual(result.usage, { in: 7, out: 3, total: 10 });
    const sent = server.requests.find((r) => r.url.startsWith('/v1/chat/completions'));
    assert.equal(sent.url, '/v1/chat/completions?api-version=2025-04-01');
    assert.equal(sent.headers['api-key'], 'secret-key');
    assert.equal(sent.body.model, 'my-deployment');
    assert.equal(sent.body.max_tokens, 50);
    assert.equal(sent.body.store, false);
    assert.equal(sent.body.response_format.type, 'json_schema');
    assert.equal(sent.body.messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA');
  } finally {
    await server.close();
  }
});

test('llm-openai: json_object mode for models without schema support', () => {
  const body = openaiAdapter.chatBody({ model: 'm', system: 'S', text: 'T', schema: { type: 'object' }, modelInfo: { structured_output: false }, maxOutputTokens: 10 }, {});
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.match(body.messages[0].content, /JSON schema of the answer/);
  assert.equal(body.max_completion_tokens, 10);
  assert.equal(body.store, undefined);
});

test('llm-gemini: inline image, system instruction and JSON schema', () => {
  const req = geminiRequest({ model: 'gemini-2.5-flash', system: 'S', text: 'T', image: { mime: 'image/jpeg', base64: 'BBBB' }, schema: { type: 'object' }, temperature: 0.5, maxOutputTokens: 100 });
  assert.deepEqual(req.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } });
  assert.equal(req.config.systemInstruction, 'S');
  assert.equal(req.config.responseMimeType, 'application/json');
  assert.deepEqual(req.config.responseJsonSchema, { type: 'object' });
  const parsed = fromGemini({ text: 'ok', modelVersion: 'g-1', usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 9 }, candidates: [{ finishReason: 'STOP' }] });
  assert.deepEqual(parsed.usage, { in: 4, out: 5, total: 9 });
  assert.equal(parsed.finishReason, 'STOP');
});

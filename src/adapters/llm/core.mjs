// Provider-neutral part of the LLM adapters (MessyDesk plan/llm-adapter.md 4.1): reads the job's
// input, builds the request from the prompt (or the autotagger task), checks sizes, calls the
// provider through a `generate` function with retries, and sends the result and the token usage
// back to MessyDesk. llm-openai.mjs and llm-gemini.mjs only translate requests and responses.
//
// The request handed to `generate`:
//   { model, system, text, image: { mime, base64 } | null, schema | null,
//     temperature | undefined, maxOutputTokens | undefined }
// and what it returns:
//   { text, model, usage: { in, out, total }, finishReason, raw }

import { promises as fs } from 'fs';
import sharp from 'sharp';

import {
  getFile,
  sendTextFile,
  sendJSONFile,
  sendError,
  withResponseTime,
} from '../../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200';

const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
// Sent as is when small enough; anything else (TIFF, BMP, ...) is converted to PNG.
const PASS_THROUGH = new Set(['image/jpeg', 'image/png']);
const DEFAULT_MAX_IMAGE_EDGE = 2048;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_IMAGE_USER_TEXT = 'Here is the image.';

/** A failure that a retry will not fix: reported to the user at once. */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

// ---- prompts and schemas ----------------------------------------------------------------

/**
 * A prompt's `json_schema` as a JSON Schema. Users write either a JSON Schema or an example of
 * the wanted output ({"title": "", "authors": [""]}); an object with `type` or `properties` at the
 * top is taken as a schema, anything else as an example and converted.
 */
export function toJsonSchema(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw new PermanentError(`The prompt's JSON schema is not valid JSON: ${e.message}`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PermanentError("The prompt's JSON schema must be a JSON object");
  }
  if (typeof value.type === 'string' || (value.properties && typeof value.properties === 'object')) return value;
  return exampleToSchema(value);
}

export function exampleToSchema(example) {
  if (Array.isArray(example)) {
    return { type: 'array', items: example.length ? exampleToSchema(example[0]) : { type: 'string' } };
  }
  if (example && typeof example === 'object') {
    const properties = {};
    for (const [key, value] of Object.entries(example)) properties[key] = exampleToSchema(value);
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (typeof example === 'number') return { type: 'number' };
  if (typeof example === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

/** Labels from the tag picker: a comma list, or [{label, description}] of existing tags. */
export function parseLabels(raw) {
  if (Array.isArray(raw)) {
    const labels = [];
    for (const item of raw) {
      const label = String((item && typeof item === 'object' ? item.label ?? item.name : item) ?? '').trim();
      if (!label || labels.some((l) => l.label === label)) continue;
      const description = item && typeof item === 'object' ? String(item.description || '').trim() : '';
      labels.push({ label, description });
    }
    return labels;
  }
  const seen = new Set();
  return String(raw ?? '').split(',').map((s) => s.trim()).filter((label) => {
    if (!label || seen.has(label)) return false;
    seen.add(label);
    return true;
  }).map((label) => ({ label, description: '' }));
}

function boolParam(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function numberParam(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The autotagger's request. With labels the model may only answer with those labels (closed mode,
 * like MD-Gliner2's classify_text with existing tags); without labels it suggests short tags
 * (open mode).
 */
export function autotagRequest(params, inputKind) {
  const labels = parseLabels(params?.labels);
  const multi = boolParam(params?.multi_label, true);
  const maxTags = Math.max(1, Math.min(50, Math.round(numberParam(params?.max_tags) ?? 5)));
  const what = inputKind === 'image' ? 'an image' : 'a text';
  const extra = String(params?.instructions || '').trim();
  const lines = [];
  if (labels.length) {
    lines.push(`You tag ${what} with categories from a fixed list.`);
    lines.push(multi
      ? 'Choose every category from the list that clearly applies, or none if nothing applies.'
      : 'Choose the single category from the list that fits best.');
    lines.push('', 'Categories:');
    for (const { label, description } of labels) lines.push(description ? `- ${label}: ${description}` : `- ${label}`);
  } else {
    lines.push(`You tag ${what} with short subject tags (one to three words each).`);
    lines.push(`Give at most ${maxTags} tags, the most important first, in the language of the ${inputKind === 'image' ? 'image text if any, otherwise English' : 'text'}.`);
  }
  if (extra) lines.push('', `Extra guidance: ${extra}`);
  lines.push('', 'Answer only with JSON that matches the given schema.');
  const values = labels.map((l) => l.label);
  let schema;
  if (labels.length && multi) {
    schema = { type: 'object', properties: { categories: { type: 'array', items: { type: 'string', enum: values } } }, required: ['categories'], additionalProperties: false };
  } else if (labels.length) {
    schema = { type: 'object', properties: { category: { type: 'string', enum: values } }, required: ['category'], additionalProperties: false };
  } else {
    schema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'], additionalProperties: false };
  }
  return { system: lines.join('\n'), schema, labels: values, multi, maxTags };
}

/** The tags from the model's answer: only listed labels in closed mode, deduplicated. */
export function autotagResult(answer, request) {
  let picked = [];
  if (answer && typeof answer === 'object') {
    if (Array.isArray(answer.categories)) picked = answer.categories;
    else if (answer.category !== undefined && answer.category !== null) picked = [answer.category];
    else if (Array.isArray(answer.tags)) picked = answer.tags;
  }
  const out = [];
  const byLower = new Map(request.labels.map((l) => [l.toLowerCase(), l]));
  for (const value of picked) {
    let tag = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!tag) continue;
    if (request.labels.length) {
      tag = byLower.get(tag.toLowerCase());
      if (!tag) continue;
    }
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (!request.labels.length) return out.slice(0, request.maxTags);
  return request.multi ? out : out.slice(0, 1);
}

/** Pulls the JSON out of a reply, also when a model wraps it in ```json fences. */
export function parseJsonReply(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new PermanentError(`The model did not answer with valid JSON (${e.message}). Start of the answer: ${trimmed.slice(0, 300)}`);
  }
}

// ---- input ------------------------------------------------------------------------------

/** Rough token count for the size guard: about four characters per token. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function checkTextSize(text, model, modelId) {
  const max = Number(model?.max_input_tokens);
  if (!Number.isFinite(max) || max <= 0) return;
  const estimate = estimateTokens(text);
  if (estimate > max) {
    throw new PermanentError(`The text is too long for ${model?.name || modelId}: about ${estimate} tokens, the model takes ${max}. Split the text first (for example by pages).`);
  }
}

export function inputKind(file) {
  const type = String(file?.type || '').toLowerCase();
  const extension = String(file?.extension || '').toLowerCase();
  if (type === 'image' || IMAGE_MIME[extension] || ['tif', 'tiff', 'bmp'].includes(extension)) return 'image';
  return 'text';
}

/** An image as base64, converted to JPEG/PNG and scaled down to the model's longest edge. */
export async function prepareImage(buffer, extension, maxEdge = DEFAULT_MAX_IMAGE_EDGE) {
  const mime = IMAGE_MIME[String(extension || '').toLowerCase()];
  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const tooLarge = Math.max(meta.width || 0, meta.height || 0) > maxEdge;
  if (!tooLarge && PASS_THROUGH.has(mime)) return { mime, base64: buffer.toString('base64') };
  let pipeline = image;
  if (tooLarge) pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  if (mime === 'image/jpeg') {
    return { mime: 'image/jpeg', base64: (await pipeline.jpeg({ quality: 90 }).toBuffer()).toString('base64') };
  }
  return { mime: 'image/png', base64: (await pipeline.png().toBuffer()).toString('base64') };
}

// ---- retries ----------------------------------------------------------------------------

export function errorStatus(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.response?.statusCode ?? error?.code) || null;
}

function retryAfterMs(error) {
  const headers = error?.headers || error?.response?.headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function isRetryable(error) {
  if (error?.permanent) return false;
  const status = errorStatus(error);
  if (status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600)) return true;
  if (status && status >= 400 && status < 500) return false;
  // network failures and timeouts carry no status
  return true;
}

/** Runs `fn` again on 429, 5xx and network errors, waiting `Retry-After` or backing off. */
export async function withRetry(fn, { maxAttempts = 4, initialDelayMs = 1000, maxDelayMs = 60000, sleep = defaultSleep, onRetry = null } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { value: await fn(attempt), retries: attempt - 1 };
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const wait = Math.min(maxDelayMs, retryAfterMs(error) ?? initialDelayMs * 2 ** (attempt - 1));
      if (onRetry) onRetry(error, attempt, wait);
      await sleep(wait);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- the job ----------------------------------------------------------------------------

/** The file label the result gets: `<original name>.<ext>`. */
export function outputLabel(file, ext) {
  const base = file?.original_filename || file?.label || 'result';
  return `${base}.${ext}`;
}

/**
 * The model to call: the id the user picked, mapped to the provider's own name (Azure
 * deployment, Ollama tag) through `provider.model_map`.
 */
export function providerModel(task, provider) {
  const id = task?.model?.id || task?.model;
  if (!id || typeof id !== 'string') throw new PermanentError('No model chosen for this task');
  return { id, name: provider?.model_map?.[id] || id, model: typeof task.model === 'object' ? task.model : {} };
}

/** Builds the generate() request for a prompt run or the autotagger. */
export function buildRequest(msg, input, provider) {
  const task = msg.task || {};
  const params = task.params || {};
  const { id, name, model } = providerModel(task, provider);
  const temperature = model.temperature === false ? undefined : numberParam(params.temperature);
  const maxOutputTokens = Math.round(numberParam(params.max_output_tokens) ?? model.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const base = { modelId: id, model: name, modelInfo: model, temperature, maxOutputTokens, image: input.image || null };
  if (task.id === 'autotag') {
    const tagging = autotagRequest(params, input.kind);
    return { ...base, kind: 'autotag', system: tagging.system, text: input.text || DEFAULT_IMAGE_USER_TEXT, schema: tagging.schema, tagging };
  }
  const system = params?.prompts?.content;
  if (!system || !String(system).trim()) throw new PermanentError('The prompt text is missing');
  const json = params.output_type === 'json';
  const schema = json ? toJsonSchema(params.json_schema) || { type: 'object' } : null;
  return { ...base, kind: json ? 'json' : 'text', system: String(system), text: input.text || DEFAULT_IMAGE_USER_TEXT, schema };
}

export function usageMetadata(result, request, provider, retries) {
  const tokensIn = Number(result?.usage?.in || 0);
  const tokensOut = Number(result?.usage?.out || 0);
  return {
    model: result?.model || request.model,
    model_id: request.modelId,
    provider: provider?.name || 'unknown',
    tokens: {
      in: { count: tokensIn, modality: request.image ? 'TEXT+IMAGE' : 'TEXT' },
      out: { count: tokensOut, modality: 'TEXT' },
      total: Number(result?.usage?.total || tokensIn + tokensOut),
    },
    finish_reason: result?.finishReason || null,
    retries,
  };
}

/** Default IO: MessyDesk over HTTP. Tests pass their own. */
export const httpIo = {
  async readInput(msg) {
    const filePath = await getFile(MD_URL, msg.file['@rid'], msg.userId);
    try {
      return await fs.readFile(filePath);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  },
  sendText: (filedata, msg) => sendTextFile(filedata, msg, `${MD_URL}/api/nomad/process/files`),
  sendJson: (filedata, msg) => sendJSONFile(filedata, msg, `${MD_URL}/api/nomad/process/files`),
  sendMetadata: (filedata, msg) => sendJSONFile(filedata, msg, `${MD_URL}/api/nomad/process/files/metadata`),
  sendError: (msg, error) => sendError(msg, error, MD_URL),
};

/**
 * Runs one job. Permanent failures (bad prompt, text too long, invalid JSON, 4xx from the
 * provider) are reported as the job's error; transient ones that survive the retries are thrown,
 * so the queue retries the job later.
 */
export async function runJob(message, { generate, provider, io = httpIo, log = console.log }) {
  const startedAt = process.hrtime();
  let msg;
  try {
    msg = message.json();
  } catch (e) {
    await io.sendError({}, { message: 'invalid message payload' });
    return;
  }
  try {
    if (!msg?.file?.['@rid']) throw new PermanentError('No file found in message');
    const kind = inputKind(msg.file);
    const { model } = providerModel(msg.task, provider);
    const buffer = await io.readInput(msg);
    const input = { kind };
    if (kind === 'image') {
      input.image = await prepareImage(buffer, msg.file.extension, Number(model.max_image_edge) || DEFAULT_MAX_IMAGE_EDGE);
    } else {
      input.text = buffer.toString('utf8');
      if (!input.text.trim()) throw new PermanentError('The text is empty');
      checkTextSize(input.text, model, msg.task?.model?.id);
    }
    const request = buildRequest(msg, input, provider);
    const retry = provider?.retry || {};
    const { value: result, retries } = await withRetry(() => generate(request), {
      maxAttempts: Number(retry.max_attempts) || 4,
      initialDelayMs: Number(retry.initial_delay_ms) || 1000,
      onRetry: (error, attempt, wait) => log(`${provider?.name || 'llm'}: attempt ${attempt} failed (${errorStatus(error) || error.message}), retrying in ${wait} ms`),
    }).catch((error) => {
      error.fromProvider = true;
      throw error;
    });

    if (request.kind === 'autotag') {
      const tags = autotagResult(parseJsonReply(result.text), request.tagging);
      const content = {
        task: 'autotag',
        params: { labels: request.tagging.labels, multi_label: request.tagging.multi },
        model: request.modelId,
        result: { category: tags },
      };
      withResponseTime(msg, startedAt);
      await io.sendJson({ label: outputLabel(msg.file, 'json'), content, type: 'json', ext: 'json' }, msg);
    } else if (request.kind === 'json') {
      const content = parseJsonReply(result.text);
      withResponseTime(msg, startedAt);
      await io.sendJson({ label: outputLabel(msg.file, 'json'), content, type: 'json', ext: 'json' }, msg);
    } else {
      withResponseTime(msg, startedAt);
      await io.sendText({ label: outputLabel(msg.file, 'txt'), content: result.text || '', type: 'text', ext: 'txt' }, msg);
    }

    const metadata = usageMetadata(result, request, provider, retries);
    await io.sendMetadata({ label: 'response.json', content: { metadata, raw: result.raw ?? null }, type: 'response', ext: 'json' }, msg);
  } catch (error) {
    // Only provider failures are worth another try later; our own (bad image, bad prompt) are not.
    if (error?.fromProvider && isRetryable(error)) throw error;
    log(`${provider?.name || 'llm'}: ${error.message}`);
    await io.sendError(msg, error);
  }
}

/** Reads the API key from the env var the provider config names. */
export function apiKeyFrom(provider, fallbackEnv = null) {
  const name = provider?.api_key_env || fallbackEnv;
  if (!name) return undefined;
  const key = process.env[name];
  return key ? String(key).trim() : undefined;
}

import got from 'got';
import { promises as fsp } from 'fs';

import {
  getTextFromFile,
  getFile,
  sendTextFile,
  sendJSONFile,
  sendError,
  withResponseTime,
} from '../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200';
// LibreTranslate has no built-in request size limit, so we cap it here.
const MAX_INPUT_SIZE = Number(process.env.LIBRETRANSLATE_MAX_INPUT_SIZE || 2 * 1024 * 1024); // 2MB

function resolveEndpoint(rawServiceUrl, urlPath) {
  let serviceUrl = String(rawServiceUrl || '').trim();
  if (!serviceUrl.startsWith('http')) {
    serviceUrl = `http://${serviceUrl}`;
  }
  return `${serviceUrl.replace(/\/$/, '')}${urlPath}`;
}

async function readCappedText(readpath) {
  const stats = await fsp.stat(readpath);
  if (stats.size > MAX_INPUT_SIZE) {
    throw new Error(`Input text exceeds the ${MAX_INPUT_SIZE} byte limit (got ${stats.size} bytes)`);
  }
  return getTextFromFile(readpath);
}

async function callTranslate(service_url, q, source, target, format) {
  const endpoint = resolveEndpoint(service_url, '/translate');
  return got.post(endpoint, {
    json: { q, source, target, format },
    timeout: { request: 60000 },
  }).json();
}

async function callDetect(service_url, q) {
  const endpoint = resolveEndpoint(service_url, '/detect');
  return got.post(endpoint, {
    json: { q },
    timeout: { request: 60000 },
  }).json();
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The service may still be starting up (loading language models) when this is called
// right after consumer startup, so retry with backoff instead of failing immediately.
async function fetchLanguagesWithRetry(service_url, { attempts = 5, initialDelayMs = 1000, maxDelayMs = 8000 } = {}) {
  const endpoint = resolveEndpoint(service_url, '/languages');
  let delayMs = initialDelayMs;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await got.get(endpoint, { timeout: { request: 10000 } }).json();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      console.log(`libretranslate: /languages not ready (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms:`, error.message);
      await sleepMs(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }

  throw lastError;
}

// Replaces service.json's static language list with the instance's actual installed
// languages (GET /languages), so param dropdowns always match what the API supports.
export async function enrichDescriptor(descriptor, service_url) {
  const languages = await fetchLanguagesWithRetry(service_url);

  if (!Array.isArray(languages) || languages.length === 0) return descriptor;

  const targetValues = {};
  for (const lang of languages) {
    if (lang?.code && lang?.name) targetValues[lang.code] = lang.name;
  }
  const sourceValues = { auto: 'Detect automatically', ...targetValues };

  const enriched = JSON.parse(JSON.stringify(descriptor));
  for (const taskId of ['translate', 'translate_html']) {
    const paramsHelp = enriched.tasks?.[taskId]?.params_help;
    if (!paramsHelp) continue;
    if (paramsHelp.source) paramsHelp.source.values = sourceValues;
    if (paramsHelp.target) paramsHelp.target.values = targetValues;
  }
  return enriched;
}

export async function process_msg(service_url, message) {
  let msg;
  const startedAt = process.hrtime();
  const url_md = `${MD_URL}/api/nomad/process/files`;

  try {
    msg = message.json();
  } catch (e) {
    console.log('invalid message payload!', e.message);
    await sendError({}, { error: 'invalid message payload!' }, url_md);
    return;
  }

  try {
    console.log('**************** LIBRETRANSLATE api ***************');
    console.log(msg);

    if (!msg.file?.['@rid']) {
      throw new Error('No file found in message');
    }

    const readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId);
    const text = await readCappedText(readpath);

    const taskId = msg.task?.id;
    const params = msg.task?.params || {};
    const label = msg.file.original_filename || msg.file.label || 'result';

    if (taskId === 'translate' || taskId === 'translate_html') {
      const source = params.source || 'auto';
      const target = params.target || 'en';
      const format = taskId === 'translate_html' ? 'html' : 'text';
      const ext = taskId === 'translate_html' ? 'html' : 'txt';

      const result = await callTranslate(service_url, text, source, target, format);

      withResponseTime(msg, startedAt);
      await sendTextFile(
        { label: `${label}.${target}.${ext}`, content: result.translatedText, type: 'text', ext },
        msg,
        url_md
      );
    } else if (taskId === 'detect_language') {
      const result = await callDetect(service_url, text);

      withResponseTime(msg, startedAt);
      await sendJSONFile(
        { label: `${label}.language.json`, content: result, type: 'language.json', ext: 'json' },
        msg,
        url_md
      );
    } else {
      throw new Error('Task not found');
    }
  } catch (error) {
    console.log('pipeline error');
    console.log(error.status);
    console.log(error.code);
    console.error('libretranslate_api: Error processing request:', error.message);
    await sendError(msg, error.message, MD_URL);
  }
}

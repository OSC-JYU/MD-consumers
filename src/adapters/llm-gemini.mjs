// LLM adapter for Google Gemini through its native API (MessyDesk plan/llm-adapter.md 4.1).
// Images are sent inline, so nothing is left in Google's file store. Provider settings come from
// the `provider` block of the consumer's CONFIG_JSON_PATH file; the key from the env var it
// names (`api_key_env`, default GOOGLE_API_KEY).
//
// provider: { name, api_key_env, timeout_ms, retry, model_map }

import { GoogleGenAI } from '@google/genai';

import { apiKeyFrom, runJob } from './llm/core.mjs';

let provider = { name: 'gemini' };
let ai = null;

/** Called once by the consumer with the config's provider block. */
export function configure(config = {}, descriptor = null) {
  provider = { ...config, name: config.name || descriptor?.id || 'gemini' };
  const apiKey = apiKeyFrom(provider, 'GOOGLE_API_KEY');
  if (!apiKey) throw new Error(`llm-gemini: set ${provider.api_key_env || 'GOOGLE_API_KEY'}`);
  ai = new GoogleGenAI({ vertexai: false, apiKey, httpOptions: { timeout: Number(provider.timeout_ms) || 120000 } });
}

/** generateContent arguments for a core.mjs request. */
export function geminiRequest(request) {
  const parts = [{ text: request.text }];
  if (request.image) parts.push({ inlineData: { mimeType: request.image.mime, data: request.image.base64 } });
  const config = { systemInstruction: request.system };
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.maxOutputTokens) config.maxOutputTokens = request.maxOutputTokens;
  if (request.schema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = request.schema;
  }
  return { model: request.model, contents: [{ role: 'user', parts }], config };
}

export function fromGemini(response) {
  const usage = response?.usageMetadata || {};
  return {
    text: response?.text ?? '',
    model: response?.modelVersion,
    usage: {
      in: usage.promptTokenCount || 0,
      out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
      total: usage.totalTokenCount || 0,
    },
    finishReason: response?.candidates?.[0]?.finishReason || null,
    raw: { modelVersion: response?.modelVersion, usageMetadata: usage, candidates: response?.candidates },
  };
}

export async function generate(request) {
  return fromGemini(await ai.models.generateContent(geminiRequest(request)));
}

export async function preflight() {
  await ai.models.list({ config: { pageSize: 1 } });
}

export async function process_msg(service_url, message) {
  if (!ai) configure({});
  await runJob(message, { generate, provider });
}

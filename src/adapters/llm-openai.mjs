// LLM adapter for every OpenAI-compatible Chat Completions endpoint: OpenAI, Azure OpenAI,
// Ollama (/v1), vLLM, LM Studio, LiteLLM and others (MessyDesk plan/llm-adapter.md 4.1).
// Provider settings come from the `provider` block of the consumer's CONFIG_JSON_PATH file;
// keys only from the env var it names (`api_key_env`).
//
// provider: {
//   name, base_url, api_key_env, auth_header ("authorization" | "api-key"), api_version,
//   headers, model_map, timeout_ms, retry, store, strict_json,
//   max_tokens_param ("max_tokens" | "max_completion_tokens"), json_mode ("schema" | "object")
// }

import OpenAI from 'openai';

import { apiKeyFrom, runJob } from './llm/core.mjs';

let provider = { name: 'openai-compatible' };
let client = null;

export function createClient(config, serviceUrl) {
  const baseURL = String(config.base_url || serviceUrl || '').replace(/\/+$/, '');
  if (!baseURL) throw new Error('llm-openai: provider.base_url (or DEV_URL) is required');
  const apiKey = apiKeyFrom(config) || 'none';
  const defaultHeaders = { ...(config.headers || {}) };
  if (String(config.auth_header || '').toLowerCase() === 'api-key') defaultHeaders['api-key'] = apiKey;
  const defaultQuery = config.api_version ? { 'api-version': config.api_version } : undefined;
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders,
    defaultQuery,
    timeout: Number(config.timeout_ms) || 120000,
    // core.mjs retries with Retry-After itself
    maxRetries: 0,
  });
}

/** Called once by the consumer with the config's provider block. */
export function configure(config = {}, descriptor = null, serviceUrl = null) {
  provider = { ...config, name: config.name || descriptor?.id || 'openai-compatible' };
  client = createClient(provider, serviceUrl);
}

/** Chat Completions body for a core.mjs request. */
export function chatBody(request, config = provider) {
  const user = request.image
    ? [
        { type: 'text', text: request.text },
        { type: 'image_url', image_url: { url: `data:${request.image.mime};base64,${request.image.base64}` } },
      ]
    : request.text;
  const body = {
    model: request.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: user },
    ],
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens) body[config.max_tokens_param || 'max_completion_tokens'] = request.maxOutputTokens;
  if (request.schema) {
    const structured = request.modelInfo?.structured_output !== false && config.json_mode !== 'object';
    if (structured) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'result', schema: request.schema, strict: config.strict_json === true },
      };
    } else {
      // Models without schema support: JSON mode, with the schema in the instructions.
      body.response_format = { type: 'json_object' };
      body.messages[0].content += `\n\nJSON schema of the answer:\n${JSON.stringify(request.schema)}`;
    }
  }
  if (config.store === false) body.store = false;
  return body;
}

export function fromCompletion(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const usage = completion?.usage || {};
  return {
    text: choice?.message?.content ?? '',
    model: completion?.model,
    usage: {
      in: usage.prompt_tokens || 0,
      out: usage.completion_tokens || 0,
      total: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
    finishReason: choice?.finish_reason || null,
    raw: completion,
  };
}

export async function generate(request) {
  const completion = await client.chat.completions.create(chatBody(request));
  return fromCompletion(completion);
}

/** Start-up check that the endpoint answers: GET {base_url}/models. */
export async function preflight() {
  await client.models.list();
}

export async function process_msg(service_url, message) {
  if (!client) configure({ base_url: service_url, api_key_env: 'OPENAI_API_KEY' }, null, service_url);
  await runJob(message, { generate, provider });
}

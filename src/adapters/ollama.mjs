import got from 'got';

import {
  getTextFromFile,
  getFile,
  getFileBuffer,
  sendTextFile,
  sendJSONFile,
  sendError,
  withResponseTime,
} from '../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200';

function resolveOllamaEndpoint(rawServiceUrl) {
  let serviceUrl = String(rawServiceUrl || '').trim();
  if (!serviceUrl.startsWith('http')) {
    serviceUrl = `http://${serviceUrl}`;
  }

  if (serviceUrl.endsWith('/api/generate') || serviceUrl.endsWith('/api/chat')) {
    return serviceUrl;
  }

  return `${serviceUrl.replace(/\/$/, '')}/api/chat`;
}

function parseJsonSchema(rawSchema) {
  if (!rawSchema) return null;

  try {
    if (typeof rawSchema === 'string') {
      return JSON.parse(rawSchema);
    }

    if (typeof rawSchema === 'object') {
      return rawSchema;
    }
  } catch (e) {
    console.log('Invalid JSON schema, ignoring:', e.message);
  }

  return null;
}

function buildMetadata(response) {
  const promptEval = Number(response?.prompt_eval_count || 0);
  const evalCount = Number(response?.eval_count || 0);

  return {
    model: response?.model || 'unknown',
    tokens: {
      in: { count: promptEval, modality: 'TEXT' },
      out: { count: evalCount, modality: 'TEXT' },
      total: promptEval + evalCount,
    },
  };
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
    const endpoint = resolveOllamaEndpoint(service_url);

    console.log('**************** OLLAMA api ***************');
    console.log(endpoint);
    console.log(msg);

    if (!msg.file?.['@rid']) {
      throw new Error('No file found in message');
    }

    const readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId);

    let text = '';
    let imageBase64 = '';

    if (msg.file.type === 'text') {
      text = await getTextFromFile(readpath, 2000);
    } else if (msg.file.type === 'image') {
      imageBase64 = await getFileBuffer(readpath, true);
    }

    const systemPrompt = msg?.task?.params?.prompts?.content;
    if (!systemPrompt) {
      throw new Error('Prompts not found');
    }

    const messages = [{ role: 'system', content: systemPrompt }];

    if (text) {
      messages.push({ role: 'user', content: text });
    } else if (imageBase64) {
      // Ollama vision models expect base64 images in `images`.
      messages.push({ role: 'user', content: 'Analyze this image.', images: [imageBase64] });
    } else {
      messages.push({ role: 'user', content: 'Process this input.' });
    }

    const model = msg?.task?.model?.id || process.env.OLLAMA_MODEL || 'llama3.1';
    const temperature = Number(msg?.task?.params?.temperature ?? 0.7);
    let payload;

    if (endpoint.endsWith('/api/generate')) {
      const promptText = messages
        .filter((item) => item && typeof item.content === 'string')
        .map((item) => `${item.role}: ${item.content}`)
        .join('\n\n');

      payload = {
        model,
        prompt: promptText,
        stream: false,
        options: { temperature },
      };

      if (imageBase64) {
        payload.images = [imageBase64];
      }
    } else {
      payload = {
        model,
        messages,
        stream: false,
        options: { temperature },
      };
    }

    if (msg?.task?.params?.output_type === 'json') {
      const schema = parseJsonSchema(msg?.task?.params?.json_schema);
      payload.format = schema || 'json';
    }

    const response = await got.post(endpoint, {
      json: payload,
      timeout: { request: 120000 },
    }).json();

    const aiResponse = response?.message?.content || response?.response || '';
    const outputType = msg?.task?.params?.output_type === 'json' ? 'json' : 'text';

    let label = 'result.txt';
    if (msg.file.original_filename) {
      label = msg.file.original_filename + (outputType === 'json' ? '.json' : '.txt');
    } else if (msg.file.label) {
      label = msg.file.label + (outputType === 'json' ? '.json' : '.txt');
    }

    if (outputType === 'json') {
      let content;
      try {
        content = JSON.parse(aiResponse);
      } catch (e) {
        console.log('Error parsing JSON:', e.message);
        content = { error: 'Error parsing JSON', raw: aiResponse };
      }

      withResponseTime(msg, startedAt);
      await sendJSONFile({ label, content, type: 'json', ext: 'json' }, msg, url_md);
    } else {
      withResponseTime(msg, startedAt);
      await sendTextFile({ label, content: aiResponse, type: 'text', ext: 'txt' }, msg, url_md);
    }

    const metadata = buildMetadata(response);
    const output = { metadata, raw: response };
    withResponseTime(msg, startedAt);
    await sendJSONFile({ label: 'response.json', content: output, type: 'response', ext: 'json' }, msg, `${url_md}/metadata`);
  } catch (error) {
    console.log('pipeline error');
    console.log(error.status);
    console.log(error.code);
    console.error('ollama_api: Error processing request:', error.message);
    sendError(msg, error, MD_URL);
  }
}

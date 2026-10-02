import got from 'got'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import FormData from 'form-data';
import stream from 'node:stream';
import { promises as fs } from 'fs';
import { ensureDir } from 'fs-extra'

const KEEP_FILENAME = 1
const DEFAULT_USER = 'local.user@localhost'
const DATA_DIR = './data'
const SERVICE_TOKEN = String(process.env.SERVICE_TOKEN || '').trim()
const CALLBACK_PATH = '/api/nomad/process/files'
const ZIP_WAIT_MAX_MS = Number(process.env.ZIP_WAIT_MAX_MS || 10 * 60 * 1000)
const ZIP_POLL_MS = Number(process.env.ZIP_POLL_MS || 2000)

let warnedNoToken = false

// Headers for every call to the MessyDesk backend. The service token authenticates the consumer;
// `user` (the job's msg.userId) is added only when the call acts for that user, e.g. downloading
// their file. Without SERVICE_TOKEN the old admin `mail` header is sent, which the backend accepts
// only while SERVICE_AUTH_LEGACY_MAIL=true.
export function mdHeaders(user = null) {
  if(SERVICE_TOKEN) {
    const headers = { authorization: `Bearer ${SERVICE_TOKEN}` }
    if(user) headers.mail = user
    return headers
  }
  if(!warnedNoToken) {
    warnedNoToken = true
    console.log('WARN: SERVICE_TOKEN is not set, falling back to the legacy mail header')
  }
  return { mail: user || DEFAULT_USER }
}

// Callers pass either MD_URL or MD_URL + '/api/nomad/process/files'; both resolve to the backend root.
function backendRoot(url) {
  const base = String(url || '').replace(/\/+$/, '')
  const index = base.indexOf(CALLBACK_PATH)
  return index >= 0 ? base.slice(0, index) : base
}

// The backend stores `code` and `message` of the error on the error node; an Error object would
// serialize to {} (or to a huge got error), so send only the useful fields.
export function errorPayload(error) {
  if(!error) return { message: 'unknown error' }
  if(typeof error === 'string') return { message: error }
  const payload = { message: error.message || error.error || String(error) }
  if(error.code) payload.code = error.code
  const status = error.response?.statusCode || error.status
  if(status) payload.status = status
  const body = error.response?.body
  if(body) payload.details = (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 2000)
  return payload
}

function describeRequestError(prefix, e) {
  const detail = e?.response?.body || e?.message || String(e)
  return new Error(`${prefix}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

export async function createDataDir() {
	try {
		//await fs.ensureDir(data_dir)
		await ensureDir(DATA_DIR)
		await ensureDir(path.join(DATA_DIR, 'source'))
	} catch(e) {
    console.log('ERROR:', e)
		throw({message: 'Could not create data directory!' + e.message})
	}
}

export async function getServiceURL(nomad_url, request, service, nomadMode, wait) {
  console.log('request:', request)
  if(!nomadMode) {
    if(service.dev_url) return service.dev_url
    if(service.local_url) return service.local_url
    return 'http://dummy.service.com'
    //if(service.source_url) return service.source_url
  }
	// NOTE: Nomad service-catalog names must be RFC 1123 (no underscores)
	const url = nomad_url + `/service/${String(request.topic).replace(/_/g, '-')}`
  console.log('getting service url:', url)

	var service_url = ''
    try {
        var response = await got.get(url).json()
        while(response.length == 0 && wait) {
          console.log('waiting for service...')
          await sleep(1000)
          response = await got.get(url).json()
        }
        //console.log(response)
        if(response.length > 0) {
            service_url = `${response[0].Address}:${response[0].Port}`
        }
    } catch(e) {
        if(e.code == 'ECONNREFUSED')
          throw new Error(`Nomad not found from ${nomad_url}`)
        else
          throw describeRequestError('Error in nomad query', e)
    }
	return service_url
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Rewrites the job name and its matching `service { name = ... }` stanza(s) to TOPIC,
// so each TOPIC gets its own Nomad job/allocation instead of sharing one container.
export function applyTopicToNomadHcl(hcl, topic) {
  const jobNameMatch = hcl.match(/^job\s+"([^"]+)"/m)
  if (!jobNameMatch) return hcl
  const baseName = jobNameMatch[1]
  const nomadName = String(topic).replace(/_/g, '-')
  if (nomadName === baseName) return hcl

  let result = hcl.replace(/^(job\s+")([^"]+)(")/m, `$1${nomadName}$3`)
  result = result.replace(/(service\s*\{[^}]*?name\s*=\s*")([^"]+)(")/gs, (match, prefix, name, suffix) => {
    return name === baseName ? `${prefix}${nomadName}${suffix}` : match
  })
  return result
}

export async function createService(md_url, service, options = {}) {
  const url = md_url + `/api/nomad/service/${service}`
  console.log('creating service:', url)
  try {
      const requestOptions = { headers: mdHeaders() }
      if(options.nomadHclPath) {
        let nomadHcl = await fs.readFile(options.nomadHclPath, 'utf-8')
        nomadHcl = applyTopicToNomadHcl(nomadHcl, service)
        requestOptions.json = { nomad_hcl: nomadHcl }
      }
      var response = await got.post(url, requestOptions).json()  
      return response
  } catch(e) {
      if(e.code == 'ECONNREFUSED')
        throw new Error(`Messydesk not found from ${md_url}`)
      else
        throw describeRequestError('Error in starting service with MessyDesk API query', e)
  }
}


export async function stopService(md_url, service) {
  const url = md_url + `/api/nomad/service/${service}`
  try {
      const options = { headers: mdHeaders() }
      var response = await got.delete(url, options).json()  
      return response
  } catch(e) {
      if(e.code == 'ECONNREFUSED')
        throw new Error(`Messydesk not found from ${md_url}`)
      else
        throw describeRequestError('Error in stopping service with MessyDesk API query', e)
  }
}


export async function getFile(md_url, file_rid, user, source) {
  const sourcePath = source ? source : '';
  const filename = uuidv4();
  const writepath = path.join(DATA_DIR, 'source', filename);
  const file_url = `${md_url}/api/files/${file_rid.replace('#', '')}${sourcePath}`;

  try {
    await pipeline(
      got.stream(file_url, { headers: mdHeaders(user) }),
      createWriteStream(writepath)
    );
    console.log(`File downloaded to ${writepath}`);
    return writepath;
  } catch (error) {
    console.error(`Error during file download or write: ${error.message}`);
    throw error;
  }
}

// The backend builds set ZIPs asynchronously: start a job, poll it, then download the result.
export async function getFilesZip(md_url, set_rid, user, source) {
  const filename = uuidv4();
  const writepath = path.join(DATA_DIR, 'source', filename);
  const headers = mdHeaders(user);
  const job = await got.post(`${md_url}/api/sets/${set_rid.replace('#', '')}/files/zip/jobs`, { headers }).json();

  const startedAt = Date.now();
  while(true) {
    const status = await got.get(`${md_url}${job.status_url}`, { headers, throwHttpErrors: false });
    const body = JSON.parse(status.body || '{}');
    if(body.status === 'ready') break;
    if(status.statusCode >= 400 || body.status === 'failed') {
      throw new Error(`Zip job ${job.job_id} failed: ${body.message || status.statusCode}`);
    }
    if(Date.now() - startedAt > ZIP_WAIT_MAX_MS) {
      throw new Error(`Zip job ${job.job_id} not ready after ${ZIP_WAIT_MAX_MS} ms`);
    }
    await sleep(ZIP_POLL_MS);
  }

  try {
    await pipeline(
      got.stream(`${md_url}${job.download_url}`, { headers }),
      createWriteStream(writepath)
    );
    console.log(`File downloaded to ${writepath}`);
    return writepath;
  } catch (error) {
    console.error(`Error during file download or write: ${error.message}`);
    throw error;
  }
}

export function getElapsedSeconds(startTime) {
  if(!startTime) return null
  const end = process.hrtime(startTime)
  return parseFloat((end[0] + end[1] / 1e9).toFixed(3))
}

export function withResponseTime(message, startTime) {
  if(!message || !startTime) return message
  const seconds = getElapsedSeconds(startTime)
  if(seconds === null) return message

  message.response = {
    ...(message.response || {}),
    time: seconds,
  }
  return message
}

// get output files from service and send them to MessyDesk
export async function getFilesFromStore(response, service_url, message, md_url, file_labels, startedAt = null) {

  if(Array.isArray(file_labels) && file_labels.length > 0) {
    message.file.label = file_labels[0]
  }

    if(response.uri) {
      if(!message.file) { message.file = {} }
   
      // download array of files
      if(Array.isArray(response.uri)) {
        const total = response.uri.length
        var count = 0
        
        for(var file of response.uri) {
          let url
          if(file.uri) url = file.uri
          else url = file
          // if service return array of files, then we keep those filenames unless file_labels is set
          message.file_total = total
          message.file_count = count + 1
          if (file && file.thumb_name) {
            message.thumb_name = file.thumb_name
          } else if (message.thumb_name) {
            delete message.thumb_name
          }
          let filedata;
          if(file_labels && file_labels.length > count) {
            message.file.label = file_labels[count];
            filedata = await downloadFile(url, service_url);
          } else if (file.label) {
            message.file.label = file.label;
            filedata = await downloadFile(url, service_url);
          } else {
            filedata = await downloadFile(url, service_url, KEEP_FILENAME);
          }
          // A type given by the service wins over the one guessed from the URL (e.g. binary outputs).
          if (file && typeof file.type === 'string' && file.type) filedata.type = file.type
          withResponseTime(message, startedAt)
          await sendFile(filedata, message, md_url)
          count++
        }
      // download single file
      } else {
        message.file_total = 1
        message.file_count = 1
        if(response.label) message.file.label = response.label
        const filedata = await downloadFile(response.uri, service_url)
        withResponseTime(message, startedAt)
        await sendFile(filedata, message, md_url)
      }
    } else {
      console.log('File download not found!')
    }
  }



async function downloadFile(file_url, service_url, keep_filename) {

  const uuid = uuidv4()
  var ext = path.extname(file_url).replace('.', '')
  var type = 'text'
  if(['png','jpg','jpeg'].includes(ext)) type = 'image'
  if(['pdf'].includes(ext)) type = 'pdf'
  if(['xml'].includes(ext)) type = 'xml'
  if(['json'].includes(ext)) type = 'json'

  // JSON can have sub types like "human.json"
  if(type == 'json') {
    // if file_url contains two dots, then it is a sub type
    type = extractDoubleExtension(file_url, type)
  }

  const filepath = `data/${type}_${uuid}.${ext}`
  console.log('type: ', type)
  console.log('ext: ', ext)
  console.log('uuid: ', uuid)
  console.log('filepath: ', filepath)
  console.log('getting file: ', service_url + file_url)

  const readStream = got.stream(service_url + file_url)
  const writeStream = createWriteStream(filepath)
  await pipeline(readStream, writeStream)
  if(keep_filename) 
    return {path:filepath, type: type, ext: ext, label: path.basename(file_url)}
  else
    return {path:filepath, type: type, ext: ext}
}



async function sendFile(filedata, message, md_url) {

  message.file.type = filedata.type
  message.file.extension = filedata.ext
  message.file.label = message.file.label + '.' + filedata.ext
  
  if(filedata.label)
    message.file.label = filedata.label

  const readStream = createReadStream(filedata.path);
  const formData = new FormData();
  formData.append('content', readStream);
  formData.append('message', JSON.stringify(message),{contentType: 'application/json', filename: 'message.json'});
  const response = await got.post(md_url, {
    body: formData,
    headers: {
      ...formData.getHeaders(),
      ...mdHeaders()
    }
  });
  if(response.ok)
    console.log('File streamed successfully')
  else 
    console.log('File not streamed')
}

// Records a failed job in MessyDesk (an error node under the process). `url_md` may be MD_URL or
// the callback URL. Never throws: a failing error report must not hide the original error.
export async function sendError(data, error, url_md) {
  try {
      await got.post(backendRoot(url_md) + CALLBACK_PATH + '/error', {json: {error: errorPayload(error), message: data || {}}, headers: mdHeaders()})
  } catch (e) {
      console.log('sending error failed:', e.message)
  }
}

function extractDoubleExtension(fileName, type) {
  if(!fileName) return type;
  const parts = fileName.split('.');
  
  if(parts.length == 2) return parts[parts.length - 1];
  return parts[parts.length - 2] + '.' + parts[parts.length - 1];
}


export async function sendJSONFile(filedata, message, md_url) {

  message.file.type = filedata.type
  message.file.extension = filedata.ext
  
  if(filedata.label)
    message.file.label = filedata.label

  const jsonData = JSON.stringify(filedata.content, null, 2)
  const formData = new FormData();

  // Append the text file to the form data
  formData.append('content', jsonData, {
    filename: filedata.label,
    contentType: 'application/json', // Set the content type to application/json
  });

  formData.append('message', JSON.stringify(message),{contentType: 'application/json', filename: 'message.json'});


  const response = await got.post(md_url, {
    body: formData,
    headers: {
      ...formData.getHeaders(),
      ...mdHeaders()
    }
  });

  if(response.ok)
    console.log('File send successfully')
  else 
    console.log('File not streamed')
}

export async function sendStringTextFile(filedata, message, md_url) {
  await sendTextFile(filedata, message, md_url, true)
}

export async function sendTextFile(filedata, message, md_url, STRING_CONTENT = false) {

  message.file.type = filedata.type
  message.file.extension = filedata.ext
  
  if(filedata.label)
    message.file.label = filedata.label

  const formData = new FormData();

  if(STRING_CONTENT) {
    // Use the string directly - no need for Buffer conversion
    const textContent = filedata.content;
      // Append the text file to the form data
    formData.append('content', textContent, {
      filename: filedata.label,
      contentType: 'text/plain', // Set the content type to text/plain
    });
  } else {
    const buffer = Buffer.from(filedata.content, 'utf-8');
    formData.append('content', buffer, {
      filename: filedata.label,
      contentType: 'text/plain', // Set the content type to text/plain
    });
  }


  formData.append('message', JSON.stringify(message),{contentType: 'application/json', filename: 'message.json'});


  const response = await got.post(md_url, {
    body: formData,
    headers: {
      ...formData.getHeaders(),
      ...mdHeaders()
    }
  });

  if(response.ok)
    console.log('File send successfully')
  else 
    console.log('File not streamed')
}

export async function getTextFromFile(filepath, limit) {
  console.log('reading file: ', filepath)
  var text = await fs.readFile(filepath, 'utf8');
  // limit text 
  if(limit) {
    if(text.length > limit) text = text.substring(0, limit)
  }
  return text
}

export async function getFileBuffer(filepath, asBase64 = false) {
  const buffer = await fs.readFile(filepath);
  if (asBase64) {
    return buffer.toString('base64');
  }
  return buffer;
}

  export function printInfo(name, nomad_url, md_url) {

    console.log('MessyDesk consumer: ', name)
    console.log('-------------------')
    console.log('nomad:', nomad_url)
    console.log('messydesk:', md_url)
    console.log('___________________')
  }


// Tells MessyDesk that a job finished without output files. `md_url` may be MD_URL or the callback URL.
export async function sendDone(message, md_url) {
  await got.post(backendRoot(md_url) + CALLBACK_PATH + '/done', {json: message, headers: mdHeaders()})
}

function normalizeDescriptor(descriptor, topic) {
  if(!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
  const normalized = { ...descriptor };
  if(!normalized.id) normalized.id = topic;
  if(typeof normalized.id !== 'string' || normalized.id.trim().length === 0) return null;
  if(normalized.tasks !== undefined && (typeof normalized.tasks !== 'object' || Array.isArray(normalized.tasks))) {
    return null;
  }
  return normalized;
}

async function readJSONIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch(error) {
    if(error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch(error) {
    if(error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function getBackendServiceDescriptor(md_url, topic) {
  try {
    const descriptor = await got.get(`${md_url}/api/services/${topic}`, { headers: mdHeaders() }).json();
    return normalizeDescriptor(descriptor, topic);
  } catch(error) {
    return null;
  }
}

export async function getAdapterServiceDescriptor(topic, adapterName = null, descriptorPath = null) {
  const candidates = [];
  const explicitDescriptorPath = descriptorPath
    ? (path.isAbsolute(descriptorPath) ? descriptorPath : path.resolve(process.cwd(), descriptorPath))
    : null;

  if(explicitDescriptorPath) {
    candidates.push(explicitDescriptorPath);
  }

  candidates.push(
    path.join(process.cwd(), '.descriptors', topic, 'service.json'),
    path.join(process.cwd(), '.descriptors', topic, 'service.json.json'),
    path.join(process.cwd(), 'descriptors', topic, 'service.json'),
    path.join(process.cwd(), 'descriptors', topic, 'service.json.json'),
    path.join(process.cwd(), 'descriptors', `${topic}.json`),
    path.join(process.cwd(), 'src', 'adapters', `${topic}.service.json`),
  );

  if(adapterName) {
    candidates.push(path.join(process.cwd(), '.descriptors', adapterName, 'service.json'));
    candidates.push(path.join(process.cwd(), 'descriptors', adapterName, 'service.json'));
    candidates.push(path.join(process.cwd(), 'src', 'adapters', `${adapterName}.service.json`));
  }

  for(const candidate of candidates) {
    const parsed = await readJSONIfExists(candidate);
    if(parsed) {
      const normalized = normalizeDescriptor(parsed, topic);
      if(normalized) return normalized;

      if(explicitDescriptorPath && candidate === explicitDescriptorPath) {
        throw new Error(`Invalid descriptor at ${explicitDescriptorPath}: descriptor must be a JSON object with valid id/tasks fields`);
      }
    }
  }

  if(explicitDescriptorPath) {
    throw new Error(`Descriptor file not found: ${explicitDescriptorPath}`);
  }

  return null;
}

export async function resolveNomadHclPath(options = {}) {
  const descriptorPath = options.descriptorPath || null;
  const explicitDescriptorPath = descriptorPath
    ? (path.isAbsolute(descriptorPath) ? descriptorPath : path.resolve(process.cwd(), descriptorPath))
    : null;

  if(explicitDescriptorPath) {
    const siblingNomadHcl = path.join(path.dirname(explicitDescriptorPath), 'nomad.hcl');
    if(await pathExists(siblingNomadHcl)) {
      return siblingNomadHcl;
    }
  }

  return null;
}

export async function getRuntimeConfigDescriptor(service_url, topic) {
  if(!service_url) return null;
  const base = service_url.startsWith('http') ? service_url : `http://${service_url}`;
  try {
    const descriptor = await got.get(`${base}/config`, { timeout: { request: 5000 } }).json();
    return normalizeDescriptor(descriptor, topic);
  } catch(error) {
    return null;
  }
}

export async function registerServiceDescriptor(md_url, descriptor, source = 'runtime') {
  if(!descriptor) return null;
  const response = await got.post(`${md_url}/api/services/register`, {
    json: {
      source,
      service: descriptor,
    },
    headers: mdHeaders(),
  }).json();
  return response;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function registerServiceDescriptorWithRetry({
  mdUrl,
  descriptor,
  source = 'runtime',
  maxAttempts = 5,
  initialDelayMs = 500,
  maxDelayMs = 10000,
}) {
  if(!descriptor) return null;

  let attempt = 0;
  let delayMs = initialDelayMs;
  let lastError = null;

  while(attempt < maxAttempts) {
    attempt += 1;
    try {
      return await registerServiceDescriptor(mdUrl, descriptor, source);
    } catch(error) {
      lastError = error;
      if(attempt >= maxAttempts) {
        break;
      }
      await sleepMs(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }

  throw lastError;
}

export async function resolveDescriptorSourceChain({ topic, adapterName = null, descriptorPath = null, mdUrl, serviceUrl = null }) {
  const runtimeDescriptor = await getRuntimeConfigDescriptor(serviceUrl, topic);
  if(runtimeDescriptor) {
    return { descriptor: runtimeDescriptor, source: 'runtime-config' };
  }

  const adapterDescriptor = await getAdapterServiceDescriptor(topic, adapterName, descriptorPath);
  if(adapterDescriptor) {
    return { descriptor: adapterDescriptor, source: descriptorPath ? 'explicit-descriptor' : 'adapter-descriptor' };
  }

  const backendDescriptor = await getBackendServiceDescriptor(mdUrl, topic);
  if(backendDescriptor) {
    return { descriptor: backendDescriptor, source: 'backend-registry' };
  }

  return { descriptor: { id: topic, tasks: {} }, source: 'topic-fallback' };
}
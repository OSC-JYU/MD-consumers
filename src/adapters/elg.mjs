// Generic adapter for services with a `/process` endpoint (`elg` and `elg_fs` are the same adapter).
//
// The service decides how files travel:
//   disk  the service reads `message.file.path` itself and writes its outputs to MessyDesk's
//         data/<db>/tmp; it answers `response.type = "disk"` with `response.files[]`.
//   http  the adapter uploads the input as `content` (a set as a zip, plus `source` when there is
//         one); the service answers `response.uri` and the adapter downloads the outputs.
// Which one a service uses comes from its /config (`adapter: elg_fs` = disk); the answer is then
// handled by what it contains, so both kinds of answer work either way.
//
// Write policy: the adapter writes every downloaded output straight into data/<db>/tmp (MD_PATH)
// and reports it with the small /files/tmp callback; no file is uploaded to the backend. Inputs
// are read from disk too. Only without MD_PATH does it fall back to the old API transfers.

import FormData from 'form-data';
import fs from 'fs';
import got from 'got';
import path from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';

import {
    getFile,
    getFilesZip,
    getFilesFromStore,
    getElapsedSeconds,
    mdHeaders,
    mdRoot,
    resolveMdPath,
    tmpDirFor,
    sendDone,
    sendError,
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const CONFIG_TTL_MS = 60 * 1000

const configCache = new Map()
let warnedNoMdPath = false


/** 'disk' or 'http', from the service's /config (cached for a minute). */
async function serviceStorage(serviceUrl) {
    const cached = configCache.get(serviceUrl)
    if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.mode
    let mode = 'http'
    try {
        const config = await got.get(`${serviceUrl}/config`, { timeout: { request: 5000 } }).json()
        const storage = String(config?.storage_mode || config?.adapter || '').toLowerCase()
        if (storage === 'disk' || storage === 'elg_fs') mode = 'disk'
    } catch (err) {
        console.log('service /config not available, assuming http storage:', err.message)
    }
    configCache.set(serviceUrl, { mode, at: Date.now() })
    return mode
}


function inferOutputType(extension) {
    const ext = String(extension || '').toLowerCase()
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) return 'image'
    if (ext === 'csv') return 'csv'
    if (ext === 'json') return 'json'
    if (ext === 'pdf') return 'pdf'
    if (ext === 'xml') return 'xml'
    return 'text'
}

/** `x.ocr.json` -> `ocr.json`; other JSON -> `json`. */
function typeFromName(name, extension) {
    const type = inferOutputType(extension)
    if (type !== 'json') return type
    const parts = path.basename(name).split('.')
    return parts.length > 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : 'json'
}

function extOf(name) {
    return path.extname(String(name || '')).replace('.', '').toLowerCase()
}


// ---- outputs ------------------------------------------------------------------------------

/**
 * One entry per output: { tmpName } already in data/<db>/tmp (disk answer), or { url } to fetch
 * from the service (stored answer); label/type/extension describe the new file node.
 */
export function serviceOutputs(serviceResult, msg) {
    const payload = serviceResult?.response || {}
    const outputs = []

    if (Array.isArray(payload.files)) {
        for (const file of payload.files) {
            if (!file || (!file.path && !file.label)) continue
            const ref = String(file.path || file.label)
            const label = file.label || path.basename(ref)
            const extension = (file.extension || extOf(label) || extOf(ref)).toLowerCase()
            outputs.push({
                tmpName: path.basename(ref),
                label,
                extension,
                type: file.type || inferOutputType(extension),
                page_number: file.page_number,
                thumb_name: file.thumb_name,
            })
        }
        return outputs
    }

    if (!payload.uri) return outputs
    const many = Array.isArray(payload.uri)
    const items = many ? payload.uri : [{ uri: payload.uri, label: payload.label }]
    for (const item of items) {
        const url = typeof item === 'string' ? item : item?.uri
        if (typeof url !== 'string' || !url) continue
        const extension = extOf(url)
        const given = typeof item === 'object' ? item.label : null
        // Old convention: a label comes without extension and gets one; an unlabelled output keeps
        // its file name, or is named after the input when it is the only one.
        let label
        if (given) label = String(given).toLowerCase().endsWith(`.${extension}`) ? given : `${given}.${extension}`
        else if (!many) label = `${msg?.file?.label || 'output'}.${extension}`
        else label = path.basename(url)
        outputs.push({
            url,
            label,
            extension,
            type: (typeof item === 'object' && item.type) || typeFromName(url, extension),
            page_number: typeof item === 'object' ? item.page_number : undefined,
            thumb_name: typeof item === 'object' ? item.thumb_name : undefined,
        })
    }
    return outputs
}

/** Downloads a service output into data/<db>/tmp: written under a temporary name, then renamed. */
async function downloadToTmp(serviceUrl, url, msg) {
    const dir = tmpDirFor(msg)
    const name = `elg_${uuidv4()}${path.extname(url)}`
    const partial = path.join(dir, `.${name}.part`)
    const full = url.startsWith('http://') || url.startsWith('https://') ? url : serviceUrl + url
    await pipeline(got.stream(full), fs.createWriteStream(partial, { mode: 0o644 }))
    await fs.promises.rename(partial, path.join(dir, name))
    return name
}

export function callbackMessage(msg, serviceResult, output, index, total, startedAt = null) {
    const sourceFile = msg.file || {}
    const parentTotal = Number(msg?.batch_total_files || msg?.total_files || 0)
    const parentCurrent = Number(msg?.current_file || 0)
    const inBatch = parentTotal > 0 && parentCurrent > 0
    const { files: _files, ...rest } = msg
    const message = {
        ...rest,
        ...(serviceResult?.message && typeof serviceResult.message === 'object' ? serviceResult.message : {}),
        file: {
            ...sourceFile,
            type: output.type,
            extension: output.extension,
            label: output.label,
            source: sourceFile,
            ...(Number.isFinite(Number(output.page_number)) ? { page_number: Number(output.page_number) } : {}),
        },
        target: msg.target || sourceFile.project_rid,
        // Set processing keeps the batch counters; otherwise one job's outputs count themselves.
        total_files: inBatch ? parentTotal : total,
        current_file: inBatch ? parentCurrent : index + 1,
        file_total: total,
        file_count: index + 1,
        role: msg.role || (msg?.task?.id === 'thumbnail' ? 'thumbnail' : undefined),
        response: { ...(msg.response || {}), ...(serviceResult?.response || {}) },
    }
    if (inBatch) message.batch_total_files = parentTotal
    if (output.thumb_name) message.thumb_name = output.thumb_name
    else delete message.thumb_name
    delete message.response.files
    delete message.response.uri
    const elapsed = getElapsedSeconds(startedAt)
    if (elapsed !== null) message.response.time = elapsed
    return message
}

async function reportTmpFile(message, tmpName) {
    await got.post(`${MD_URL}/api/nomad/process/files/tmp`, {
        json: { message, tmp_path: tmpName },
        headers: mdHeaders(),
    }).json()
}


// ---- inputs -------------------------------------------------------------------------------

/** An input for an http-storage service: from disk when MD_PATH is set, else from the API. */
async function inputPath(msg, ref) {
    const local = mdRoot() ? resolveMdPath(ref?.path) : null
    if (local) return { path: local, temporary: false }
    return { path: await getFile(MD_URL, ref['@rid'], msg.userId), temporary: true }
}

async function buildForm(msg, storage) {
    const form = new FormData()
    const cleanup = []
    if (storage === 'http') {
        if (msg.input_set) {
            const zip = await getFilesZip(MD_URL, msg.input_set, msg.userId)
            cleanup.push(zip)
            form.append('content', fs.createReadStream(zip))
        } else {
            const input = await inputPath(msg, msg.file)
            if (input.temporary) cleanup.push(input.path)
            form.append('content', fs.createReadStream(input.path), { filename: path.basename(input.path) })
        }
        if (msg.file.source?.['@rid']) {
            const source = await inputPath(msg, msg.file.source)
            if (source.temporary) cleanup.push(source.path)
            form.append('source', fs.createReadStream(source.path), { filename: path.basename(source.path) })
        }
    }
    form.append('message', JSON.stringify(msg), { contentType: 'application/json', filename: 'message.json' })
    return { form, cleanup }
}


// ---- main ---------------------------------------------------------------------------------

export async function process_msg(service_url, message) {
    let msg
    const startedAt = process.hrtime()
    const url_md = `${MD_URL}/api/nomad/process/files`

    try {
        msg = message.json()
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, { error: 'invalid message payload!' }, url_md)
        return
    }

    let sent = 0
    let cleanup = []
    try {
        if (!service_url.startsWith('http')) service_url = 'http://' + service_url
        if (!msg.file?.['@rid']) throw new Error('No file found in message')
        const storage = await serviceStorage(service_url)
        console.log(`**************** ELG (${storage}) ${service_url} ***************`)

        const built = await buildForm(msg, storage)
        cleanup = built.cleanup
        const serviceResult = await got.post(`${service_url}/process`, {
            body: built.form,
            headers: built.form.getHeaders(),
        }).json()

        const outputs = serviceOutputs(serviceResult, msg)
        if (outputs.some((o) => o.url) && !mdRoot()) {
            // No shared disk: the old way, outputs uploaded to the backend.
            if (!warnedNoMdPath) {
                console.log('WARN: MD_PATH is not set; outputs are uploaded to the backend instead of written to its disk')
                warnedNoMdPath = true
            }
            msg.response = { ...(msg.response || {}), time: getElapsedSeconds(startedAt) }
            if (serviceResult?.message) msg = { ...msg, ...serviceResult.message }
            await getFilesFromStore(serviceResult.response, service_url, msg, url_md, null, startedAt)
            return
        }

        for (let i = 0; i < outputs.length; i += 1) {
            const output = outputs[i]
            const tmpName = output.url ? await downloadToTmp(service_url, output.url, msg) : output.tmpName
            await reportTmpFile(callbackMessage(msg, serviceResult, output, i, outputs.length, startedAt), tmpName)
            sent += 1
        }
        console.log('outputs reported:', sent)

        if (outputs.length === 0) {
            msg.file.metadata = { ...msg.file.metadata, ...(serviceResult?.metadata || {}) }
            msg.response = { ...(msg.response || {}), ...(serviceResult?.response || {}) }
            const elapsed = getElapsedSeconds(startedAt)
            if (elapsed !== null) msg.response.time = elapsed
            delete msg.files
            await sendDone(msg, MD_URL)
        }
    } catch (error) {
        const body = error?.response?.body
        console.error(`elg: ${error.message}${body ? ' ' + String(body).slice(0, 500) : ''}`)
        if (sent > 0) {
            // Some outputs already exist: a retry would duplicate them, so record the error instead.
            await sendError(msg, error, MD_URL)
            return
        }
        // Rethrown so that the backend retries the job; the consumer loop records the error after
        // the last attempt.
        throw error
    } finally {
        for (const file of cleanup) fs.promises.rm(file, { force: true }).catch(() => {})
    }
}

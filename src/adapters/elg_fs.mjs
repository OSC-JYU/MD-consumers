import FormData from 'form-data';
import got from 'got'
import path from 'path';

import { 
    sendError
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'


function inferOutputType(extension) {
    const ext = String(extension || '').toLowerCase()
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) return 'image'
    if (ext === 'csv') return 'csv'
    if (ext === 'json') return 'json'
    if (ext === 'pdf') return 'pdf'
    return 'text'
}


function getExtFromLabel(label) {
    return path.extname(label || '').replace('.', '').toLowerCase()
}


function normalizeServiceFiles(serviceResponse) {
    const files = []
    const payload = serviceResponse?.response || serviceResponse || {}

    if (Array.isArray(payload?.files)) {
        for (const file of payload.files) {
            if (!file || (!file.path && !file.label)) continue
            const fileRef = String(file.path || file.label)
            const label = file.label || path.basename(fileRef)
            const extension = (file.extension || getExtFromLabel(label) || path.extname(fileRef).replace('.', '')).toLowerCase()
            const type = file.type || inferOutputType(extension)
            files.push({ fileRef, label, extension, type })
        }
        return files
    }

    if (!Array.isArray(payload?.uri)) {
        return files
    }

    for (const item of payload.uri) {
        const value = item?.uri || item
        if (typeof value !== 'string' || value.startsWith('/files/')) continue
        if (value.startsWith('http://') || value.startsWith('https://')) continue

        const fileRef = value
        const label = item?.label || path.basename(fileRef)
        const extension = (item?.extension || getExtFromLabel(label) || path.extname(fileRef).replace('.', '')).toLowerCase()
        const type = item?.type || inferOutputType(extension)
        files.push({ fileRef, label, extension, type })
    }

    return files
}


async function sendTmpFilesToMessyDesk(msg, serviceResponse) {
    const files = normalizeServiceFiles(serviceResponse)
    if (files.length === 0) {
        return { sent: 0, failed: 0 }
    }

    let sent = 0
    let failed = 0
    const urlTmp = `${MD_URL}/api/nomad/process/files/tmp`
    const sourceFile = msg.file || {}

    for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const callbackTmpName = path.basename(String(file.fileRef || file.label || ''))
        if (!callbackTmpName || callbackTmpName === '.' || callbackTmpName === '..') {
            failed += 1
            continue
        }

        const callbackMessage = {
            file: {
                ...sourceFile,
                type: file.type,
                extension: file.extension,
                label: file.label,
                source: sourceFile,
            },
            target: msg.target || sourceFile.project_rid,
            process: msg.process,
            output_set: msg.output_set,
            set_process: msg.set_process,
            userId: msg.userId,
            total_files: files.length,
            current_file: i + 1,
            service: msg.service,
            task: msg.task,
            response: serviceResponse?.response,
        }

        try {
            await got.post(urlTmp, {
                json: {
                    message: callbackMessage,
                    tmp_path: callbackTmpName,
                },
                headers: {
                    'Content-Type': 'application/json',
                    'mail': DEFAULT_USER,
                },
            }).json()
            sent += 1
        } catch (err) {
            failed += 1
            let details = ''
            try {
                const body = err?.response?.body
                if (typeof body === 'string' && body.length > 0) {
                    details = body
                } else if (body && typeof body === 'object') {
                    details = JSON.stringify(body)
                }
            } catch (_) {
                details = ''
            }

            console.log('tmp callback failed', {
                message: err.message,
                statusCode: err?.response?.statusCode,
                details,
                serviceId: msg?.service?.id,
                taskId: msg?.task?.id,
                processRid: msg?.process?.['@rid'],
                sourceRid: sourceFile?.['@rid'],
                outputSet: msg?.output_set,
                tmpPath: callbackTmpName,
                originalPath: file?.fileRef,
                label: file?.label,
            })
        }
    }

    return { sent, failed }
}


export async function process_msg(service_url, message) {

    let msg
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        msg = message.json()
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** ELG_fs api ***************')
        console.log(msg)

        
        const formData = new FormData();
        formData.append('message', JSON.stringify(msg), {contentType: 'application/json', filename: 'message.json'});

        // send payload to service endpoint 
        var url = `${service_url}/process`
        console.log(url)
        const serviceResult = await got.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        }).json();
        
        console.log(serviceResult.response.files)

        const outputInfo = await sendTmpFilesToMessyDesk(msg, serviceResult)
        console.log('tmp outputs', outputInfo)

        if (serviceResult?.response?.type === 'disk') {
            return
        }

        if ((outputInfo.sent + outputInfo.failed) > 0) {
            return
        }

        const metadata = serviceResult?.metadata || serviceResult || {}
        msg.file.metadata = {...msg.file.metadata, ...metadata}

        // Notify MD that we are done
        const done_md = `${MD_URL}/api/nomad/process/files/done`
        const done_md_response = await got.post(done_md, {
            body: JSON.stringify(msg),
            headers: {
                'Content-Type': 'application/json',
                'mail': DEFAULT_USER
            },
        }).json();
        
        console.log(done_md_response)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(msg, error, MD_URL)
    }
}

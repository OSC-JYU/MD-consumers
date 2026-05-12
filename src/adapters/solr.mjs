import got from 'got'
import { existsSync, statSync } from 'fs'
import path from 'path';

import { 
    getTextFromFile,
    sendJSONFile,
    sendError,
    withResponseTime
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'
const MD_PATH_ENV = process.env.MD_PATH || ''
const CONTAINER_MODE = String(process.env.CONTAINER || '').trim().toLowerCase()
const STORAGE_MODE = String(process.env.STORAGE_MODE || process.env.FILE_STORAGE_MODE || 'disk').trim().toLowerCase()


function resolveMdRoot(mdPathEnv, containerMode) {
    if (STORAGE_MODE === 'disk' && (!mdPathEnv || !String(mdPathEnv).trim())) {
        throw new Error('MD_PATH must be set when STORAGE_MODE=disk')
    }

    const candidates = []
    if (mdPathEnv && String(mdPathEnv).trim()) {
        const raw = path.resolve(String(mdPathEnv).trim())
        if (path.basename(raw) === 'data') {
            candidates.push(path.dirname(raw))
        }
        candidates.push(raw)
    }

    if (containerMode) {
        candidates.push('/app')
    }

    candidates.push(path.resolve('.'))
    console.log('MessyDesk data root candidates:', candidates)

    const seen = new Set()
    const existingDirs = []
    for (const candidate of candidates) {
        if (seen.has(candidate)) {
            continue
        }
        seen.add(candidate)

        if (hasDataDir(candidate)) {
            return candidate
        }

        if (directoryExists(candidate)) {
            existingDirs.push(candidate)
        }
    }

    if (existingDirs.length > 0) {
        return existingDirs[0]
    }

    throw new Error(
        'Could not resolve MessyDesk data root. Set MD_PATH to the MessyDesk root (contains data/). If running in container, set CONTAINER=true and MD_PATH=/app.'
    )
}


function directoryExists(candidate) {
    try {
        return typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate) && statSync(candidate).isDirectory()
    } catch {
        return false
    }
}


function hasDataDir(candidate) {
    try {
        const dataDir = path.join(candidate, 'data')
        console.log(`Checking for data directory at ${dataDir}`)
        return existsSync(dataDir) && statSync(dataDir).isDirectory()
    } catch {
        return false
    }
}


function resolveMdRelativePath(relativePath) {
    if (!relativePath || !String(relativePath).trim()) {
        throw new Error('Invalid file.path')
    }

    if (path.isAbsolute(relativePath)) {
        throw new Error('file.path must be relative to MD_PATH')
    }

    const mdRoot = path.resolve(MD_ROOT)
    const resolved = path.resolve(mdRoot, relativePath)
    if (resolved !== mdRoot && !resolved.startsWith(mdRoot + path.sep)) {
        throw new Error('file.path is outside MD_PATH')
    }

    return resolved
}


const MD_ROOT = resolveMdRoot(MD_PATH_ENV, ['1', 'true', 'yes', 'on'].includes(CONTAINER_MODE))


export async function process_msg(service_url, message) {
    
    let msg
    const startedAt = process.hrtime()
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        msg = message.json()
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        let index_data 
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** indexing API ***************')



        if(msg.task.id == 'index') {
            const readpath = resolveMdRelativePath(msg?.file?.path)
            // read content from file
            const content = await getTextFromFile(readpath)
            const fileRid = String(msg?.file?.['@rid'] || '')
            const processRid = String(msg?.process?.['@rid'] || msg?.set_process || '')
            const projectRid = String(msg?.project_rid || msg?.file?.project_rid || '')
            const setRid = String(msg?.set_rid || msg?.input_set || msg?.output_set || '')
            const fileRidNorm = fileRid.replace('#', '')
            const processRidNorm = processRid.replace('#', '') || 'no_process'

            index_data = [{
                id: `${fileRidNorm}:${processRidNorm}`,
                label: msg.file.label,
                owner: msg.userId,
                node: fileRid,
                process: processRid,
                project: projectRid,
                set: setRid,
                type: msg.file.type,
                description: msg.file.description,
                fulltext: content
            }]

            if(msg.set_process) {
                index_data[0].set_process = msg.set_process
            }

        } else if(msg.task.id == 'delete') {
            const fileRid = String(msg?.file?.['@rid'] || '').replace(/"/g, '\\"')
            const owner = String(msg?.userId || '').replace(/"/g, '\\"')
            const query = owner
                ? `node:"${fileRid}" AND owner:"${owner}"`
                : `node:"${fileRid}"`

            index_data = {
                delete: { query }
            }
        } else {

            console.log('invalid task')
            return {error: 'invalid task'}
        }
        
        if(Array.isArray(index_data) && !index_data.length) {
            console.log('no index data')
            return
        } 

        console.log(index_data)
        const options= {
            body: JSON.stringify(index_data),
            headers: {
            'Content-Type': 'application/json'
            }
        };

        // // send payload to SOLR 
        //var url = `${service_url}/solr/messydesk/update?commit=true`
        var url = `${service_url}/solr/messydesk/update?commit=true`
   
       // const SOLR_CORE = process.env.SOLR_CORE || 'messydesk'
        console.log(url)
        const response = await got.post(url, options)
        console.log(response.body)
        console.log(response.statusCode)

        // Solr indexing is metadata-only by default: do not emit synthetic output files unless explicitly requested.
        const shouldEmitOutputFile = msg?.task?.id === 'index'
            ? msg?.output_file === true
            : msg?.output_file !== false
        const isLastFile = Number(msg?.current_file || 0) === Number(msg?.total_files || 0)

        const donePayload = {
            ...msg,
            response: {
                ...(msg?.response || {}),
            },
        }
        withResponseTime(donePayload, startedAt)

        if(isLastFile) {
            donePayload.summary = {
                indexed_files: Number(msg?.total_files || msg?.current_file || 0),
                total_files: Number(msg?.total_files || 0),
                process_rid: String(msg?.process?.['@rid'] || msg?.set_process || ''),
                set_rid: String(msg?.set_rid || msg?.input_set || ''),
                task: String(msg?.task?.id || 'index'),
                service: 'md-solr',
                updated_at: new Date().toISOString(),
            }
        }

        await got.post(`${MD_URL}/api/nomad/process/files/done`, {
            json: donePayload,
            headers: {
                'mail': DEFAULT_USER,
            },
        })

        // if current_file is same as total_files, send the response to the next step
        if(shouldEmitOutputFile && msg.current_file == msg.total_files) {
            withResponseTime(msg, startedAt)
            await sendJSONFile({label: 'index.json', content: {count: msg.current_file}, type: 'solr.json', ext: 'json'}, msg, url_md)
        }

    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('api-indexer: Error in indexing:', error.message);

        sendError(msg, error, MD_URL)
    }

}

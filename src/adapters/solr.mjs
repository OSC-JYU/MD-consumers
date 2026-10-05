import got from 'got'
import { existsSync, statSync } from 'fs'
import path from 'path';

import { 
    getTextFromFile,
    sendJSONFile,
    sendError,
    sendDone,
    withResponseTime
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const SOLR_CORE = process.env.SOLR_CORE || 'messydesk'
// Solr makes changes visible within this many milliseconds. A commit per page (commit=true) took
// ~70 ms per page at 400 000 pages and limited indexing to ~14 pages/s per consumer
// (MessyDesk-new perf/results/search.md); commitWithin lets Solr batch the commits.
const SOLR_COMMIT_WITHIN_MS = Number(process.env.SOLR_COMMIT_WITHIN_MS || 1000)
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


function escapeSolrValue(value) {
    return String(value == null ? '' : value).replace(/"/g, '\\"')
}

// Full-doc realtime-get + merge + repost instead of an atomic `{"set": [...]}` partial update:
// this Solr version rejects atomic `set` on multiValued fields with "multiple values encountered
// for non multiValued field set" even when the schema correctly reports multiValued:true.
async function updateTagsForNode(service_url, node_rid, tagFields) {
    const escapedNode = escapeSolrValue(node_rid)
    const selectUrl = `${service_url}/solr/${SOLR_CORE}/select`
    const getUrl = `${service_url}/solr/${SOLR_CORE}/get`
    const updateUrl = `${service_url}/solr/${SOLR_CORE}/update?commitWithin=${SOLR_COMMIT_WITHIN_MS}`

    const selectResponse = await got.get(selectUrl, {
        searchParams: {q: `node:"${escapedNode}"`, fl: 'id', rows: 1000, wt: 'json'}
    }).json()
    const docIds = (selectResponse?.response?.docs || []).map((doc) => doc.id).filter(Boolean)
    if(!docIds.length) return {updated: 0}

    const updates = []
    for(const id of docIds) {
        const getResponse = await got.get(getUrl, {searchParams: {id, wt: 'json'}}).json()
        const doc = getResponse?.doc
        if(!doc) continue
        const merged = {}
        for(const key of Object.keys(doc)) {
            if(key.startsWith('_')) continue
            merged[key] = doc[key]
        }
        merged.tag_label = tagFields.tag_label || []
        merged.tag_rid = tagFields.tag_rid || []
        merged.tag_created_by = tagFields.tag_created_by || []
        merged.tag_confidence = tagFields.tag_confidence || []
        updates.push(merged)
    }
    if(!updates.length) return {updated: 0}

    const response = await got.post(updateUrl, {json: updates}).json()
    return {updated: updates.length, response}
}


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
        return
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
                // full (default): `fulltext` is indexed as word fragments (n-grams) and copied to
                // the whole-word `fulltext_exact`; light: whole words only, about 7x smaller.
                ...(msg?.task?.params?.index_mode === 'light' ? { fulltext_exact: content } : { fulltext: content })
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
        } else if(msg.task.id == 'update_tags') {
            const fileRid = String(msg?.file?.['@rid'] || '')
            const result = await updateTagsForNode(service_url, fileRid, msg?.tag_fields || {})
            console.log('update_tags result:', result)

            await sendDone(withResponseTime({...msg, response: {...(msg?.response || {}), ...result}}, startedAt), MD_URL)
            return result
        } else {

            throw new Error(`invalid task: ${msg?.task?.id}`)
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

        // send payload to SOLR 
        var url = `${service_url}/solr/${SOLR_CORE}/update?commitWithin=${SOLR_COMMIT_WITHIN_MS}`
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

        await sendDone(donePayload, MD_URL)

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

        await sendError(msg, error, MD_URL)
    }

}

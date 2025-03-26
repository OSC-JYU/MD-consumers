import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { 
    objectToURLParams,
    getFile,
    getFilesFromStore,
    sendError
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'


export async function process_msg(service_url, message) {
    console.log('Processing message in process_a:', message.data);

    let payload, data
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        payload = message.json()
        data = JSON.parse(payload)
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** POPPLER api ***************')
        console.log(data)

        // upload file to service
        var formUpload = new FormData();
        if(data.target) {
            var readpath = await getFile(MD_URL, data.target, data.userId)
            const readStream = fs.createReadStream(readpath);
            formUpload.append('file', readStream);
        }
        
        // preload file to service for faster processing 
        var up_url = `${service_url}/upload`

        const r = await got.post(up_url, {
            body: formUpload,
            headers: formUpload.getHeaders(),
        }).json();

        data.preloaded = r.upload
        var total_pages = null
        var info_success = false
        if(r.info && r.info.pages) {
            total_pages = parseInt(r.info.pages, 10)
            info_success = true
        }

        // then we start to loop through pages
        // if we have pages defined in params, we loop through them
        // if not, we loop through all pages and stop when there are no result any more

        const STEP = 1

        var firstPageToConvert = 1
        var lastPageToConvert = 1

        if(data.params.firstPageToConvert) 
            firstPageToConvert = parseInt(data.params.firstPageToConvert, 10)
        if(data.params.lastPageToConvert) 
            lastPageToConvert = parseInt(data.params.lastPageToConvert, 10)

        if(firstPageToConvert > lastPageToConvert) {
            lastPageToConvert = firstPageToConvert
        }

        const LIMIT = lastPageToConvert - firstPageToConvert 
        lastPageToConvert = firstPageToConvert

        var response_count = 1
        var loop_count = 0 // safety measure to prevent infinite loop

        while(firstPageToConvert <= total_pages && loop_count <= LIMIT) {

            data.params.firstPageToConvert = firstPageToConvert.toString()
            data.params.lastPageToConvert = lastPageToConvert.toString()
            var formData = new FormData();
            formData.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});

            // send payload to service endpoint 
            var url = `${service_url}/process`
            const file_list = await got.post(url, {
                body: formData,
                headers: formData.getHeaders(),
            }).json();
            
            response_count = file_list.response.uri.length
            await getFilesFromStore(file_list.response, service_url, data, url_md)

            firstPageToConvert++
            lastPageToConvert++
            if(!info_success) {
                total_pages = lastPageToConvert
            }
            loop_count++
            if(loop_count > 500) {
                console.log('infinite loop detected')
                break
            }
        }

        // delete preloaded file from service
        if(data.preloaded) {
            var req = {preloaded: data.preloaded, params: {task: 'delete'}}
            var del_url = `${service_url}/process`
            var formDelete = new FormData();
            formDelete.append('request', JSON.stringify(req), {contentType: 'application/json', filename: 'request.json'});
    
            const del_response = await got.post(del_url, {
                body: formDelete,
                headers: formDelete.getHeaders(),
            }).json();
    
            console.log(del_response)
        }


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(data, error, url_md)
    }
}

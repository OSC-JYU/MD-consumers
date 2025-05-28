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

        // we try to get file from MessyDesk and put it in formdata
        // First we try to get file from pages (firstPageToConvert = pages/page-1.pdf)
        const page = data.params.page
        delete data.params.page  // we must remove this or poppler complain

        // get file from MessyDesk and put it in formdata
        const formData = new FormData();
        if(data.target) {
            var readpath = await getFile(MD_URL, data.target, data.userId, '/pages/' + page)
            const readStream = fs.createReadStream(readpath);
            formData.append('content', readStream);
        }

        // data.params.firstPageToConvert = "1"
        // data.params.lastPageToConvert = "1"

        formData.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});

        // send payload to service endpoint 
        var url = `${service_url}/process`
        const file_list = await got.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        }).json();
        console.log('file_list', file_list)
        let file_labels = []

        // 'pdfimages' can return multiple files per page, so need set the page part and then add running number
        if(data.params.task == 'pdfimages') {
            for(let i = 0; i < file_list.response.uri.length; i++) {
                file_labels.push('page_' + page + '_image_' + (i + 1))
            }
        } else {
            file_labels.push('page_' + page) 
        }

        await getFilesFromStore(file_list.response, service_url, data, url_md, file_labels)



    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        //console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(data, error, MD_URL)
    }
}

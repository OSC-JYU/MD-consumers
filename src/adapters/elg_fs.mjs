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
        console.log('**************** ELG_fs api ***************')
        console.log(data)

        
        const formData = new FormData();
        formData.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});

        // send payload to service endpoint 
        var url = `${service_url}/process`
        console.log(url)
        const metadata = await got.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        }).json();
        
        console.log(metadata)
        data.file.metadata = {...data.file.metadata, ...metadata}

        // Notify MD that we are done
        const done_md = `${MD_URL}/api/nomad/process/files/done`
        const done_md_response = await got.post(done_md, {
            body: JSON.stringify(data),
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

        sendError(data, error, MD_URL)
    }
}

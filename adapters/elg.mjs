import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { 
    getFilesFromStore,
    getFile,
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

        console.log(typeof data)
        console.log(data)
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** ELG api ***************')
        console.log(data)
        console.log(data.target)
        console.log(payload)
        
        // get file from MessyDesk and put it in formdata
        const formData = new FormData();
        if(data.target) {
            var readpath = await getFile(MD_URL, data.target, data.userId)
            const readStream = fs.createReadStream(readpath);
            formData.append('content', readStream);
        }

        // provide parameters as json format
        formData.append('request', JSON.stringify(payload), {contentType: 'application/json', filename: 'request.json'});


        // send payload to service endpoint 
        var url = `${service_url}/process`
        console.log(url)
        const response = await got.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        });
        

        //console.log(response)
        const file_list = JSON.parse(response.body)
        console.log(file_list)
        await getFilesFromStore(file_list.response, service_url, data, url_md)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(data, error, url_md)
    }

}

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

    let payload, msg
    const url_md = `${MD_URL}/api/nomad/process/files`
    const start = process.hrtime();

    // make sure that we have valid payload
    try {
        payload = message.json()
        msg = JSON.parse(payload)
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** ELG api ***************')
        console.log(msg)

        if(!msg.file?.['@rid']) {
            throw new Error('No file found in message')
        }
        
        // get file from MessyDesk and put it in formdata
        const formData = new FormData();
        var readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId)
        const readStream = fs.createReadStream(readpath);
        formData.append('content', readStream);

        if(msg.file.source) {
            var readpath_source = await getFile(MD_URL, msg.file.source['@rid'], msg.userId)
            const readStream_source = fs.createReadStream(readpath_source);
            formData.append('source', readStream_source);
        }

        // provide message data as json file
        formData.append('message', Buffer.from(payload), {contentType: 'application/json', filename: 'message.json'});


        // send payload to service endpoint 
        var url = `${service_url}/process`
        const response = await got.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        });
        
        //console.log(response)
        const file_list = JSON.parse(response.body)
 
        const end = process.hrtime(start);
        const seconds = (end[0] + end[1] / 1e9).toFixed(3);

        // make sure we dot not overwrite existing response data
        msg.response = { ...(msg.response || {}), time: parseFloat(seconds) }
        if(file_list.message) {
            msg = { ...msg, ...file_list.message }
        }
        await getFilesFromStore(file_list.response, service_url, msg, url_md)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.code)
        //console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(msg, error, MD_URL)
        throw error
    }

}

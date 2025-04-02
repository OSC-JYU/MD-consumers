import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { 
    getTextFromFile,
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

        let index_data 
        console.log(typeof data)
        console.log(data)
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** indexing API ***************')
        //console.log(payload)
        console.log(JSON.stringify(data, null, 2))
        console.log(data.target)

        if(data.task == 'index') {
            // get file from MessyDesk and put it in formdata
            var readpath = await getFile(MD_URL, data.target, data.userId)
            // read content from file
            const content = await getTextFromFile(readpath)

            index_data = [{
                id: data.file['@rid'],
                label: data.file.label,
                owner: data.userId,
                node: data.file['@type'],
                type: data.file.type,
                description: data.file.description,
                fulltext: content
            }]

        } else if(data.task == 'delete') {
            console.log('deleting')
            index_data = {
                delete: data.target
            }
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
        var url = `${service_url}/solr/messydesk/update?commit=true`
        console.log(url)
        const response = await got.post(url, options)
        console.log(response.statusCode)

    

    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('api-indexer: Error in indexing:', error.message);

        sendError(data, error, url_md)
    }

}

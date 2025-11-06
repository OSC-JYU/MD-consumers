import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { 
    getTextFromFile,
    sendJSONFile,
    getFile,
    sendError
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'


export async function process_msg(service_url, message) {
    
    let payload, msg
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        payload = message.json()
        msg = JSON.parse(payload)
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
            // get file from MessyDesk and put it in formdata
            var readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId)
            // read content from file
            const content = await getTextFromFile(readpath)

            index_data = [{
                id: msg.file['@rid'],
                label: msg.file.label,
                owner: msg.userId,
                node: msg.file['@type'],
                type: msg.file.type,
                description: msg.file.description,
                fulltext: content
            }]

            if(msg.set_process) {
                index_data[0].set_process = msg.set_process
            }

        } else if(msg.task.id == 'delete') {
            index_data = {
                delete: msg.file['@rid']
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

        // if current_file is same as total_files, send the response to the next step
        if(msg.current_file == msg.total_files) {
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

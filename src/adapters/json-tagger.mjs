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
        console.log('**************** json-tagger API ***************')
        //console.log(payload)
        console.log(JSON.stringify(data, null, 2))
        console.log(data.target)

        if(data.task == 'tag') {
            // get file from MessyDesk and put it in formdata
            var readpath = await getFile(MD_URL, data.target, data.userId)
            // read content from file
            const content = await getTextFromFile(readpath)
            const json_content = JSON.parse(content)
            console.log(json_content)
            var entities = []
            for(var item of json_content) {
                console.log(item.word)
                var entity = {
                    type: data.id + '-' + item.entity_group,
                    label: item.word,
                    color: '#ff8844',
                    icon: 'mdi-account'
                }
                console.log(entity)
                entities.push(entity)
            }

            const options= {
                body: JSON.stringify(entities),
                headers: {
                'Content-Type': 'application/json',
                'mail': data.userId
                }
            };
    
            // // // send payload to SOLR 
            var url = `${MD_URL}/api/entities/link/${data.target.replace('#', '')}`
            console.log(url)
            const response = await got.post(url, options)
            console.log(response.statusCode)

        }

    

    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('api-indexer: Error in tagging:', error.message);

        //sendError(data, error, url_md)
    }

}

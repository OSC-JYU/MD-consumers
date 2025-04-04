
import path from 'path';
import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { 
    getServiceURL, 
    createService, 
    createDataDir,
    objectToURLParams,
    printInfo, 
    getFile,
    getFilesFromStore,
    getTextFromFile
} from './funcs.mjs';

import {
    connect,
    AckPolicy,
    JSONCodec
  } from "nats";

// consumer and service name
const NAME = process.env.NAME 
const STREAM = 'PROCESS'

if(!NAME) {
    console.log('Please set NAME environment variable')
    process.exit(1)
}

const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1'
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222'
const MD_URL = process.env.MD_URL || 'http://localhost:8200'

const REDELIVERY_COUNT = process.env.REDELIVERY_COUNT || 5
const DEV_URL = process.env.DEV_URL || null

const DEFAULT_USER = 'local.user@localhost'

const WAIT = true

printInfo(NAME, NOMAD_URL, NATS_URL, MD_URL, REDELIVERY_COUNT)

let nc, js, jsm, jc, c, consumer_app_id;

// when we are killed, tell MessyDesk that we are out of service
process.on( 'SIGINT', async function() {
    const options = { headers: { 'mail': 'local.user@localhost' } }
    await got.delete(`${MD_URL}/api/services/${TOPIC}/consumer/${consumer_app_id}`, options)
    await nc.close()
	process.exit( );
})


try {
    console.log('creating data directory...')
    await createDataDir()
    console.log('connecting to NATS...')
    nc = await connect({servers: NATS_URL});
    js = nc.jetstream();  
    jsm = await js.jetstreamManager();
    jc = JSONCodec()
    consumer_app_id = uuidv4()

    const ci = await jsm.consumers.info("PROCESS", NAME);
    console.log(ci)
    console.log(jsm.consumers.list("PROCESS"))
    var lister = await jsm.consumers.list("PROCESS")
    for await (const item of lister) {
        console.log(item);
    }
    c = await js.consumers.get("PROCESS", NAME);

    // tell MessyDesk that we are now listening messages
    const url = `${MD_URL}/api/services/${NAME}/consumer/${consumer_app_id}`
    console.log('registering consumer: ', url)
    var resp = await got.post(url).json()
    console.log('response: ', resp)

} catch(e) {
    console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${NAME}" in stream ${STREAM}`)
    console.log( e.message)
    process.exit(1)
}


if (c) {

    var service_url = await getServiceURL(NOMAD_URL, NAME, DEV_URL)
    if(service_url) {
        console.log(NAME, ': ready for messages...')
        console.log('service: ', service_url)
    } else {
        console.log(NAME, ': no service found')
        console.log('starting service...')
        try {
            await createService(MD_URL, NAME)  
        } catch(e) {
            console.log('Error in starting service with MessyDesk API:', e)
            console.log('Write nomad.hcl and place in services directory or run service manually and provide url with DEV_URL')
            process.exit(1)
        }

        // try until you get service_url
        try {
            var service_url = await getService()
            console.log('service: ', service_url)
            if(service_url) console.log(NAME, ': ready for messages...')

        } catch(e) {
            console.log('ERROR:' ,e)
            process.exit(0)
        }
    }

    while (true) {

        const iter = await c.fetch();
        for await (const m of iter) {
            
            console.log(m.info)
            await process_msg(service_url, m)
            // inProgress() to indicate that the processing of the message is still on-going and more time is needed (before the message is considered for being sent again)
            // https://docs.nats.io/using-nats/developer/anatomy
            m.ack();
        }
    }
}



async function getService() {
    var service_url = ''
    while(service_url == '') {
        console.log('waiting for service...')
        service_url = await getServiceURL(NOMAD_URL, NAME, DEV_URL)
        await sleep(2000)
    }
    return service_url
}

// sleep
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}     

async function process_msg(service_url, message) {

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

async function sendError(data, error, url_md) {
    console.log(error)
    try {
        await got.post(url_md + '/error', {json: {error:error, message: data}, headers: { 'mail': DEFAULT_USER }})
    } catch(e) {
        console.log('sending error failed')
    }}

if (nc) await nc.close()
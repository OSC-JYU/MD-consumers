
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
    printInfo, 
    getFile,
    getFilesFromStore
} from './funcs.mjs';

import {
    connect,
    AckPolicy,
    JSONCodec
  } from "nats";

// consumer and service name
const NAME = process.env.NAME 
const STREAM = 'PROCESS'

const DEFAULT_USER = 'local.user@localhost'

if(!NAME) {
    console.log('Please set NAME environment variable')
    process.exit(1)
}

const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1'
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222'
const MD_URL = process.env.MD_URL || 'http://localhost:8200'

const REDELIVERY_COUNT = process.env.REDELIVERY_COUNT || 5
const DEV_URL = process.env.DEV_URL || null

const WAIT = true

printInfo(NAME, NOMAD_URL, NATS_URL, MD_URL, REDELIVERY_COUNT)

let nc, js, jc, c, consumer_app_id;

// Define consumers to follow
const consumers = [NAME, NAME + "_batch"];

// when we are killed, tell MessyDesk that we are out of service
process.on( 'SIGINT', async function() {
    // use default user as user when registering service (not user related)
    const options = { headers: { 'mail': DEFAULT_USER } }
    await got.delete(`${MD_URL}/api/services/${NAME}/consumer/${consumer_app_id}`, options)
    await nc.close()
	process.exit( );
})


try {
    console.log('creating data directory...')
    await createDataDir()
    console.log('connecting to NATS...')
    nc = await connect({servers: NATS_URL});
    js = nc.jetstream();  
    jc = JSONCodec()
    consumer_app_id = uuidv4()

    // tell MessyDesk that we are now listening messages
    const url = `${MD_URL}/api/services/${NAME}/consumer/${consumer_app_id}`
    console.log('registering consumer: ', url)
    // use default user as user when registering service (not user related)
    const options = { headers: { 'mail': DEFAULT_USER } }
    var resp = await got.post(url, options).json()
    console.log(resp)

    

} catch(e) {
    console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${NAME}" in stream ${STREAM}`)
    console.log( e)
    process.exit(1)
}

// start service if needed
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
}

for (const consumer of consumers) {

    processConsumer("PROCESS", consumer);
}

async function processConsumer(stream, consumer) {
    //c = await js.consumers.get("PROCESS", NAME);
    const co = await js.consumers.get(stream, consumer);
    if (co) {
        //console.log(`Processing consumer: ${consumer}`);
        while (true) {
            try {
                var service_url = await getService()
                console.log('service: ', service_url)
                if(service_url) console.log(consumer, ': ready for messages...')
    
            } catch(e) {
                console.log('ERROR:' ,e)
                process.exit(0)
            }
            const iter = await co.fetch();
            for await (const m of iter) {
                await process_msg(service_url, m)
                m.ack();
                //console.log(stack);
            }
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

async function sendError(data, error, url_md) {
    console.log(error)
    try {
        await got.post(url_md + '/error', {json: {error:error, message: data}, headers: { 'mail': DEFAULT_USER }})
    } catch(e) {
        console.log('sending error failed')
    }
}

// if (nc) {
//     console.log('closing NATS connection...')
//     await nc.close()
// }
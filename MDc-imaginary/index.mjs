
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
    objectToURLParams,
    printInfo, 
    getFile
} from './funcs.mjs';

import {
    connect,
    AckPolicy,
    JSONCodec
  } from "nats";

// consumer and service name
const NAME = process.env.NAME || 'thumbnailer'
const STREAM = 'PROCESS'

const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1'
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222'
const MD_URL = process.env.MD_URL || 'http://localhost:8200'

const REDELIVERY_COUNT = process.env.REDELIVERY_COUNT || 5
const DEV_URL = process.env.DEV_URL || null

printInfo(NAME, NOMAD_URL, NATS_URL, MD_URL, REDELIVERY_COUNT)

let nc, js, jsm, jc, c, consumer_app_id;

process.on( 'SIGINT', async function() {
    await got.delete(`${MD_URL}/api/services/${NAME}/consumer/${consumer_app_id}`)
    await nc.close()
	process.exit( );
})


try {
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
    console.log(resp)

} catch(e) {
    console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${NAME}" in stream ${STREAM}`)
    console.log( e.message)
    process.exit(1)
}


if (c) {
    var service_url = await getServiceURL(NOMAD_URL, NAME, DEV_URL)
    console.log('service: ', service_url)
    if(service_url) console.log(NAME, ': ready for messages...')
    while (true) {
        try {
            service_url = await getServiceURL(NOMAD_URL, NAME, DEV_URL)    
            if(!service_url) {
                console.log(NAME, ': no service found')
                console.log('starting service...')
                await createService(MD_URL, NAME)
                console.log('service started!')
                service_url = await getServiceURL(NOMAD_URL, NAME, DEV_URL) 
                console.log('service_url:', service_url)
            }
        } catch(e) {
            console.log('ERROR:' ,e)
            process.exit(0)
        }

        const iter = await c.fetch();
        for await (const m of iter) {
            // console.log(m.string())
            console.log(m.info)
            await process_msg(service_url, m.data)
            // inProgress() to indicate that the processing of the message is still on-going and more time is needed (before the message is considered for being sent again)
            // https://docs.nats.io/using-nats/developer/anatomy
            m.ack();
        }
    }
}


async function process_msg(service_url, payload) {

    try {
        var data = JSON.parse(payload)
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** IMAGINARY api ***************')
        console.log(data)
        
        // get file from MessyDesk and put it in formdata
        var readpath = await getFile(MD_URL, data.target)
        const readStream = fs.createReadStream(readpath);
        const formData = new FormData();
        formData.append('file', readStream);
        
        // send payload to service endpoint and save result locally
        const url_params = objectToURLParams(data.params)
        var url = `${service_url}/${data.task}?${url_params}`
        const postStream = got.stream.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        });
        
        var dirname = uuidv4()
        const writepath = path.join('data', dirname)
        const writeStream = fs.createWriteStream(writepath);
     
        await pipeline(postStream, writeStream)


        // finally send result and original message to MessyDesk
        const readStream_md = fs.createReadStream(writepath);
        const formData_md = new FormData();
        formData_md.append('content', readStream_md);
        formData_md.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});

        const url_md = `${MD_URL}/api/nomad/process/files`
        const postStream_md = got.stream.post(url_md, {
            body: formData_md,
            headers: formData_md.getHeaders(),
        });
        
        await pipeline(postStream_md, new stream.PassThrough())
        console.log('file sent!')

    } catch (error) {
        console.log(error.status)
        console.log(error.code)
        console.error('imaginary_api: Error reading, sending, or saving the image:', error.message);
    }
}

await nc.close()

import Replicate from "replicate";

import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { 
    getServiceURL, 
    createService, 
    createDataDir,
    sendTextFile,
    getFile,
    getFileBuffer,
    printInfo
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

const WAIT = true

const azureApiKey = process.env["AZURE_OPENAI_API_KEY"] 

printInfo(NAME, NOMAD_URL, NATS_URL, MD_URL, REDELIVERY_COUNT)

let nc, js, jsm, jc, c, consumer_app_id;

const replicate = new Replicate();


// when we are killed, tell MessyDesk that we are out of service
process.on( 'SIGINT', async function() {
    await got.delete(`${MD_URL}/api/services/${NAME}/consumer/${consumer_app_id}`)
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
    console.log(resp)

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

        if(!service_url.startsWith('http')) service_url = 'http://' + service_url

        console.log(service_url)
        console.log('**************** ELG api replicate ***************')
        console.log(data)
    
        var readpath = await getFile(MD_URL, data.target, data.userId)
        var image = await getFileBuffer(readpath)
    
        // send payload to service endpoint
        const input = {
            image: image,
            prompt: "This is an alt text description. What can be seen in the front? what can be seen in the back? Is the photo coloured or black and white? indicate in the description if there's text in the picture. Do not use words image or picture in the description. Don't count the amount of things"
        };
        
        const output = await replicate.run("yorickvp/llava-13b:b5f6212d032508382d61ff00469ddda3e32fd8a0e75dc39d8a4191bb742157fb", { input });
        console.log(output.join(""));

       const filedata = {label:'alt.txt', content: output.join(""), type: 'text', ext: 'txt'}
       await sendTextFile(filedata, data, url_md)



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
    await got.post(url_md + '/error', {json: {error: error, message: data}})
}

if (nc) await nc.close()
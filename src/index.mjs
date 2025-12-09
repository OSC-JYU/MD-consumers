
import path from 'path';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { 
    getServiceURL, 
    createService,
    createDataDir, 
    printInfo,
} from './funcs.mjs';

import { connect } from "@nats-io/transport-node";
import { jetstream, AckPolicy } from "@nats-io/jetstream";

import { fileURLToPath } from 'url';

// Resolve the directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// consumer and service name
const TOPIC = process.env.TOPIC 
const STREAM = 'PROCESS'

const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1'
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222'
const MD_URL = process.env.MD_URL || 'http://localhost:8200'

const REDELIVERY_COUNT = process.env.REDELIVERY_COUNT || 5
const DEV_URL = process.env.DEV_URL || null
const NOMAD = process.env.NOMAD || null

const DEFAULT_USER = 'local.user@localhost'

let LOCAL_URL = null


printInfo(TOPIC, NOMAD_URL, NATS_URL, MD_URL, REDELIVERY_COUNT)

let nc, js, c, consumer_app_id;

// Define consumers to follow
const consumers = [TOPIC, TOPIC + "_batch"];

var interval = null
let adapter_name = null
let service_url = null
let process_msg = null
let service_json = null
let request_json = {topic: TOPIC, nomad: NOMAD}
// when we are killed, tell MessyDesk that we are out of service
process.on( 'SIGINT', async function() {
    clearInterval(interval)
    // use default user as user when deleting service (not user related)
    const options = { headers: { 'mail': DEFAULT_USER } }
    await got.delete(`${MD_URL}/api/services/${TOPIC}/consumer/${consumer_app_id}`, options)
    await nc.close()
	process.exit( );
})


try {
    console.log('creating data directory...')
    await createDataDir()
    console.log('connecting to NATS...')
    nc = await connect({servers: NATS_URL});
    js = jetstream(nc);
    consumer_app_id = uuidv4()


    // tell MessyDesk that we are now listening messages
    const url = `${MD_URL}/api/services/${TOPIC}/consumer/${consumer_app_id}`
    console.log('registering consumer: ', url)
    // use default user as user when registering service (not user related)
    const options = { headers: { 'mail': DEFAULT_USER } }
    service_json = await got.post(url, options).json()
    console.log(service_json)

    if(service_json.adapter) {  
        adapter_name = service_json.adapter
    } else {
        adapter_name = process.env.ADAPTER 
    }
    LOCAL_URL = service_json.local_url
    console.log('adapter_name: ', adapter_name)

    // Dynamically import the process_msg function aka adapter code
    //const { process_msg } = await import(`./adapters/${adapter_name}.mjs`);
    process_msg = (await import(`./adapters/${adapter_name}.mjs`)).process_msg;

    // keep polling the endpoint so that MessyDesk is aware services even after restart
    interval = setInterval(async () => {
        try {
            await got.post(url, options).json();
        } catch (e) {
            console.log('ERROR:', e.message);
        }
    }, 30000);

} catch(e) {
    console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${TOPIC}" in stream ${STREAM}`)
    console.log( e.message)
    process.exit(1)
}

// start service if needed
if(DEV_URL) {
    service_url = DEV_URL
} else {
    service_url = await getServiceURL(NOMAD_URL, request_json, service_json)
}

if(service_url) {
    console.log(TOPIC, ': ready for messages...')
    console.log('SERVICE URL: ', service_url)
} else {
    console.log(TOPIC, ': no service found')
    console.log('starting service...')
    try {
        await createService(MD_URL, TOPIC)  
    } catch(e) {
        console.log('Error in starting service with MessyDesk API:', e)
        console.log('Write nomad.hcl and place in services directory or run service manually and provide url with DEV_URL')
        process.exit(1)
    }     
}
    



for (const consumer of consumers) {

    processConsumer("PROCESS", consumer, request_json, service_json);
}

 async function processConsumer(stream, consumer, request_json, service_json) {

    const co = await js.consumers.get(stream, consumer);
    if (co) {

        try {
            var service_url = await getService(request_json, service_json)
            console.log('service: ', service_url)
            if(service_url) console.log(consumer, ': ready for messages...')

        } catch(e) {
            console.log('ERROR:' ,e)
            process.exit(0)
        }
        const messages = await co.consume({ max_messages: 1 });
        for await (const m of messages) {
            console.log('message: ', m)
            try {
                await process_msg(service_url, m)
                // acknowledge message
                m.ack();
            } catch(e) {
                console.log('ERROR:', e.message)
                // we do not retry, so we ack
                m.ack();
            }
        }
        
    }
 }



async function getService(request_json, service_json) {
    var service_url = ''
    if(DEV_URL) {
        service_url = DEV_URL
    } else {
        while(service_url == '') {
            console.log('waiting for service...')
            service_url = await getServiceURL(NOMAD_URL, request_json, service_json)
            await sleep(2000)
        }
    }
    return service_url
}

// sleep
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}       



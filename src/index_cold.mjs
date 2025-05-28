import path from 'path';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { 
    getServiceURL, 
    createService,
    stopService,
    createDataDir, 
    printInfo,
} from './funcs.mjs';

import {
    connect,
    AckPolicy,
    JSONCodec
  } from "nats";

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

let nc, js, jc, c, consumer_app_id;

// Define consumers to follow
const consumers = [TOPIC, TOPIC + "_batch"];

var interval = null
let adapter_name = null
let service_url = null


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
    js = nc.jetstream();  
    jc = JSONCodec()
    consumer_app_id = uuidv4()


    // tell MessyDesk that we are now listening messages
    const url = `${MD_URL}/api/services/${TOPIC}/consumer/${consumer_app_id}`
    console.log('registering consumer: ', url)
    // use default user as user when registering service (not user related)
    const options = { headers: { 'mail': DEFAULT_USER } }
    var resp = await got.post(url, options).json()
    console.log(resp)

    if(resp.adapter) {  
        adapter_name = resp.adapter
    } else {
        adapter_name = process.env.ADAPTER 
    }
    console.log('adapter_name: ', adapter_name)

    // Dynamically import the process_msg function aka adapter code
    const { process_msg } = await import(`./adapters/${adapter_name}.mjs`);

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

// start service if needed (true = use nomad)
service_url = await getServiceURL(NOMAD_URL, TOPIC, DEV_URL, LOCAL_URL, true)
console.log('service: ', service_url)
if(service_url) {
    console.log(TOPIC, ': ready for messages...')
    console.log('service: ', service_url)
} else {
    console.log(TOPIC, ': no service found')
    console.log(TOPIC, ': COLD START!')   
}


for (const consumer of consumers) {

    processConsumer("PROCESS", consumer);
}
var count = 0
 async function processConsumer(stream, consumer) {
    const co = await js.consumers.get(stream, consumer);
    if (co) {
        try {
            const messages = await co.consume({ max_messages: 1 });
            count++
            for await (const m of messages) {
                // check if service is running
                if(service_url == '') {
                    service_url = await getServiceURL(NOMAD_URL, TOPIC, DEV_URL, LOCAL_URL, NOMAD)
                    // start if not running
                    if(service_url == '') {
                        await createService(MD_URL, TOPIC)
                        service_url = await getServiceURL(NOMAD_URL, TOPIC, DEV_URL, LOCAL_URL, NOMAD,1)
                        if(service_url) {
                            console.log('service started')
                            await process_msg(service_url, m)
                            await m.ack();
                        }
                    }
                } else {
                    await process_msg(service_url, m)
                    await m.ack();
                }
                // stop service if queue is empty
                const info = await co.info();
                if(info.num_ack_pending == 0) {
                    await stopService(MD_URL, TOPIC)
                    service_url = ''
                }
            }
        } catch(e) {
            console.log('ERROR:' ,e)
            process.exit(0)
        }
    }
}



async function getService() {
    var service_url = ''
    while(service_url == '') {
        console.log('waiting for service...')
        service_url = await getServiceURL(NOMAD_URL, TOPIC, DEV_URL, LOCAL_URL, NOMAD)
        await sleep(2000)
    }
    return service_url
}

// sleep
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}       



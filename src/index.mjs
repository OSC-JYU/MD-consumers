
import path from 'path';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { 
    getServiceURL, 
    createService,
    createDataDir, 
    printInfo,
    resolveDescriptorSourceChain,
    resolveNomadHclPath,
    getRuntimeConfigDescriptor,
    registerServiceDescriptorWithRetry,
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
const HELP_URL = process.env.HELP_URL || null
const SERVICE_JSON_PATH = process.env.SERVICE_JSON_PATH || process.env.SERVICE_DESCRIPTOR_PATH || null
const NOMAD = process.env.NOMAD || null
const NOMAD_HCL_PATH_ENV = process.env.NOMAD_HCL_PATH || null

const DEFAULT_USER = 'local.user@localhost'
const REGISTRATION_MAX_ATTEMPTS = Number(process.env.REGISTRATION_MAX_ATTEMPTS || 5)
const REGISTRATION_INITIAL_DELAY_MS = Number(process.env.REGISTRATION_INITIAL_DELAY_MS || 500)
const NOMAD_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(NOMAD || '').toLowerCase())
const USE_LEGACY_NOMAD_METADATA = NOMAD_ENABLED && !NOMAD_HCL_PATH_ENV

let LOCAL_URL = null

async function triggerServiceHelpIngest(serviceId, descriptor = null) {
    const ingestUrl = `${MD_URL}/api/services/${serviceId}/help/ingest`
    const configuredHelpUrl = HELP_URL || descriptor?.help_url || null
    try {
        const options = { headers: { 'mail': DEFAULT_USER } }
        if(configuredHelpUrl) {
            options.searchParams = { help_url: configuredHelpUrl }
        }
        await got.post(ingestUrl, options).json()
        console.log('service help ingested:', serviceId)
    } catch (error) {
        const status = error?.response?.statusCode
        const detail = error?.response?.body || error.message
        console.log(`WARN: service help ingest failed for ${serviceId}${status ? ` (${status})` : ''}`)
        if (detail) {
            console.log(detail)
        }
    }
}


printInfo(TOPIC, NOMAD_URL, NATS_URL, MD_URL, REDELIVERY_COUNT)

let nc, js, c, adapter_id;

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
    await got.delete(`${MD_URL}/api/services/${TOPIC}/adapter/${adapter_id}`, options)
    await nc.close()
	process.exit( );
})


try {
    console.log('creating data directory...')
    await createDataDir()
    adapter_id = uuidv4()

    const bootstrap = await resolveDescriptorSourceChain({
        topic: TOPIC,
        adapterName: process.env.ADAPTER || null,
        descriptorPath: SERVICE_JSON_PATH,
        mdUrl: MD_URL,
        serviceUrl: null,
        user: DEFAULT_USER,
    });
    service_json = bootstrap.descriptor

    adapter_name = process.env.ADAPTER || service_json.adapter || null

    if(DEV_URL) {
        service_url = DEV_URL
    } else {
        service_url = await getServiceURL(NOMAD_URL, request_json, service_json)
    }

    const nomadHclPath = NOMAD_HCL_PATH_ENV || await resolveNomadHclPath(TOPIC, {
        descriptorPath: SERVICE_JSON_PATH,
        adapterName: adapter_name,
    })

    if(!service_url) {
        console.log(TOPIC, ': no service found')
        console.log('starting service...')
        try {
            if(nomadHclPath) {
                console.log('using nomad spec from:', nomadHclPath)
            }
            await createService(MD_URL, TOPIC, { nomadHclPath: nomadHclPath })
            service_url = await getService(request_json, service_json)
        } catch(e) {
            console.log('Error in starting service with MessyDesk API:', e)
            console.log('Provide NOMAD_HCL_PATH or place nomad.hcl under descriptors/<topic>/ (or .descriptors/<topic>/), or run service manually and provide DEV_URL')
            process.exit(1)
        }
    }

    let registrationSource = 'runtime-config'
    if(USE_LEGACY_NOMAD_METADATA) {
        console.log('using legacy Nomad metadata from MessyDesk services directory...')
        const resolved = await resolveDescriptorSourceChain({
            topic: TOPIC,
            adapterName: adapter_name,
            descriptorPath: SERVICE_JSON_PATH,
            mdUrl: MD_URL,
            serviceUrl: null,
            user: DEFAULT_USER,
        })
        service_json = resolved.descriptor
        registrationSource = resolved.source
    } else {
        console.log('fetching service info from /config...')
        const runtimeDescriptor = await getRuntimeConfigDescriptor(service_url, TOPIC)
        if(!runtimeDescriptor) {
            throw new Error(`Registration cancelled: service ${TOPIC} /config is not available`)
        }
        service_json = runtimeDescriptor
    }

    if(!adapter_name && service_json?.adapter) {
        adapter_name = service_json.adapter
    }

    if(!adapter_name) {
        throw new Error('No adapter specified in environment variable or service descriptor (including runtime /config)')
    }

    await registerServiceDescriptorWithRetry({
        mdUrl: MD_URL,
        descriptor: service_json,
        source: registrationSource,
        user: DEFAULT_USER,
        maxAttempts: REGISTRATION_MAX_ATTEMPTS,
        initialDelayMs: REGISTRATION_INITIAL_DELAY_MS,
    })

    await triggerServiceHelpIngest(TOPIC, service_json)


    // tell MessyDesk that we are now listening messages
    const url = `${MD_URL}/api/services/${TOPIC}/adapter/${adapter_id}`
    console.log('registering consumer: ', url)
    // use default user as user when registering service (not user related)
    const options = { headers: { 'mail': DEFAULT_USER } }
    await got.post(url, options).json()
    console.log(service_json)
    
    LOCAL_URL = service_json.local_url
    console.log('adapter_name: ', adapter_name)

    // Dynamically import the process_msg function aka adapter code
    //const { process_msg } = await import(`./adapters/${adapter_name}.mjs`);
    process_msg = (await import(`./adapters/${adapter_name}.mjs`)).process_msg;

    // keep polling the endpoint so that MessyDesk is aware services even after restart
    interval = setInterval(async () => {
        try {
            let heartbeatSource = 'runtime-config'
            if(USE_LEGACY_NOMAD_METADATA) {
                const resolved = await resolveDescriptorSourceChain({
                    topic: TOPIC,
                    adapterName: adapter_name,
                    descriptorPath: SERVICE_JSON_PATH,
                    mdUrl: MD_URL,
                    serviceUrl: null,
                    user: DEFAULT_USER,
                })
                service_json = resolved.descriptor
                heartbeatSource = resolved.source
            } else {
                const liveDescriptor = await getRuntimeConfigDescriptor(service_url, TOPIC)
                if(!liveDescriptor) {
                    console.log('Registration skipped: /config is not available')
                    return
                }
                service_json = liveDescriptor
            }
            await registerServiceDescriptorWithRetry({
                mdUrl: MD_URL,
                descriptor: service_json,
                source: heartbeatSource,
                user: DEFAULT_USER,
                maxAttempts: 3,
                initialDelayMs: REGISTRATION_INITIAL_DELAY_MS,
            })
            await got.post(url, options).json();
        } catch (e) {
            console.log('ERROR:', e.message);
        }
    }, 30000);

    console.log('connecting to NATS...')
    nc = await connect({servers: NATS_URL});
    js = jetstream(nc);

} catch(e) {
    if(String(e?.message || '').includes('/config is not available')) {
        console.log(`ERROR: Service registration cancelled for "${TOPIC}"`)
        console.log(e.message)
        console.log('HINT: start the service first, then run the consumer.')
    } else {
        console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${TOPIC}" in stream ${STREAM}`)
        console.log(e.message)
    }
    process.exit(1)
}

if(service_url) {
    console.log(TOPIC, ': ready for messages...')
    console.log('SERVICE URL: ', service_url)
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
            //console.log('message: ', m)
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



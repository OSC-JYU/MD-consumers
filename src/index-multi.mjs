import path from 'path';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { 
    getServiceURL, 
    createService,
    createDataDir, 
    printInfo,
} from './funcs.mjs';

import {
    connect,
    AckPolicy,
    JSONCodec
  } from "nats";

import { fileURLToPath } from 'url';
import { startServer } from './server.mjs';

// Resolve the directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const STREAM = 'PROCESS'

const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1'
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222'
const MD_URL = process.env.MD_URL || 'http://localhost:8200'

const REDELIVERY_COUNT = process.env.REDELIVERY_COUNT || 5
const DEV_URL = process.env.DEV_URL || null
const NOMAD = process.env.NOMAD || null

const DEFAULT_USER = 'local.user@localhost'

// Global state
let nc, js, jc, c;
let hapiServer = null;
let activeConsumers = new Map(); // Map of topic -> consumer info

// when we are killed, tell MessyDesk that we are out of service
process.on( 'SIGINT', async function() {
    await cleanup();
    process.exit();
})

async function cleanup() {
    // Clean up all active consumers
    console.log('cleaning up active consumers...')
    for (const [topic, consumerInfo] of activeConsumers) {
        try {
            if (consumerInfo.interval) {
                clearInterval(consumerInfo.interval);
            }
            
            if (consumerInfo.consumer_app_id) {
                const options = { headers: { 'mail': DEFAULT_USER } }
                console.log('deleting consumer: ', `${MD_URL}/api/services/${topic}/consumer/${consumerInfo.consumer_app_id}`)
                await got.delete(`${MD_URL}/api/services/${topic}/consumer/${consumerInfo.consumer_app_id}`, options)
            }
        } catch (e) {
            console.log(`Error cleaning up consumer for topic ${topic}:`, e.message);
        }
    }
    
    if (nc) {
        await nc.close();
    }
    
    if (hapiServer) {
        console.log('Stopping Hapi server...')
        await hapiServer.stop()
    }
}

// Initialize the application
async function initialize() {
    try {
        console.log('creating data directory...')
        await createDataDir()
 
        // Connect to NATS if not already connected
        if (!nc) {
            console.log('connecting to NATS...')
            nc = await connect({servers: NATS_URL});
            js = nc.jetstream();  
            jc = JSONCodec()
        }

        // Start Hapi server
        const HAPI_PORT = process.env.HAPI_PORT || 8201;
        console.log('Starting Hapi server on port', HAPI_PORT);
        hapiServer = await startServer(HAPI_PORT);
        
        console.log('Adapter server ready. Send POST request to /start with topic data to begin consuming messages.');
        
    } catch(e) {
        console.log('ERROR: Failed to initialize:', e.message)
        await cleanup();
        process.exit(1)
    }
}

// Start NATS consumer for a specific topic
async function startNATSConsumer(request) {
    if (activeConsumers.has(request.topic)) {
        throw new Error('Consumer is already running for topic: ' + request.topic);
    }
    
    console.log('Starting NATS consumer for topic:', request.topic);
    
    try {
        
        const consumer_app_id = uuidv4()

        // tell MessyDesk that we are now listening messages
        const url = `${MD_URL}/api/services/${request.topic}/consumer/${consumer_app_id}`
        console.log('registering consumer: ', url)
        // use default user as user when registering service (not user related)
        const options = { headers: { 'mail': DEFAULT_USER } }
        var service_json = await got.post(url, options).json()

        let adapter_name;
        if(service_json.adapter) {  
            adapter_name = service_json.adapter
        } else {
            throw new Error('Adapter not found for topic: ' + request.topic);
        }
        let local_url = service_json.local_url
        console.log('adapter_name: ', adapter_name)

        // keep polling the endpoint so that MessyDesk is aware services even after restart
        const interval = setInterval(async () => {
            try {
                await got.post(url, options).json();
            } catch (e) {
                console.log('ERROR:', e.message);
            }
        }, 30000);

        // start service if needed
        let service_url = await getServiceURL(NOMAD_URL, request, service_json, NOMAD, false)
        if(service_url) {
            console.log(request.topic, ': ready for messages...')
            console.log('SERVICE URL: ', service_url)
        } else {
            console.log(request.topic, ': no service found')
            console.log('starting service...')
            try {
                await createService(MD_URL, request.topic)  
            } catch(e) {
                console.log('Error in starting service with MessyDesk API:', e)
                console.log('Write nomad.hcl and place in services directory or run service manually and provide url with DEV_URL')
                clearInterval(interval)
                // use default user as user when deleting service (not user related)
                const options = { headers: { 'mail': DEFAULT_USER } }
                await got.delete(`${MD_URL}/api/services/${request.topic}/consumer/${consumer_app_id}`, options)
                throw e;
            }     
        }
        
        // Dynamically import and cache the process_msg function
        const process_msg_fn = (await import(`./adapters/${adapter_name}.mjs`)).process_msg;

        // Store consumer info
        activeConsumers.set(request.topic, {
            consumer_app_id,
            interval,
            adapter_name,
            process_msg_fn,
            service_url,
            local_url
        });
        
        // Define consumers to follow
        const consumers = [request.topic, request.topic + "_batch"];
        
        // Start processing consumers for this topic in parallel
        for (const consumer of consumers) {
            // Don't await - let it run in the background
            processConsumer("PROCESS", consumer, request, service_json).catch((e) => {
                console.log(`Error in consumer ${consumer} for topic ${request.topic}:`, e.message);
            });
        }
        
        console.log('NATS consumer started successfully for topic:', request.topic);
        
    } catch(e) {
        console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${request.topic}" in stream ${STREAM}`)
        console.log( e.message)
        throw e;
    }
}


async function processConsumer(stream, consumer, request, service) {
    const co = await js.consumers.get(stream, consumer);
    if (!co) {
        console.log(`Consumer not found for ${consumer}`);
        return;
    }

    try {
        const service_url = await getService(request, service);
        console.log(`${consumer}: service ready at ${service_url}`);

        const consumerInfo = activeConsumers.get(request.topic);
        const process_msg_fn = consumerInfo.process_msg_fn;

        // Continuous pull loop
        while (activeConsumers.has(request.topic)) {
            try {
                const messages = await co.consume({ max_messages: 1 });

                // One message at a time — sequential
                for await (const m of messages) {
                    try {
                        await process_msg_fn(service_url, m);
                        m.ack();
                    } catch (err) {
                        console.error(`Error processing ${consumer}:`, err.message);
                        m.nak(); // ask JetStream to redeliver later
                    }
                }

            } catch (e) {
                console.log(`Error consuming messages for ${consumer}:`, e.message);
                if (!activeConsumers.has(request.topic)) break;
                await sleep(1000); // brief backoff
            }
        }

    } catch (e) {
        console.log(`ERROR in processConsumer(${consumer}):`, e.message);
    }
}

async function getService(request, service) {
    var service_url = ''
    let attempts = 0
    const maxAttempts = 5 // Only try 5 times before giving up
    while(service_url == '' && attempts < maxAttempts) {
        console.log('waiting for service...')
        service_url = await getServiceURL(NOMAD_URL, request, service, NOMAD, false)
        if (!service_url) {
            attempts++
            await sleep(2000)
        }
    }
    if (!service_url) {
        throw new Error(`Service not available for topic: ${request.topic} after ${maxAttempts} attempts`)
    }
    return service_url
}

// sleep
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Stop NATS consumer for a specific topic
async function stopNATSConsumer(topic) {
    if (!activeConsumers.has(topic)) {
        throw new Error('No consumer running for topic: ' + topic);
    }
    
    const consumerInfo = activeConsumers.get(topic);
    
    try {
        // Clear the interval
        if (consumerInfo.interval) {
            clearInterval(consumerInfo.interval);
        }
        
        // Unregister from MessyDesk
        if (consumerInfo.consumer_app_id) {
            const options = { headers: { 'mail': DEFAULT_USER } }
            await got.delete(`${MD_URL}/api/services/${topic}/consumer/${consumerInfo.consumer_app_id}`, options)
        }
        
        // Remove from active consumers
        activeConsumers.delete(topic);
        
        console.log('NATS consumer stopped successfully for topic:', topic);
        
    } catch(e) {
        console.log(`ERROR: Problem stopping consumer for topic "${topic}":`, e.message)
        throw e;
    }
}

// Get list of active topics
function getActiveTopics() {
    return Array.from(activeConsumers.keys());
}

// Check if a specific topic is running
function isTopicRunning(topic) {
    return activeConsumers.has(topic);
}

// Get detailed information about all active consumers
function getConsumersInfo() {
    const consumers = [];
    for (const [topic, info] of activeConsumers) {
        consumers.push({
            topic: topic,
            consumerId: info.consumer_app_id,
            adapterName: info.adapter_name,
            serviceUrl: info.service_url,
            localUrl: info.local_url
        });
    }
    return consumers;
}

// Export functions for use by the server
export { startNATSConsumer, stopNATSConsumer, getActiveTopics, isTopicRunning, getConsumersInfo };

// Start the application
initialize();
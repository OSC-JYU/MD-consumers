
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
    getFile
} from './funcs.mjs';

import {
    connect,
    AckPolicy,
    JSONCodec
  } from "nats";

// consumer and service name
const NAME = process.env.NAME || 'md-thumbnailer'
const STREAM = 'PROCESS'

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
    const options = { headers: { 'mail': 'local.user@localhost' } }
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
    const options = { headers: { 'mail': 'local.user@localhost' } }
    var resp = await got.post(url, options).json()
    console.log(resp)

} catch(e) {
    console.log(`ERROR: Problem with NATS on ${NATS_URL}\n with consumer "${NAME}" in stream ${STREAM}`)
    console.log( e.message)
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
        console.log('**************** IMAGINARY api ***************')
        console.log(data)
        console.log('target:')
        console.log(data.target)
        console.log('source: ', data.source)
        console.log(data.source)
        
        var sourceFile = false


        // ******************* OSD_rotate *******************
        // take care of special case of OSD rotate

        if(data.task == 'OSD_rotate') {
            try {
                // read OSD json
                var osd = await getFile(MD_URL, data.target, data.userId)
                var json = await fs.readJSON(osd)
                
                data.task = 'rotate'
                // change file to source file
                data.file = data.source
                data.target = data.source['@rid'].replace('#','')
                if(!json.rotate) throw({error: 'no rotate in OSD', status: 'created_duplicate_source'}) 
                data.params.rotate = json.rotate
                
            } catch(e) {
                if(e.status == 'created_duplicate_source') {
                    var readpath = await getFile(MD_URL, data.target, data.userId)
                    const readStream_md = fs.createReadStream(readpath);
                    const formData_md = new FormData();
                    formData_md.append('content', readStream_md);
                    formData_md.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});
            
                    const postStream_md = got.stream.post(url_md, {
                        body: formData_md,
                        headers: formData_md.getHeaders(),
                    });
                    
                    await pipeline(postStream_md, new stream.PassThrough())
                    console.log('file sent!')
                }
                throw('Error in OSD_rotate', e)  

            }

        }
        // ******************* OSD_rotate *******************
        

        // get file from MessyDesk and put it in formdata
        var readpath = await getFile(MD_URL, data.target, data.userId)
        const readStream = fs.createReadStream(readpath);
        const formData = new FormData();
        formData.append('file', readStream);


        // send payload to service endpoint and save result locally
        const url_params = objectToURLParams(data.params)
        var url = `${service_url}/${data.task}?${url_params}`
        console.log(url)
        const postStream = got.stream.post(url, {
            body: formData,
            headers: formData.getHeaders(),
        });
        
        var dirname = uuidv4()
        const writepath = path.join('data', dirname)
        const writeStream = fs.createWriteStream(writepath);
     
        writeStream
        .on("error", (error) => {
          console.error(`Reading failed: ${error.message}`);
        });
    
      postStream
        .on("error", (error) => {
          console.error(`Post failed: ${error.message}`);
        })
    

        await pipeline(postStream, writeStream)

        // finally send result and original message to MessyDesk
        const readStream_md = fs.createReadStream(writepath);
        const formData_md = new FormData();
        formData_md.append('content', readStream_md);
        formData_md.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});
        var headers = formData_md.getHeaders()
        headers['mail'] = data.userId

        const postStream_md = got.stream.post(url_md, {
            body: formData_md,
            headers: headers,
        });
        
        await pipeline(postStream_md, new stream.PassThrough())
        console.log('file sent!')


        // TODO: fix this so that code is not duplicated!
        //  if this is a thumbnail request then create smaller thumbnail also
         if(data.id == 'md-thumbnailer') {
            console.log('processing smaller thumb')
            const readStream_small = fs.createReadStream(writepath);
            const formData_small = new FormData();
            formData_small.append('file', readStream_small);
            
            // send payload to service endpoint and save result locally
            data.params.width = 200
            data.thumb_name = 'thumbnail.jpg'
            const url_params_small = objectToURLParams(data.params)
            var url = `${service_url}/${data.task}?${url_params_small}`
            const postStream_small = got.stream.post(url, {
                body: formData_small,
                headers: formData_small.getHeaders(),
            });

            var dirname = uuidv4()
            const writepath_small = path.join('data', dirname)
            const writeStream_small = fs.createWriteStream(writepath_small);
         
            await pipeline(postStream_small, writeStream_small)

            // finally send result and original message to MessyDesk
            const readStream_small_thumb = fs.createReadStream(writepath_small);
            const formData_thumb = new FormData();
            formData_thumb.append('content', readStream_small_thumb);
            formData_thumb.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});
            var headers2 = formData_thumb.getHeaders()
            headers2['mail'] = data.userId

            const postStream_small_thumb = got.stream.post(url_md, {
                body: formData_thumb,
                headers: headers2,
            });
            
            await pipeline(postStream_small_thumb, new stream.PassThrough())
            console.log('smaller file sent!')
         }

    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)

        console.error('imaginary_api: Error reading, sending, or saving the image:', error.message);
        sendError(data, error, url_md)
        
    }
}

async function sendError(data, error, url_md) {
    await got.post(url_md + '/error', {json:{error: error, message: data}})
}

//if(nc) await nc.close()

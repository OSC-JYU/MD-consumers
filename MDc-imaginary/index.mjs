
import path from 'path';
import { pipeline } from 'stream/promises';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';

import { getServiceURL, objectToURLParams } from './funcs.mjs';

import {
    connect,
    JSONCodec
  } from "nats";

// consumer and service name
const NAME = 'md-imaginary'

const NOMAD_URL = process.env.NOMAD_URL || 'http://localhost:4646/v1'
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222'

const nc = await connect({servers: NATS_URL});
const js = nc.jetstream();  
const jsm = await js.jetstreamManager();
const jc = JSONCodec()

const ci = await jsm.consumers.info("PROCESS", NAME);
console.log(ci)

const c = await js.consumers.get("PROCESS", NAME);

if (c) {
    while (true) {
        console.log('itering...')
        var url = await getServiceURL(NOMAD_URL, NAME)
        if(!url) {
            console.log(NAME, ': no service found')
        }
        const iter = await c.fetch();
        for await (const m of iter) {
            console.log(m.subject);
            await process_msg(m.data)
            m.ack();
        }
    }
}


async function process_msg(service_url, encdata) {

    try {
        var data = jc.decode(encdata)
        console.log('**************** IMAGINARY api ***************')
        console.log(data)
        

        const readStream = fs.createReadStream(data.filepath);
        const formData = new FormData();
        formData.append('file', readStream);
        
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

        } catch (error) {
          console.error('imaginary_api: Error reading, sending, or saving the image:', error.message);
        }
}

  await nc.close()
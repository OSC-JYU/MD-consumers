import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { 
    sendTextFile,
    sendError
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'


export async function process_msg(service_url, message) {
    console.log('Processing message in process_a:', message.data);

    let msg
    const url_md = `${MD_URL}/api/nomad/process/files`
    const start = process.hrtime();

    // make sure that we have valid payload
    try {
        msg = message.json()
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** TEST api ***************')
        console.log(msg)

        if(!msg.file?.['@rid']) {
            throw new Error('No file found in message')
        }

        console.log('msg.task.params: ', msg.task.params)
        
        const end = process.hrtime(start);
        const seconds = (end[0] + end[1] / 1e9).toFixed(3);
        msg.response = {time: parseFloat(seconds)}


        if(msg.task.id === "test") {
            if(msg.task.params.delay) {
                await new Promise(resolve => setTimeout(resolve, msg.task.params.delay * 1000))
                var txt = "Hello World " + Math.random()
                const filedata = {label:'result.txt', content: txt, type: 'text', ext: 'txt'}
                await sendTextFile(filedata, msg, url_md)
            }
            
        } else if(msg.task.id === "json") {
            var json = {number: Math.random(), title: "Test data for file " + msg.file.label}
            const filedata = {label:msg.file.label + '.json', content: JSON.stringify(json), type: 'json', ext: 'json'}
            await sendTextFile(filedata, msg, url_md)

        }


    } catch (error) {
        console.log('pipeline error')
        console.log(error.code)
        //console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(msg, error, MD_URL)
        throw error
    }

}

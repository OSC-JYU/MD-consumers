import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { 
    objectToURLParams,
    getFile,
    getFilesFromStore,
    sendError
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'


export async function process_msg(service_url, message) {
    console.log('Processing message in process_a:', message.data);


    let payload, data
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        payload = message.json()
        data = JSON.parse(payload)
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md, DEFAULT_USER)
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
          console.log(`Reading failed: ${error.message}`);
        });
    
      postStream
        .on("error", (error) => {
          console.log(`Post failed: ${error.message}`);
        })
    

        await pipeline(postStream, writeStream)

        // finally send result and original message to MessyDesk
        data.file_total = 1
        data.file_count = 1
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

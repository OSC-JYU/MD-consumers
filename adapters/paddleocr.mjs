import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import probe from 'probe-image-size';

import { 
    getPlainText,
    getFile,
    sendError
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'

export async function process_msg(service_url, message) {

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
        console.log('**************** PADDLEOCR api ***************')
        console.log(data)
        console.log('target:')
        console.log(data.target)
        console.log('source: ', data.source)
        console.log(data.source)
        
        
        var readpath = await getFile(MD_URL, data.target, data.userId)
        
        // Get image dimensions efficiently from file header
        const dimensions = await probe(fs.createReadStream(readpath));
        console.log('Image dimensions:', dimensions);

        // Create a FormData instance
        const form = new FormData();
        form.append('file', fs.createReadStream(readpath));

        // Make the POST request with got
        const response = await got.post(service_url + '/predict_image', {
        searchParams: {
            use_angle_cls: true,
            reorder_texts: true,
        },
        body: form,
        responseType: 'text',
        });

        // Process OCR results and convert coordinates
        const ocrResults = JSON.parse(response.body);
        console.log('OCR Results:', ocrResults[0]);

        const processedResults = ocrResults.map(result => {
            // Convert absolute coordinates to relative coordinates
            const [coords, [text, confidence]] = result;
            const relativeCoords = coords.map(coord => ({
                x: coord[0] / dimensions.width,
                y: coord[1] / dimensions.height
            }));
            
            return {
                coordinates: relativeCoords,
                text: text,
                confidence: confidence
            };
        });

        // Save the processed results
        var dirname = uuidv4()
        const writepath = path.join('data', dirname)
        //const plainText = getPlainText(processedResults)
        //console.log(plainText)
        fs.writeFileSync(writepath, JSON.stringify(processedResults), 'utf8');
        console.log('File saved successfully.');

        // finally send result and original message to MessyDesk
        const readStream_md = fs.createReadStream(writepath);
        const formData_md = new FormData();
        data.file = {label:'ocr.json',  type: 'ocr.json', extension: 'json'}
        formData_md.append('content', readStream_md);
        formData_md.append('request', JSON.stringify(data), {contentType: 'application/json', filename: 'request.json'});

        const postStream_md = got.stream.post(url_md, {
            body: formData_md,
            headers: formData_md.getHeaders(),
        });
        
        await pipeline(postStream_md, new stream.PassThrough())
        console.log('file sent!')


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)

        console.error('paddleocr: Error reading, sending, or saving the image:', error.message);
        sendError(data, error, url_md)
        
    }
}


import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

import { 
    getTextFromFile,
    getFile,
    sendTextFile,
    sendError
} from '../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200'



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
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {
        
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url

        console.log(typeof data)
        console.log(data)
        console.log(service_url)
        console.log('**************** GEMINI-AI api text ***************')
        console.log(data)
        console.log(data.target)
        console.log(payload)

        var readpath = await getFile(MD_URL, data.target, data.userId)
        const uploadResult = await fileManager.uploadFile(
            readpath,
            {
              mimeType: "image/jpeg",
              displayName: "image",
            },
          );
        //console.log(uploadResult)
    
        // send payload to service endpoint
        var AIresponse = ''
        if(data.params.prompts) {

            const g_result = await model.generateContent([
                data.params.prompts.content,
                {
                  fileData: {
                    fileUri: uploadResult.file.uri,
                    mimeType: uploadResult.file.mimeType,
                  },
                },
              ]);

         
            AIresponse = g_result.response.text();
            //const deleteResponse = await fileManager.deleteFile(uploadResult.file.uri);
            //console.log(deleteResponse)
        } else {
            console.log('ERROR: Prompts not found')
        }

        const filedata = {label:'result.txt', content: AIresponse, type: 'text', ext: 'txt'}
        sendTextFile(filedata, data, url_md)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(data, error, url_md)
    }

}

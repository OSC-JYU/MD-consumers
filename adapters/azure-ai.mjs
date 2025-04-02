
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";

import { 
    getTextFromFile,
    getFile,
    sendTextFile,
    sendError
} from '../funcs.mjs';


const azureApiKey = process.env["AZURE_OPENAI_API_KEY"] 

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


        console.log(typeof data)
        console.log(data)
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** Azure AI api text ***************')
        console.log(data)
        console.log(data.target)
        console.log(payload)

        var readpath = await getFile(MD_URL, data.target, data.userId)
        var text = await getTextFromFile(readpath, 2000)
        console.log('TEKSTI HAETTU')
    
        // send payload to service endpoint
        var AIresponse = ''
        if(data.params.prompts && data.params.prompts.content) {
            var prompts = [{role: 'system', content: data.params.prompts.content}]
            prompts.push({role: 'user', content: text})
            const client = new OpenAIClient(service_url, new AzureKeyCredential(azureApiKey));
            const deploymentId = "gpt-4";
          
            const result = await client.getChatCompletions(deploymentId, prompts);
            
            console.log(result);
            for (const choice of result.choices) {
              console.log(choice.message);
              AIresponse += choice.message.content
            }
        } else {
            console.log('ERROR: Prompts not found')
            throw new Error('Prompts not found')
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


import { AzureOpenAI } from "openai";

import { 
    getTextFromFile,
    getFile,
    sendTextFile,
    sendError
} from '../funcs.mjs';


const apiKey = process.env["AZURE_OPENAI_API_KEY"] 

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
        var response = null
        if(data.params.prompts && data.params.prompts.content) {
            var prompts = [{role: 'system', content: data.params.prompts.content}]
            prompts.push({role: 'user', content: text})
            const endpoint = service_url
            const apiVersion = "2024-12-01-preview";
            const modelName = "gpt-4o";
            const deployment = "gpt-4o";
            const options = { endpoint, apiKey, deployment, apiVersion }

            const client = new AzureOpenAI(options);
            //const client = new OpenAIClient(service_url, new AzureKeyCredential(azureApiKey));
            response = await client.chat.completions.create({

                messages: prompts,
            
                max_tokens: 4096,
                  temperature: 1,
                  top_p: 1,
                  model: modelName
            
              });
            //const result = await client.getChatCompletions(deploymentId, prompts);
            
            console.log(response);
            for (const choice of response.choices) {
                console.log(choice.message);
                AIresponse += choice.message.content
            }

        } else {
            console.log('ERROR: Prompts not found')
            throw new Error('Prompts not found')
        }

        // send plain text answer
        const filedata = {label:'result.txt', content: AIresponse, type: 'text', ext: 'txt'}
        await sendTextFile(filedata, data, url_md)

        // send json including the response (response.json files are saved but they are not visible in the graph)
        const responsedata = {label:'response.json', content: JSON.stringify(response, null, 2), type: 'response', ext: 'json'}
        await sendTextFile(responsedata, data, url_md)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(data, error, url_md)
    }

}

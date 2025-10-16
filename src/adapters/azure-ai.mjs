
import { AzureOpenAI } from "openai";
import path from 'path'

import { 
    getTextFromFile,
    getFile,
    sendTextFile,
    sendJSONFile,
    getFileBuffer,
    sendError
} from '../funcs.mjs';


const apiKey = process.env["AZURE_OPENAI_API_KEY"] 

const MD_URL = process.env.MD_URL || 'http://localhost:8200'


// const TestSchema = {
//     type: "object",
//     properties: {
//       books: { 
//           type: "array", 
//           items: { 
//               type: "object", 
//               properties: { 
//                   title: { type: "string" }, 
//                   year: { type: "string" }, 
//                   authors: { type: "array", items: { type: "string" } } 
//               },
//               required: ["title", "year", "authors"],
//               additionalProperties: false
//           }
//       }
//     },
//     required: ["books"],
//     additionalProperties: false
//   };



// Function to convert simple JSON structure to JSON Schema
function createSchema(simpleJson) {
    // input is string
  
  try {
    simpleJson = JSON.parse(simpleJson)
  } catch (e) {
    console.log('Error parsing JSON:', e.message)
    return null
  }

  function convertType(value) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return { type: "array", items: { type: "string" } };
      }
      return {
        type: "array",
        items: convertType(value[0])
      };
    } else if (typeof value === "object" && value !== null) {
      const properties = {};
      const required = [];
      
      for (const [key, val] of Object.entries(value)) {
        properties[key] = convertType(val);
        required.push(key);
      }
      
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false
      };
    } else if (typeof value === "string") {
      return { type: "string" };
    } else if (typeof value === "number") {
      return { type: "number" };
    } else if (typeof value === "boolean") {
      return { type: "boolean" };
    }
    
    return { type: "string" }; // default fallback
  }
  
  return convertType(simpleJson);
}

// Example usage - much simpler!
const TestSchema = createSchema({
  books: [{
    title: "string",
    year: "string", 
    authors: ["string"]
  }]
});



export async function process_msg(service_url, message) {
    console.log('Processing message in process_a:', message.data);

    let payload, msg
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        payload = message.json()
        msg = JSON.parse(payload)
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {


        console.log(typeof msg)
        console.log(msg)
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** Azure AI api text ***************')
        console.log(msg)

        var text = ''
        var image = ''

        if(!msg.file?.['@rid']) {
            throw new Error('No file found in message')
        }

        var readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId)
        if(msg.file.type == 'text') {
            text = await getTextFromFile(readpath, 2000)
        } else if(msg.file.type == 'image') {
            image = await getFileBuffer(readpath, true)
        }


        const endpoint = service_url
        const apiVersion = msg.task.model.version;
        const deployment = msg.task.model.id;
        const options = { endpoint, apiKey, deployment, apiVersion }

        // send payload to service endpoint
        var AIresponse = ''
        var response = null
        var format = null
        if(msg.task.params.prompts && msg.task.params.prompts.content) {
            var prompts = [{role: 'system', content: msg.task.params.prompts.content}]
            if(text) prompts.push({role: 'user', content: text})
            if(image) prompts.push({role: 'user', content: [{type: "image_url", image_url: {url: `data:image/png;base64,${image}`}}]})

            // If output type is json, then we need to create a json schema
            if(msg.task.params.output_type == 'json') {
                if(msg.task.params.json_schema) {
                    var schema = createSchema(msg.task.params.json_schema)
                    if(schema) {
                        format =  {
                        type: "json_schema",
                            json_schema: {
                                name: "schema",
                                schema: schema,
                                strict: true
                            }
                        }
                    }
                } else {
                    console.log('ERROR: No json schema found')
                    throw new Error('No json schema found')
                }
            }
                
            const client = new AzureOpenAI(options);
            response = await client.chat.completions.create({

                messages: prompts,
            
                max_completion_tokens: 4096,
                temperature: 1,
                top_p: 1,
                response_format: format
            
              });
            
            console.log(response.choices);
            if(Array.isArray(response.choices)) { 
                AIresponse = response.choices[0].message.content
            } else {
                AIresponse = response.choices.message.content
            }

        } else {
            console.log('ERROR: Prompts not found')
            throw new Error('Prompts not found')
        }

        let label = 'result.txt'   
        if(msg.file.original_filename) {
            label = msg.file.original_filename + (msg.task.params.output_type == 'json' ? '.json' : '.txt')
        } else if(msg.file.label) {
             label = msg.file.label + (msg.task.params.output_type == 'json' ? '.json' : '.txt')
        }

        // send result to MD
        var filedata = null
        if(msg.task.params.output_type == 'json') {
            var content = ''
            try {
                content = JSON.parse(AIresponse)
                filedata = {label:label, content: content, type: 'json', ext: 'json'}
                
            } catch (e) {
                // if error parsing JSON, send JSON with error
                console.log('Error parsing JSON:', e.message)
                content = {error: 'Error parsing JSON'}
                filedata = {label:label, content: content, type: 'json', ext: 'json'}
            }
            await sendJSONFile(filedata, msg, url_md)
        }
        else {
            filedata = {label:label, content: AIresponse, type: 'text', ext: 'txt'}
            await sendTextFile(filedata, msg, url_md)
        }

        // send json including the response (response.json files are saved but they are not visible in the graph)
        const metadata = process_metadata(response)
        console.log(metadata)
        const output = {metadata: metadata, raw: response} 
        const responsedata = {label:'response.json', content: output, type: 'response', ext: 'json'}
        await sendJSONFile(responsedata, msg, url_md + '/metadata')


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        //console.log(error)
        console.error('elg_api: Error reading, sending, or saving the image:', error.message);

        sendError(msg, error, MD_URL)
    }

}


// extract tokens, modalities and model version from the response. These values are saved to MD database.
function process_metadata(data) {

    const metadata = {
        model: 'unknown',
        tokens: { 
            in: { count: 0, modality: 'UNKNOWN' }, 
            out: { count: 0, modality: 'UNKNOWN' }, 
            total: 0 
        }
    }

    metadata.model = data.model || 'unknown';
    metadata.tokens.in.count = data.usage.prompt_tokens || 0;
    metadata.tokens.out.count = data.usage.completion_tokens || 0;
    metadata.tokens.total = data.usage.total_tokens || 0;


    return metadata

}
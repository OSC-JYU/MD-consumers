
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY);


import { 
  getFile,
  sendJSONFile,
  sendTextFile,
  sendError,
  getTextFromFile
} from '../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200'



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

    let g_result
    try {
        
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url

        console.log('**************** GEMINI-AI api text ***************')
        console.log(msg)



        if(!msg.file?.['@rid']) {
            throw new Error('No file or target found in message')
        }

        var readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId)
        
        // Only upload files to Google's file manager if they are not text files
        let uploadResult = null
        if (msg.file.type !== 'text' && msg.file.extension !== 'txt') {
            // Determine MIME type and display name for non-text files
            let mimeType, displayName
            mimeType = "image/jpeg"
            displayName = "image"
            
            uploadResult = await fileManager.uploadFile(
                readpath,
                {
                  mimeType: mimeType,
                  displayName: displayName,
                },
              );
        }

    
        // send payload to service endpoint
        var AIresponse = ''
        if(msg.task.params.prompts) {
            // Prepare content array for the model
            const contentArray = [msg.task.params.prompts.content]
            
            // Handle different file types
            if (msg.file.type === 'text' || msg.file.extension === 'txt') {
                // For text files, read the content directly and add as text
                const textContent = await getTextFromFile(readpath, 2000)
                if (textContent) {
                    contentArray.push(textContent)
                }
            } else if (uploadResult) {
                // For image files, use the uploaded file URI
                contentArray.push({
                    fileData: {
                        fileUri: uploadResult.file.uri,
                        mimeType: uploadResult.file.mimeType,
                    },
                })
            }

            const model = genAI.getGenerativeModel({ model: msg.task.model.id });
            console.log(contentArray)
            return

            g_result = await model.generateContent(contentArray);

            console.log(g_result)
            AIresponse = g_result.response.text();
            //const deleteResponse = await fileManager.deleteFile(uploadResult.file.uri);
            //console.log(deleteResponse)
        } else {
            console.log('ERROR: Prompts not found')
            //const deleteResponse = await fileManager.deleteFile(uploadResult.file.uri);
            throw new Error('Prompts not found')
        }

        const filedata = {label:'result.txt', content: AIresponse, type: 'text', ext: 'txt'}
        await sendTextFile(filedata, msg, url_md)

        const metadata = process_metadata(g_result.response)
        const output = {metadata: metadata, raw: g_result.response}

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
    
    try {
        const usageMetadata = data.usageMetadata || {};
        const modelVersion = data.modelVersion || 'unknown';
        
        // Extract modalities from prompt tokens details
        const promptModalities = usageMetadata.promptTokensDetails || [];
        const candidateModalities = usageMetadata.candidatesTokensDetails || [];
        
        // Get input token modality (from prompt tokens details)
        const inputModality = promptModalities.length > 0 ? promptModalities.map(p => p.modality).join('+') : 'UNKNOWN';
        
        // Get output token modality (from candidates tokens details)
        const outputModality = candidateModalities.length > 0 ? candidateModalities.map(p => p.modality).join('+')  : 'UNKNOWN';
        
        // Extract token counts with modality information
        const tokenCounts = {
            in: {
                count: usageMetadata.promptTokenCount || 0,
                modality: inputModality
            },
            out: {
                count: usageMetadata.candidatesTokenCount || 0,
                modality: outputModality
            },
            total: usageMetadata.totalTokenCount || 0
        };
        
        // Create the metadata object
        const metadata = {
            model: modelVersion,
            tokens: tokenCounts
        };
        
        console.log('Extracted metadata:', metadata);
        return metadata;
        
    } catch (error) {
        console.error('Error processing metadata:', error);
        return {
            model: 'unknown',
            tokens: { 
                in: { count: 0, modality: 'UNKNOWN' }, 
                out: { count: 0, modality: 'UNKNOWN' }, 
                total: 0 
            }
        };
    }
}

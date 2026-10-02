

import { 
  getFile,
  sendJSONFile,
  sendError,
  getTextFromFile
} from '../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200'



export async function process_msg(service_url, message) {

    let msg
    const url_md = `${MD_URL}/api/nomad/process/files`
    const start = process.hrtime();

    // make sure that we have valid payload
    try {
        msg = message.json()
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
        return
    }

    try {
        
        if(!service_url.startsWith('http')) service_url = 'http://' + service_url

        console.log('**************** ANNIF api text ***************')
        console.log(msg)



        if(!msg.file?.['@rid']) {
            throw new Error('No file or target found in message')
        }

        var readpath = await getFile(MD_URL, msg.file['@rid'], msg.userId)

    
        // send payload to service endpoint
        var annif_result = null
        if(msg.task.id === 'suggest') {
            if (msg.file.type !== 'text' && msg.file.extension !== 'txt') {
                throw new Error('Annif accepts only text files')
            }
            const textContent = await getTextFromFile(readpath, 4000)  // HARD LIMIT!
            if (!textContent) {
                throw new Error('File is empty')
            }
            annif_result = await getAnnifSuggestions(service_url, msg.task.params.project_id, textContent)


        } else {
            console.log('ERROR: Task not found')
            throw new Error('Task not found')
        }

        const end = process.hrtime(start);
        const seconds = (end[0] + end[1] / 1e9).toFixed(3);
        console.log(`Execution time: ${seconds} seconds`);
        msg.response = {
            time: parseFloat(seconds)
        }

        const filedata = {label: msg.file.label + '.annif.json', content: annif_result, type: 'annif.json', ext: 'json'}
        await sendJSONFile(filedata, msg, url_md)


    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        //console.log(error)
        console.error('annif: Error processing the file:', error.message);

        await sendError(msg, error, MD_URL)
    }

}


// Annif's suggest endpoint takes a form-encoded body (text, limit, threshold).
async function getAnnifSuggestions(service_url, project_id, textContent) {   
    const response = await fetch(`${service_url}/projects/${encodeURIComponent(project_id)}/suggest`, {
        method: 'POST',
        body: new URLSearchParams({text: textContent})
    })
    if (!response.ok) {
        throw new Error(`Annif suggest failed with ${response.status}: ${await response.text()}`)
    }
    return response.json()
}
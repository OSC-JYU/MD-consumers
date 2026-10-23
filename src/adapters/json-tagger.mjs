import got from 'got'

import { 
    getTextFromFile,
    getFile,
    sendError,
    sendDone,
    mdHeaders,
    withResponseTime
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'


export async function process_msg(service_url, message) {
    
    let msg
    const startedAt = process.hrtime()
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        msg = message.json()
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
        return
    }

    try {

        console.log('**************** json-tagger API ***************')
        console.log(JSON.stringify(msg, null, 2))

        // Older messages carried the task id as a string and the file rid in `target`.
        const taskId = msg.task?.id || msg.task
        const fileRid = msg.target || msg.file?.['@rid']
        const typePrefix = msg.id || msg.service?.id

        if(taskId == 'tag') {
            if(!fileRid) throw new Error('No file found in message')
            var readpath = await getFile(MD_URL, fileRid, msg.userId)
            // read content from file
            const content = await getTextFromFile(readpath)
            const json_content = JSON.parse(content)
            console.log(json_content)
            var entities = []
            for(var item of json_content) {
                console.log(item.word)
                var entity = {
                    type: typePrefix + '-' + item.entity_group,
                    label: item.word,
                    color: '#ff8844',
                    icon: 'mdi-account'
                }
                console.log(entity)
                entities.push(entity)
            }

            // link the entities to the file as the job's user
            var url = `${MD_URL}/api/entities/link/${fileRid.replace('#', '')}`
            console.log(url)
            const response = await got.post(url, { json: entities, headers: mdHeaders(msg.userId) })
            console.log(response.statusCode)

            withResponseTime(msg, startedAt)
            await sendDone(msg, MD_URL)

        } else {
            throw new Error(`Task not found: ${taskId}`)
        }

    

    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('json-tagger: Error in tagging:', error.message);

        await sendError(msg, error, MD_URL)
    }

}

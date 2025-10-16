
import fs from 'fs-extra';
import FormData from 'form-data';
import got from 'got'
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import cld from 'cld';

import { 
    getFile,
    sendStringTextFile,
    sendTextFile,
    sendError,
    sendDone
} from '../funcs.mjs';


const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const DEFAULT_USER = 'local.user@localhost'


export async function process_msg(service_url, message_raw) {

    let message
    const url_md = `${MD_URL}/api/nomad/process/files`

    // make sure that we have valid payload
    try {
        message = JSON.parse(message_raw.json())
    } catch (e) {
        console.log('invalid message payload!', e.message)
        await sendError({}, {error: 'invalid message payload!'}, url_md)
    }

    try {

        if(!service_url.startsWith('http')) service_url = 'http://' + service_url
        console.log(service_url)
        console.log('**************** DSPACE7 api ***************')
        console.log(message)

        var dirname = uuidv4()
        const writepath = path.join('data', dirname)
        //const plainText = getPlainText(processedResults)
        //console.log(plainText)
        
        if(message.task == 'init') {
            console.log('init task')
            var init_data = {hierarchy: [], fields: []}
            var hierarchy = []
            var fields = []
            // save init.json to source node's path (init.json files are saved but they are not visible in the graph)
            // get metafields from DSpace: https://demo.dspace.org/server/api/core/metadatafields
            const metafields = await got.get('https://demo.dspace.org/server/api/core/metadatafields?size=500', {
                headers: {
                    'Accept': 'application/json'
                }
            }).json()

            for(const metafield of metafields._embedded.metadatafields) {
                // only include dublin core fields (prefix = dc)
                if(metafield._embedded.schema.prefix == 'dc') {
                    if(metafield.qualifier) {
                        var field_obj = {
                            name: 'dc.' + metafield.element + '.' + metafield.qualifier,
                            id: metafield.id,
                            scopeNote: metafield.scopeNote
                        }
                    } else {
                        var field_obj = {
                            name: 'dc.' + metafield.element,
                            id: metafield.id,
                            scopeNote: metafield.scopeNote
                        }
                    }
                    fields.push(field_obj)
                }
            }

            init_data.fields = fields


            // get communities from DSpace: https://demo.dspace.org/server/api/core/communities
            const communities = await got.get('https://demo.dspace.org/server/api/core/communities?size=500', {
                headers: {
                    'Accept': 'application/json'
                }
            }).json()

            // fetch all collections for each community
            for(const community of communities._embedded.communities) {
                var community_obj = {
                    name: community.name,
                    id: community.id,
                    collections: []
                }
                const collections = await got.get(`https://demo.dspace.org/server/api/core/communities/${community.id}/collections?size=500`, {
                    headers: {
                        'Accept': 'application/json'
                    }
                }).json()


                for(const collection of collections._embedded.collections) {
                    var collection_obj = {
                        name: collection.name,
                        id: collection.id
                    }
                    community_obj.collections.push(collection_obj)
                }
                // skip empty communities
                if(community_obj.collections.length > 0) {
                    hierarchy.push(community_obj)
                }
            }

            init_data.hierarchy = hierarchy

            // save metafields to init.json

            const responsedata = {label:'init.json', content: JSON.stringify(init_data, null, 2), type: 'response', ext: 'json'}
            await sendTextFile(responsedata, message, url_md)


        } else if(message.task == 'make_query') {
      
            const query_url = `https://demo.dspace.org/server/api/discover/search/objects?sort=dc.date.accessioned,DESC&page=0&size=10&query=${message.params.query}`
            console.log(query_url)
            const response = await got.get(query_url, {
                headers: {
                    'Accept': 'application/json'
                }
            }).json()
            try {
                for(const item of response._embedded.searchResult._embedded.objects) {
                    const responsedata = {label:item._embedded.indexableObject.name + '.json', content: JSON.stringify(item, null, 2), type: 'dspace7.json', ext: 'dspace7.json'}
                    await sendTextFile(responsedata, message, url_md)
                }
            } catch (error) {
                console.log(query_url)
                console.log('error sending dspace7 data')
                console.log(error)
                sendError(message, error, MD_URL)
            }
            // notify MessyDesk that we are done
            await sendDone(message, url_md)


        } else if(message.task == 'get_abstracts') {

            var file = await getFile(MD_URL, message.file['@rid'], DEFAULT_USER, '')
            // read DSpace item as json
            const file_content = await fs.readFile(file, 'utf8')
            var item = JSON.parse(file_content)

            var abstract = ''
            try {
                var abstracts = item._embedded.indexableObject.metadata['dc.description.abstract']
                if(Array.isArray(abstracts)) {
                    abstract = abstracts[0].value
                }
            } catch (error) {
                console.log('error getting abstract')
            }
        
            if(abstract) {

                //var language = message.params.language
                if(message.params.language_source == 'detect language') {
                    var detected_language = await cld.detect(abstract)
                    console.log(detected_language)
                } else {
                    var language = message.params.language
                    console.log(language)
                }
 

                var responsedata = {label:item._embedded.indexableObject.name + '.txt', content: abstract, type: 'text', ext: 'txt'}
                await sendStringTextFile(responsedata, message, url_md)
            }
        }
        console.log('Dspace7 data sent!')



    } catch (error) {
        console.log('pipeline error')
        console.log(error.status)
        console.log(error.code)
        console.log(error)
        console.error('elg_api: Error reading, sending, or saving:', error.message);

        sendError(message, error, MD_URL)
    }
}

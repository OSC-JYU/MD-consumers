
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
        //console.log(message)

        var dirname = uuidv4()
        const writepath = path.join('data', dirname)
        //const plainText = getPlainText(processedResults)
        //console.log(plainText)
        
        const dspace_url = message.task.params.url


        // ************** init task **************    
        if(message.task.id == 'init') {
            console.log('init task')
            var init_data = {hierarchy: [], fields: []}
            var hierarchy = []
            var fields = []
            // save init.json to source node's path (init.json files are saved but they are not visible in the graph)
            // get metafields from DSpace: https://demo.dspace.org/server/api/core/metadatafields
            const metafields = await got.get(dspace_url + '/core/metadatafields?size=500', {
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
            const communities = await got.get(dspace_url + '/core/communities?size=500', {
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
                const collections = await got.get(`${dspace_url}/core/communities/${community.id}/collections?size=500`, {
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
            const metadata_url = `${MD_URL}/api/nomad/process/files/metadata`
            const responsedata = {label:'init.json', content: JSON.stringify(init_data, null, 2), type: 'response', ext: 'json'}
            await sendTextFile(responsedata, message, metadata_url)
     
            console.log('init.json sent!')


        // ************** make_query task **************        
        } else if(message.task.id == 'make_query') {
            // build query url
            var query_url = `${dspace_url}/discover/search/objects?query=${message.task.params.query}`
            if(message.task.params.scope) {
                query_url += `&scope=${message.task.params.scope}`
            }
            if(message.task.params.sort) {
                query_url += `&sort=${message.task.params.sort}`
            }
            if(message.task.params.page) {
                query_url += `&page=${message.task.params.page}`
            }
            if(message.task.params.size) {
                query_url += `&size=${message.task.params.size}`
            }
      
            console.log(query_url)
            const response = await got.get(query_url, {
                headers: {
                    'Accept': 'application/json'
                }
            }).json()
            try {
                for(const item of response._embedded?.searchResult?._embedded?.objects || []) {
                    //console.log(JSON.stringify(item, null, 2))
                    var label = item._embedded.indexableObject.name
                        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
                        .replace(/["']/g, '') // Remove quotes
                    const responsedata = {label:label + '.json', content: JSON.stringify(item._embedded.indexableObject, null, 2), type: 'dspace7.json', ext: 'dspace7.json'}
                    await sendTextFile(responsedata, message, url_md, true)
                }
            } catch (error) {
                console.log('error sending dspace7 data')
                console.log(error.message)
            }


        // ************** get_abstracts task **************    
        } else if(message.task.id == 'get_abstracts') {

            var file = await getFile(MD_URL, message.file['@rid'], DEFAULT_USER, '')
            // read DSpace item as json
            const file_content = await fs.readFile(file, 'utf8')
            var item = JSON.parse(file_content)
           

            var abstract = ''
            try {
                var abstracts = item.metadata?.['dc.description.abstract']
                console.log(abstracts)
                if(Array.isArray(abstracts)) {
                    abstract = abstracts[0].value
                }
            } catch (error) {
                console.log('error getting abstract')
            }
        
            if(abstract) {

                //var language = message.params.language
                if(message.task.params.language_source == 'detect language') {
                    var detected_language = await cld.detect(abstract)
                    console.log(detected_language)
                } else {
                    var language = message.task.params.language
                    console.log(language)
                }

                if(item.metadata?.['dc.title']) {
                    var title = item.metadata?.['dc.title'][0].value
                    console.log(title)
                    abstract = title + '\n\n' + abstract
                }

                var responsedata = {label:item.name + '.txt', content: abstract, type: 'text', ext: 'txt'}
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

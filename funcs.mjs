import got from 'got'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import FormData from 'form-data';
import stream from 'node:stream';
import { promises as fs } from 'fs';
import { ensureDir } from 'fs-extra/esm'

const KEEP_FILENAME = 1
const DEFAULT_USER = 'local.user@localhost'

export async function createDataDir(data_dir) {
	try {
		//await fs.ensureDir(data_dir)
		await ensureDir('data')
		await ensureDir('data/source')
	} catch(e) {
		throw('Could not create data directory!' + e.message)
	}
}

export async function getServiceURL(nomad_url, service, dev_url, wait) {
  if(dev_url) return dev_url
	// NOTE: this gives only the first address
	const url = nomad_url + `/service/${service}`
  console.log('getting service url:', url)

	var service_url = ''
    try {
        var response = await got.get(url).json()
        while(response.length == 0 && wait) {
          console.log('waiting for service...')
          await sleep(1000)
          response = await got.get(url).json()
        }
        //console.log(response)
        if(response.length > 0) {
            service_url = `${response[0].Address}:${response[0].Port}`
        }
    } catch(e) {
        if(e.code == 'ECONNREFUSED')
          throw(`Nomad not found from ${nomad_url}`)
        else
          throw('Error in nomad query:' , e.code)
    }
	return service_url
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function createService(md_url, service) {
  const url = md_url + `/api/nomad/service/${service}`
  console.log('creating service:', url)
  try {
      const options = { headers: { 'mail': DEFAULT_USER } }
      var response = await got.post(url, options).json()  
      return response
  } catch(e) {
      if(e.code == 'ECONNREFUSED')
        throw(`Messydesk not found from ${md_url}`)
      else
        throw('Error in starting service with MessyDesk API query:' , e.response.body)
  }
}


export async function stopService(md_url, service) {
  const url = md_url + `/api/nomad/service/${service}`
  try {
      const options = { headers: { 'mail': DEFAULT_USER } }
      var response = await got.delete(url, options).json()  
      return response
  } catch(e) {
      if(e.code == 'ECONNREFUSED')
        throw(`Messydesk not found from ${md_url}`)
      else
        throw('Error in stopping service with MessyDesk API query:' , e.response.body)
  }
}


export async function getFile(md_url, file_rid, user, source) {
  const sourcePath = source ? source : '';
  const filename = uuidv4();
  const writepath = path.join('data', 'source', filename);
  const file_url = `${md_url}/api/files/${file_rid.replace('#', '')}${sourcePath}`;

  try {
    await pipeline(
      got.stream(file_url, { headers: { mail: user } }),
      createWriteStream(writepath)
    );
    console.log(`File downloaded to ${writepath}`);
    return writepath;
  } catch (error) {
    console.error(`Error during file download or write: ${error.message}`);
    throw error;
  }
}



export function objectToURLParams(obj) {
    const params = [];
  
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        let value = obj[key];
        if (Array.isArray(value)) {
          value.forEach((item) => {
            params.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(item)}`);
          });
        } else {
          params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
      }
    }
  
    return params.join('&');
  }


export function getPlainText(text) {
  var lines = []
  if(Array.isArray(text)) {
    for(var t of text) {
      lines.push(t[1][0])
    }
  }
  return lines.join(' ')
}

// get output files from service and send them to MessyDesk
export async function getFilesFromStore(response, service_url, message, md_url, file_labels) {

  if(Array.isArray(file_labels) && file_labels.length > 0) {
    message.file.label = file_labels[0]
  }

    if(response.uri) {
      if(!message.file) { message.file = {} }
   
      // download array of files
      if(Array.isArray(response.uri)) {
        const total = response.uri.length
        var count = 0
        
        for(var url of response.uri) {
          // if service return array of files, then we keep those filenames unless file_labels is set
          message.file_total = total
          message.file_count = count + 1
          let filedata;
          if(file_labels && file_labels.length > count) {
            message.file.label = file_labels[count];
            filedata = await downloadFile(url, service_url);
          } else {
            filedata = await downloadFile(url, service_url, KEEP_FILENAME);
          }
          await sendFile(filedata, message, md_url)
          count++
        }
      // download single file
      } else {
        message.file_total = 1
        message.file_count = 1
        const filedata = await downloadFile(response.uri, service_url)
        await sendFile(filedata, message, md_url)
      }
    } else {
      console.log('File download not found!')
    }
  }



async function downloadFile(file_url, service_url, keep_filename) {

  const uuid = uuidv4()
  var ext = path.extname(file_url).replace('.', '')
  var type = 'text'
  if(['png','jpg','jpeg'].includes(ext)) type = 'image'
  if(['pdf'].includes(ext)) type = 'pdf'
  if(['xml'].includes(ext)) type = 'xml'
  if(['json'].includes(ext)) type = 'json'

  // JSON can have sub types like "human.json"
  if(type == 'json') {
    // if file_url contains two dots, then it is a sub type
    type = extractDoubleExtension(file_url, type)
  }

  const filepath = `data/${type}_${uuid}.${ext}`
  console.log('type: ', type)
  console.log('ext: ', ext)
  console.log('uuid: ', uuid)
  console.log('filepath: ', filepath)
  console.log('getting file: ', service_url + file_url)

  const readStream = got.stream(service_url + file_url)
  const writeStream = createWriteStream(filepath)
  await pipeline(readStream, writeStream)
  if(keep_filename) 
    return {path:filepath, type: type, ext: ext, label: path.basename(file_url)}
  else
    return {path:filepath, type: type, ext: ext}
}



async function sendFile(filedata, message, md_url) {

  message.file.type = filedata.type
  message.file.extension = filedata.ext
  message.file.label = message.file.label + '.' + filedata.ext
  
  if(filedata.label)
    message.file.label = filedata.label

  const readStream = createReadStream(filedata.path);
  const formData = new FormData();
  formData.append('content', readStream);
  formData.append('request', JSON.stringify(message),{contentType: 'application/json', filename: 'request.json'});
  const response = await got.post(md_url, {
    body: formData,
    headers: {
      ...formData.getHeaders(),
      'mail': DEFAULT_USER
    }
  });
  if(response.ok)
    console.log('File streamed successfully')
  else 
    console.log('File not streamed')
}

export async function sendError(data, error, url_md, user) {
  console.log(error)
  if(!user) user = DEFAULT_USER
  
  try {
      await got.post(url_md + '/error', {json: {error:error, message: data}, headers: { 'mail': user }})
  } catch (e) {
    console.log(e)
      console.log('sending error failed')
  }
}

function extractDoubleExtension(fileName, type) {
  if(!fileName) return type;
  const parts = fileName.split('.');
  
  if(parts.length == 2) return parts[parts.length - 1];
  return parts[parts.length - 2] + '.' + parts[parts.length - 1];
}


export async function sendTextFile(filedata, message, md_url) {

  message.file.type = filedata.type
  message.file.extension = filedata.ext
  
  if(filedata.label)
    message.file.label = filedata.label

  const textBuffer = Buffer.from(filedata.content, 'utf-8');
  const formData = new FormData();

  // Append the text file to the form data
  formData.append('content', textBuffer, {
    filename: filedata.label,
    contentType: 'text/plain', // Set the content type to text/plain
  });

  formData.append('request', JSON.stringify(message),{contentType: 'application/json', filename: 'request.json'});


  const response = await got.post(md_url, {
    body: formData,
    headers: {
      ...formData.getHeaders(),
      'mail': DEFAULT_USER
    }
  });

  if(response.ok)
    console.log('File send successfully')
  else 
    console.log('File not streamed')
}

export async function getTextFromFile(filepath, limit) {
  console.log('reading file: ', filepath)
  var text = await fs.readFile(filepath, 'utf8');
  // limit text 
  if(limit) {
    if(text.length > limit) text = text.substring(0, limit)
  }
  return text
}

export async function getFileBuffer(filepath, asBase64 = false) {
  const buffer = await fs.readFile(filepath);
  if (asBase64) {
    return buffer.toString('base64');
  }
  return buffer;
}

  export function printInfo(name, nomad_url, nats_url, md_url) {

    console.log('MessyDesk consumer: ', name)
    console.log('-------------------')
    console.log('nomad:', nomad_url)
    console.log('nats:', nats_url)
    console.log('messydesk:', md_url)
    console.log('___________________')
  }

function getHeaders(user) {
  const options = {
    headers: {
        mail: user
    }
  }
  return options    
}
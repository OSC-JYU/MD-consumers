import got from 'got'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import FormData from 'form-data';
import stream from 'node:stream';
import { promises as fs } from 'fs';



const KEEP_FILENAME = 1

export async function getServiceURL(nomad_url, service, dev_url, wait) {
  if(dev_url) return dev_url
	// NOTE: this gives only the first address
	const url = nomad_url + `/service/${service}`
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
  const url = md_url + `/api/nomad/service/${service}/create`
  try {
      var response = await got.post(url).json()   
  } catch(e) {
      if(e.code == 'ECONNREFUSED')
        throw(`Messydesk not found from ${md_url}`)
      else
        throw('Error in starting service with MessyDesk API query:' , e.response.body)
  }
}



export async function getFile(md_url, file_rid, user, source) {
  // if source is set, we fetch source file of the file_rid 
  // pseudo query: ({File}->PROCESSED_BY->{Process}-PRODUCED->{File (where @rid = file_rid)})
  (!source) ? source = '' : source = '/source'
  var filename = uuidv4()
  const writepath = path.join('data', 'source', filename)
  console.log('getfile')
  console.log(writepath)
  console.log(file_rid)
  const fileWriterStream = createWriteStream(writepath);

  file_rid = file_rid.replace('#','')
  const file_url = `${md_url}/api/files/${file_rid}${source}`

  const options = {
    headers: {
      mail: user
    }
  };

  const downloadStream = got.stream(file_url, options);

  downloadStream
    .on("error", (error) => {
      console.error(`Download failed: ${error.message}`);
    });

  fileWriterStream
    .on("error", (error) => {
      console.error(`Could not write file to system: ${error.message}`);
    })


  try {
    await pipeline(downloadStream, fileWriterStream);
    console.log(`File downloaded to ${writepath}`);
    return writepath
  } catch (error) {
    console.error(`Something went wrong. ${error.message}`);
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


export async function getFilesFromStore(response, service_url, message, md_url) {

    if(response.uri) {
   
      // download array of files
      if(Array.isArray(response.uri)) {
        for(var url of response.uri) {
          // if service return array of files, then we keep those filenames
          const filedata = await downloadFile(url, service_url, KEEP_FILENAME)
          await sendFile(filedata, message, md_url)
        }
      // download single file
      } else {
        // first, create file object to graph
        // process_rid, file_type, extension, label
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
    // if file_url contains do dots, then it is a sub type
    type = extractDoubleExtension(file_url, type)

  }

  const filepath = `data/${type}_${uuid}.${ext}`

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
    }
  });
  if(response.ok)
    console.log('File streamed successfully')
  else 
    console.log('File not streamed')
}


function extractDoubleExtension(fileName, type) {
  if(!fileName) return type;
  const parts = fileName.split('.');
  if(parts.length < 2) return type;
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
    }
  });

  if(response.ok)
    console.log('File send successfully')
  else 
    console.log('File not streamed')
}

export async function getTextFromFile(filepath, limit) {
  console.log('reading file: ', filepath)
  const text = await fs.readFile(filepath, 'utf8');
  // limit text to 1000 chars
  if(limit) {
    if(text.length > limit) text = text.substring(0, limit)
  }
  return text
}

export async function getFileBuffer(filepath) {

  return await fs.readFile(filepath)
}

  export function printInfo(name, nomad_url, nats_url, md_url) {

    console.log('MessyDesk consumer: ', name)
    console.log('-------------------')
    console.log('nomad:', nomad_url)
    console.log('nats:', nats_url)
    console.log('messydesk:', md_url)
    console.log('___________________')
  }


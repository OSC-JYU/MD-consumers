import got from 'got'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';


export async function getServiceURL(nomad_url, service, dev_url) {
  if(dev_url) return dev_url
	// NOTE: this gives only the first address
	const url = nomad_url + `/service/${service}`
	var service_url = ''
    try {
        var response = await got.get(url).json()
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



export async function createService(md_url, service) {
  const url = md_url + `/api/nomad/service/${service}/create`
  try {
      var response = await got.post(url).json()       
  } catch(e) {
      if(e.code == 'ECONNREFUSED')
        throw(`Messydesk not found from ${md_url}`)
      else
        throw('Error in starting service with MessyDesk API query:' , e.code)
  }
}

export async function getFile(md_url, file_rid) {
  var filename = uuidv4()
  const writepath = path.join('data', 'source', filename)
  const fileWriterStream = createWriteStream(writepath);

  const file_url = `${md_url}/api/files/${file_rid}`
  //got.stream(file_url).pipe(createWriteStream('data/source/image.png'));

  const downloadStream = got.stream(file_url);

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


  export function printInfo(name, nomad_url, nats_url, md_url) {

    console.log('MessyDesk consumer: ', name)
    console.log('-------------------')
    console.log('nomad:', nomad_url)
    console.log('nats:', nats_url)
    console.log('messydesk:', md_url)
    console.log('___________________')
  }


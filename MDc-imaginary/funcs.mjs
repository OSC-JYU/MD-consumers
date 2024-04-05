import got from 'got'

export async function getServiceURL(nomad_url, service) {
	// NOTE: this gives only the first address
	const url = nomad_url + `/service/${service}`
	console.log(url)
	var service_url = ''
    try {
        var response = await got.get(url).json()
        console.log(response)
        if(response.ok && response.length > 0) {
            service_url = `${response[0].Address}:${response[0].Port}`
        }
    } catch(e) {
        console.log(e.message)
    }
	return service_url
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

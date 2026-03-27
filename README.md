# MD-consumers
Service adapters for MessyDesk

## What are this?

Service adapter is application that **consumes messages from the certain queue (topic)** of MessyDesk. This is the layer that knows the details of how to call certain service that will eventually do all the work. In other words, consumers translates request from MessyDesk to API in question. 

Every service has its own instance of service adapter. So if you have 6 services, then you would have 6 service adapters running also.


### example

The service "md-imaginary" is defined in /services/md-imaginary/service.json in MessyDesk's root directory. The local_url is the url that is used for when running whole system locally and without nomad.

    TOPIC=md-imaginary node src/index.mjs

This now listens message stream called "md-imaginary" and sends processing request to http://localhost:9000 as defined in service.json (local_url)  
NOTE: You must manually start the actual service. In this case like this:

    docker pull nextcloud/aio-imaginary
    docker run -d --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary 


If you want to run this with nomad, then add NOMAD environment variable. This will start the service with nomad (IF service HAS nomad.hcl). Obviously you must have also nomad installed.

    TOPIC=md-imaginary NOMAD=1 node src/index.mjs

# Container

This will start thumbnailer adapter (TOPIC=md-thumbnailer) in local installation (network=host). It will also start thumbnailer service in nomad cluster (NOMAD=true). 

podman run --rm -it -e TOPIC=md-thumbnailer  -e NOMAD=true --network=host osc.repo.kopla.jyu.fi/messydesk/md-consumer:26.01.12  "node src/index.mjs"



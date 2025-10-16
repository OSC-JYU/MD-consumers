# MD-consumers
Service adapters for MessyDesk

## What are these?

Consumers aka service adapters are small applications that consumes messages from the main work queue of MessyDesk. This is the layer that knows the details of how to call certain service that will eventually do all the work. 

In other words, consumers translates request from MessyDesk to API in question. There are several adapter for different kind of services.

One must start right consumer for each service with the name of the service.



### example

The service "md-imaginary" is defined in /services/md-imaginary/service.json in MessyDesk's root directory. The local_url is the url that is used for when running whole system locally and without nomad.

    TOPIC=md-imaginary node src/index.mjs

This now listens message stream called "md-imaginary" and sends processing request to http://localhost:9000 as defined in service.json (local_url)  
NOTE: You must manually start the actual service. In this case like this:

    docker pull nextcloud/aio-imaginary
    docker run -d --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary 


If you want to run this with nomad, then add NOMAD environment variable. This will start the service with nomad (IF service HAS nomad.hcl). Obviously you must have also nomad installed.

    TOPIC=md-imaginary NOMAD=1 node src/index.mjs





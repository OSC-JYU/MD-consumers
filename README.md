# MD-consumers
Work queue consumers for MessyDesk

## What are these?

Consumers are small applications that consumes messages from the main work-queue of MessyDesk. This is the layer that knows the details of how to call certain service that will eventually do all the work. 

In other words, consumers translates request from MessyDesk to API in question. There

When consumer app is started, one must tell it the name of the service.

	NAME=thumbnailer node api-imaginary.mjs

The service "thumbnailer" is defined in /services/thumbnailer in MessyDesk's root directory.


Imaginary


# imaginary

MessyDesk consumer for imaginary service.
Example:

	NAME=md-imaginary node api-imaginary.mjs


# ELG

ELG is public API of European Language Grid. This app implements minimal combability.
https://european-language-grid.readthedocs.io/en/release1.1.1/all/A2_API/LTPublicAPI.html



# Azure Ai

One need to set API key in environment variable called AZURE_OPENAI_API_KEY

	NAME=md-azure-ai node api-azure-ai.mjs


# Replicate.com

Work in progress!

	NAME=md-replicate-image node api-replicate.mjs


# local development


Start imaginary

    docker pull nextcloud/aio-imaginary
    docker run --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary 


Start NATS:

    docker run -d --name nats-main -p 4222:4222 -p 6222:6222 -p 8222:8222 nats -js -m 8222


Start consumer with DEV_URL (no need for Nomad)

    DEV_URL="http://localhost:9000" node api_imaginary.mjs

Call publish.mjs from tests directory:

    node tests/publisj.mjs


## Developing with Nomad

Start Nomad locally:

    sudo nomad agent -dev   -bind 0.0.0.0   -network-interface='{{ GetDefaultInterfaces | attr "name" }}'


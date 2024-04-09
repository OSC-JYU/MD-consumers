
# MDc-imaginary

MessyDesk consumer for imaginary service.

## local development


Start imaginary

    docker pull nextcloud/aio-imaginary
    docker run --name md-imaginary -p 9000:9000 nextcloud/aio-imaginary 


Start NATS:

    docker run -d --name nats-main -p 4222:4222 -p 6222:6222 -p 8222:8222 nats -js -m 8222


Start consumer with DEV_URL (no need for Nomad)

    DEV_URL="http://localhost:9000" node index.njs

Call publish.mjs from tests directory:

    node tests/publisj.mjs


## Developing with Nomad

Start Nomad locally:

    sudo nomad agent -dev   -bind 0.0.0.0   -network-interface='{{ GetDefaultInterfaces | attr "name" }}'
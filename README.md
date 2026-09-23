# MD-consumers
Service adapters for MessyDesk

## What are service adapters?

Service adapter is application that **consumes messages from the certain queue (topic)** of MessyDesk and connects them to actual service.

Every service has its own instance of service adapter. So if you have 6 services, then you would have 6 service adapters running also.


### example (md-tesseract with Nomad)

We want users to be able to run Tesseract for their images. Tesseract wrapper image must be built first:

    git clone https://github.com/OSC-JYU/MD-tesseract
    cd MD-tesseract
    sudo make build

MD-tesseract repository has nomad.hcl that tells how it can be run in Nomad. We provide `NOMAD_HCL_PATH` for adapter:


    cd MD-consumers
    TOPIC=md-tesseract NOMAD_HCL_PATH=/absolute/path/to/MD-tesseract/nomad.hcl node src/index.mjs

This would start service container (md-tesseract) witn nomad and adapter code will register service to MessyDesk backend -> User can OCR images with Tesseract.


### External services

If API is external - like commercial inference APIs for example - then you need a service.json that tells system what adapter to use and where service is located.

TODO: documentation



## Optional environment variables

- `SERVICE_JSON_PATH`: Explicit path to service descriptor JSON (for example `../MessyDesk/services/md-azure-ai/service.json`).
    - If set, this descriptor is used for registration metadata and overrides runtime `/config` metadata.
    - If not set, descriptor must be available from service `/config`.
    - Relative paths are resolved against current working directory, project root, and `/src`.
- `NOMAD_HCL_PATH`: Explicit path to Nomad job specification.
    - If set, consumer uses Nomad service discovery and tries to start the service via MessyDesk API.
- `HELP_URL`: Explicit URL for service help ingestion source.
    - Useful for external API services that do not provide `/help` endpoint.
    - If not set, consumer falls back to descriptor `help_url`, then descriptor `source_url`.
- `STRICT_TOPIC_ID`: Controls startup validation that `TOPIC` must match descriptor `id`.
    - Default is strict mode (`true`) and consumer exits fast on mismatch.
    - Set `STRICT_TOPIC_ID=false` only for temporary debugging.
- `REQUIRE_DEV_URL_UP`: When `DEV_URL` is set and `NOMAD_HCL_PATH` is not set, require service to be reachable before adapter startup.
    - Default is enabled (`true`).
    - Reachability check accepts runtime `/config` or healthy `/health`.
    - Set `REQUIRE_DEV_URL_UP=false` only for temporary debugging.
- `DEV_URL_WAIT_MAX_MS`: Max wait time for DEV_URL preflight (default `10000`).
- `DEV_URL_WAIT_STEP_MS`: Poll interval for DEV_URL preflight (default `1000`).
- `DEV_URL_PROBE_TIMEOUT_MS`: Request timeout per preflight probe request (default `3000`).




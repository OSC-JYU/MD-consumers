# Environment Variables

## Required

| Variable | Description |
|---|---|
| `TOPIC` | Queue/consumer name. Determines which queue topic to poll and which service to manage. |

## Connection

| Variable | Default | Description |
|---|---|---|
| `MD_URL` | `http://localhost:8200` | MessyDesk core API base URL (also used for queue polling) |
| `NOMAD_URL` | `http://localhost:4646/v1` | Nomad API URL for service discovery |

## Service Discovery

| Variable | Default | Description |
|---|---|---|
| `DEV_URL` | `null` | Override service URL (bypasses all discovery) |
| `NOMAD_HCL_PATH` | `null` | Explicit path to Nomad job spec file. Enables Nomad mode and overrides all other Nomad HCL path resolution. |
| `SERVICE_JSON_PATH` | `null` | Explicit path to service descriptor JSON |
| `SERVICE_DESCRIPTOR_PATH` | `null` | Alias for `SERVICE_JSON_PATH` |

## Adapter

| Variable | Default | Description |
|---|---|---|
| `ADAPTER` | from descriptor | Force specific adapter module name (without `.mjs`) |

## Registration

| Variable | Default | Description |
|---|---|---|
| `REGISTRATION_MAX_ATTEMPTS` | `5` | Max retry attempts for service registration |
| `REGISTRATION_INITIAL_DELAY_MS` | `500` | Initial backoff delay for registration retries |
| `DESCRIPTOR_WAIT_MAX_MS` | `15000` | Max wait for runtime `/config` descriptor when no explicit descriptor path is provided |
| `DESCRIPTOR_WAIT_STEP_MS` | `1000` | Poll interval while waiting for runtime `/config` descriptor |
| `HELP_URL` | `null` | Override URL for service help ingestion |

## Queue Polling

| Variable | Default | Description |
|---|---|---|
| `POLL_MIN_MS` | `100` | Minimum polling interval when idle |
| `POLL_MAX_MS` | `2000` | Maximum polling interval (idle backoff cap) |
| `CONTROL_PORT` | `9100` | Port for the control HTTP server (pause/resume/cancel signals) |

## Adapter-Specific

| Variable | Used by | Description |
|---|---|---|
| `GOOGLE_API_KEY` | `gemini-ai` | Google Gemini API key |
| `AZURE_OPENAI_API_KEY` | `azure-ai` | Azure OpenAI API key |
| `OLLAMA_MODEL` | `ollama` | Default Ollama model (fallback if not in message) |
| `MD_PATH` | `solr`, `sharp-thumbnailer` | MessyDesk data root path (enables direct file access; falls back to HTTP if unset) |
| `CONTAINER` | `solr` | Container mode flag for path resolution |
| `STORAGE_MODE` / `FILE_STORAGE_MODE` | `solr`, `poppler` | `disk` or `http` — controls file access strategy |
| `SOLR_CORE` | `solr` | (commented out in source, hardcoded to `messydesk`) |

**Verified from:** `src/index.mjs` and adapter modules.

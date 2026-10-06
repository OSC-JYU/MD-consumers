# Environment Variables

## Required

| Variable | Description |
|---|---|
| `TOPIC` | Queue/consumer name. Determines which queue topic to poll and which service to manage. |

## Connection

| Variable | Default | Description |
|---|---|---|
| `MD_URL` | `http://localhost:8200` | MessyDesk core API base URL (also used for queue polling) |
| `SERVICE_TOKEN` | `''` | Sent as `Authorization: Bearer` on every backend call; must match the backend's `SERVICE_TOKEN`. Unset: legacy `mail: local.user@localhost` header (backend `SERVICE_AUTH_LEGACY_MAIL=true` only) |
| `NOMAD_URL` | `http://localhost:4646/v1` | Nomad API URL for service discovery |

## Service Discovery

| Variable | Default | Description |
|---|---|---|
| `DEV_URL` | `null` | Override service URL (bypasses all discovery) |
| `NOMAD_HCL_PATH` | `null` | Explicit path to Nomad job spec file. Enables Nomad mode and overrides all other Nomad HCL path resolution. |
| `SERVICE_JSON_PATH` | `null` | Explicit path to service descriptor JSON |
| `SERVICE_DESCRIPTOR_PATH` | `null` | Alias for `SERVICE_JSON_PATH` |
| `CONFIG_JSON_PATH` | `null` | For providers the consumer calls directly (LLM adapters): `{ "service": <descriptor>, "provider": {...}, "help": "<markdown path relative to the file>" }`. `service` is registered (re-read on every heartbeat), `provider` goes to the adapter only, `help` is sent to MessyDesk. `TOPIC` defaults to `service.id`. Replaces DEV_URL discovery and the `/config` preflight. |

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
| *(named by `provider.api_key_env`)* | `llm-openai`, `llm-gemini` | Provider API key; the config file only names the variable (`llm-gemini` defaults to `GOOGLE_API_KEY`) |
| `MD_PATH` | `solr` | MessyDesk data root path (enables direct file access; falls back to HTTP if unset) |
| `CONTAINER` | `solr` | Container mode flag for path resolution |
| `STORAGE_MODE` / `FILE_STORAGE_MODE` | `solr`, `poppler` | `disk` or `http` — controls file access strategy |
| `SOLR_CORE` | `solr` | Solr core name (default `messydesk`) |
| `SOLR_COMMIT_WITHIN_MS` | `solr` | Solr makes indexed pages and tag changes searchable within this many ms (default `1000`); replaces a commit per page |
| `ZIP_WAIT_MAX_MS` / `ZIP_POLL_MS` | `elg` | How long to wait for a set ZIP job (default 10 min) and the poll interval (default 2 s) |

**Verified from:** `src/index.mjs` and adapter modules.

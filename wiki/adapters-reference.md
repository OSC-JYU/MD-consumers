# Adapters Reference

## Summary Table

| Adapter | File | Service type | Input types | Output |
|---|---|---|---|---|
| `gemini-ai` | `gemini-ai.mjs` | Google Gemini LLM | image, text | text + metadata JSON |
| `azure-ai` | `azure-ai.mjs` | Azure OpenAI | image, text | text + metadata JSON |
| `ollama` | `ollama.mjs` | Self-hosted LLM (Ollama) | image, text | text/JSON + metadata |
| `elg`, `elg_fs` | `elg.mjs` | Generic `/process` service, disk or http storage | any | outputs written to data/<db>/tmp |
| `solr` | `solr.mjs` | Solr search indexing | text (disk path) | done signal |
| `paddleocr` | `paddleocr.mjs` | PaddleOCR | image | OCR JSON |
| `poppler` | `poppler.mjs` | PDF processing | PDF | images/files |
| `dspace7` | `dspace7.mjs` | DSpace 7 repository | text | text export |
| `annif` | `annif.mjs` | Annif subject indexing | text | JSON suggestions |
| `libretranslate` | `libretranslate.mjs` | LibreTranslate machine translation/detection | text, html | translated text/html or JSON |
| `json-tagger` | `json-tagger.mjs` | Entity tagging | JSON (NER output) | entities linked via API |
| `test` | `test.mjs` | Test/debug | any | delayed text/JSON |

## Adapter Details

### gemini-ai

- Uses `@google/genai` SDK directly (no HTTP proxy to a service)
- `service_url` parameter is effectively unused (the SDK connects to Google's API)
- For non-text files: uploads to Google's file manager, then creates multimodal prompt
- For text files: reads content directly (hard limit: 4000 chars)
- Outputs: `result.txt` (plain text) + `response.json` (metadata to `/metadata` endpoint)
- Extracts token usage metadata (in/out counts, modalities, model version)

**Verified from:** `src/adapters/gemini-ai.mjs`

### azure-ai

- Uses `openai` SDK's `AzureOpenAI` client
- Supports structured JSON output via `response_format` with auto-generated JSON Schema
- `createSchema()` converts simple JSON structures to proper JSON Schema (with `additionalProperties: false`)
- Image input sent as base64 data URL
- Text input limit: 2000 chars

**Verified from:** `src/adapters/azure-ai.mjs`

### ollama

- Calls Ollama's HTTP API (`/api/chat` or `/api/generate`)
- Supports vision models (base64 images in `images` field)
- Supports structured JSON output via `format` parameter
- Endpoint auto-detection: strips trailing path if already present
- 120s request timeout
- Output label inherits `original_filename` or `file.label` from input

**Verified from:** `src/adapters/ollama.mjs`

### elg / elg_fs (one adapter)

`elg_fs.mjs` re-exports `elg.mjs`; both names stay for existing descriptors.

- Calls `service_url/process` with the message JSON (multipart field `message`).
- **Storage of the service** comes from its `/config` (`adapter: elg_fs` or `storage_mode: disk`
  = disk, anything else = http), cached for a minute:
  - disk: only the message is sent; the service reads `message.file.path` and writes its outputs
    to `data/<db>/tmp`.
  - http: the input is uploaded as `content` (a set as ZIP via `getFilesZip` when `input_set` is
    present), plus `source` when `msg.file.source` exists. With `MD_PATH` the inputs are read from
    disk, without it they are downloaded through the API (`getFile`).
- **Outputs**, by what the service answers:
  - `response.type = "disk"`, `response.files[]`: already in `data/<db>/tmp`, reported by name.
  - `response.uri` (string or list, items with optional `label`, `type`, `thumb_name`,
    `page_number`): downloaded **straight into `data/<db>/tmp`** (temporary name, then rename) and
    reported by name. Labels follow the old rules (`label` gets the extension appended, an
    unlabelled single output is named `<input label>.<ext>`, otherwise the file name is kept); the
    type is the item's `type`, else guessed from the URL (`x.ocr.json` -> `ocr.json`).
  - nothing: `/api/nomad/process/files/done` with `metadata` merged into the file.
- Every output goes to `/api/nomad/process/files/tmp`; files are uploaded to the backend
  (`/api/nomad/process/files`) only when `MD_PATH` is not set (warned once).
- Errors are rethrown (the backend retries the job) unless some outputs were already reported;
  then an error node is recorded instead, so a retry cannot duplicate outputs.
- Needs `MD_PATH` (the MessyDesk root that contains `data/`, or `data/` itself) for the write
  policy.

**Verified from:** `src/adapters/elg.mjs`

### solr

- Full-text search indexer for Apache Solr
- **Reads files from disk** (not HTTP download) — requires `MD_PATH` for path resolution
- Path traversal protection: rejects absolute paths and paths outside `MD_ROOT`
- Two tasks: `index` (add document) and `delete` (remove by query)
- Index document fields: id (composite `fileRid:processRid`), label, owner, node, process, project, set, type, description, fulltext
- Emits summary on last file of batch
- `output_file` flag controls whether synthetic output is generated

**Verified from:** `src/adapters/solr.mjs`

### paddleocr

- Sends image to PaddleOCR service at `/predict_image`
- Converts absolute pixel coordinates to **relative coordinates** (0-1 range) using image dimensions
- Uses `probe-image-size` to read dimensions from file header without loading full image
- Output: `ocr.json` with array of `{coordinates, text, confidence}`

**Verified from:** `src/adapters/paddleocr.mjs`

### poppler

- PDF processing (page extraction, thumbnails, image extraction)
- Disk mode for thumbnails: sends JSON body, service writes directly
- HTTP mode: sends file as multipart, gets back file list
- Task `pdfimages` produces multiple files per page (labeled `page_N_image_M`)
- Removes `page` param before sending (would confuse poppler)

**Verified from:** `src/adapters/poppler.mjs`

### dspace7

- Integrates with DSpace 7 repository API
- `init` task: fetches metadata fields (Dublin Core only) and community/collection hierarchy
- Export tasks send files to DSpace with metadata mapping

**Verified from:** `src/adapters/dspace7.mjs`

### libretranslate

- Calls a self-hosted [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) instance's HTTP API directly (`POST /translate`, `POST /detect`) — bespoke adapter, not the `elg` protocol
- Tasks: `translate` (plain text, `format: "text"`), `translate_html` (`format: "html"`, preserves tags), `detect_language` (`POST /detect`, returns JSON with language + confidence)
- `source` defaults to `auto` (LibreTranslate's own language auto-detection); no API key needed for self-hosted instances
- Enforces a hard input-size cap (default 2MB, `LIBRETRANSLATE_MAX_INPUT_SIZE` env var) since LibreTranslate itself has none
- Descriptor lives in the separate `MD-LibreTranslate` repo (no Python service to serve `/config`), loaded via `SERVICE_JSON_PATH`
- Exports `enrichDescriptor()` (see [descriptor-resolution.md](descriptor-resolution.md#adapter-descriptor-enrichment)): fetches `GET /languages` on registration/heartbeat and replaces `service.json`'s static language list with the instance's actual installed language pairs

**Verified from:** `src/adapters/libretranslate.mjs`

### json-tagger

- Post-processing adapter: reads NER JSON output, creates entity links in MessyDesk
- Does not call an external service — POSTs to MessyDesk's entity API directly
- Entities get type (prefixed with service id), label, color, and icon

**Verified from:** `src/adapters/json-tagger.mjs`

### test

- Development/debugging adapter
- `test` task: waits for configurable delay, returns random text
- `json` task: returns random JSON object

**Verified from:** `src/adapters/test.mjs`

# Adapters Reference

## Summary Table

| Adapter | File | Service type | Input types | Output |
|---|---|---|---|---|
| `sharp-thumbnailer` | `sharp-thumbnailer.mjs` | Thumbnail generation | image | JPEG thumbnails |
| `imaginary` | `imaginary.mjs` | Image manipulation | image | image file |
| `gemini-ai` | `gemini-ai.mjs` | Google Gemini LLM | image, text | text + metadata JSON |
| `azure-ai` | `azure-ai.mjs` | Azure OpenAI | image, text | text + metadata JSON |
| `ollama` | `ollama.mjs` | Self-hosted LLM (Ollama) | image, text | text/JSON + metadata |
| `elg` | `elg.mjs` | Generic HTTP service (file upload) | any | files from service store |
| `elg_fs` | `elg_fs.mjs` | Generic HTTP service (disk mode) | any | tmp file references |
| `solr` | `solr.mjs` | Solr search indexing | text (disk path) | done signal |
| `paddleocr` | `paddleocr.mjs` | PaddleOCR | image | OCR JSON |
| `poppler` | `poppler.mjs` | PDF processing | PDF | images/files |
| `dspace7` | `dspace7.mjs` | DSpace 7 repository | text | text export |
| `annif` | `annif.mjs` | Annif subject indexing | text | JSON suggestions |
| `json-tagger` | `json-tagger.mjs` | Entity tagging | JSON (NER output) | entities linked via API |
| `test` | `test.mjs` | Test/debug | any | delayed text/JSON |

## Adapter Details

### sharp-thumbnailer

- In-process thumbnail generation using [sharp](https://sharp.pixelplumbing.com/) (libvips)
- No external service needed — `service_url` parameter is accepted but ignored
- **Direct file access:** reads from `path.join(MD_PATH, msg.file.path)` when `MD_PATH` is set; falls back to HTTP download via `getFile()`
- **Dual output:** generates 800px preview (from `msg.task.params.width`) then 200px `thumbnail.jpg`
- EXIF auto-orientation via `sharp().rotate()`
- SVG rasterization at 150 DPI density
- Large TIFF support: `limitInputPixels: false`, `sequentialRead: true`
- Cleans up temp files after successful upload
- Supported formats: PNG, JPEG, TIFF, SVG, WebP (not PDF — use `poppler` for that)

**Verified from:** `src/adapters/sharp-thumbnailer.mjs`

### imaginary

- Proxies to [Imaginary](https://github.com/h2non/imaginary) (image processing server)
- Downloads file from MD, sends as multipart to `service_url/<task_id>?<params>`
- Special handling: `OSD_rotate` task reads orientation from a JSON file, then delegates to `rotate`
- Used for image manipulation tasks (resize, rotate, crop, etc.) — no longer used for thumbnailing

**Verified from:** `src/adapters/imaginary.mjs`

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

### elg (European Language Grid pattern)

- Generic adapter for services following a common HTTP multipart protocol
- Sends file + message JSON to `service_url/process`
- Downloads result files from the service's output store
- Supports batch input via ZIP (`getFilesZip` when `input_set` present)
- Can forward source file if `msg.file.source` exists

**Verified from:** `src/adapters/elg.mjs`

### elg_fs (Filesystem variant)

- Similar to `elg` but does **not** download/upload files through consumer
- Sends only the message JSON (no file content) to `service_url/process`
- Service writes output to shared filesystem; consumer sends tmp-path references to MD
- **Batch safety:** Checks batch status via `GET /api/batches/:rid` before each file callback
- Respects `cancelled`, `cancelling`, `paused`, `done` states
- Falls back to `/api/nomad/process/files/done` if service returns no files

**Verified from:** `src/adapters/elg_fs.mjs`

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
- Uses `cld` library for language detection

**Verified from:** `src/adapters/dspace7.mjs`

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

# Adapters Reference

## Summary Table

| Adapter | File | Service type | Input types | Output |
|---|---|---|---|---|
| `llm-openai` | `llm-openai.mjs` + `llm/core.mjs` | Any OpenAI-compatible LLM: OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, LiteLLM | image, text | text/JSON or autotag JSON + metadata JSON |
| `llm-gemini` | `llm-gemini.mjs` + `llm/core.mjs` | Google Gemini (native API) | image, text | text/JSON or autotag JSON + metadata JSON |
| `roihu` | `roihu.mjs` + `hpc/firecrest.mjs`, `hpc/s3.mjs` | A model run as a Slurm job on CSC's Roihu supercomputer (FirecREST + Allas) | image | text and PAGE XML per page |
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

### llm-openai and llm-gemini (LLM providers)

Replaced the old `ollama`, `azure-ai` and `gemini-ai` adapters (MessyDesk `plan/llm-adapter.md`).
Both run on `llm/core.mjs`, which does everything provider-neutral; the two files only build the
provider request and read its answer.

- Started with `CONFIG_JSON_PATH` (see [environment-variables.md](environment-variables.md)): the
  file's `service` block is registered, its `provider` block (URL, key env var name, model map,
  retries) goes to the adapter's `configure()`, and its `help` markdown is sent to MessyDesk.
- Prompt runs: the prompt text (`task.params.prompts.content`) is the system message, the file is
  the user message (text, or the image as a data URL / inline data). `output_type: json` asks for
  structured output with the prompt's `json_schema`, which may be a JSON Schema or an example
  object (converted). The answer must parse as JSON, otherwise the job fails with the start of it.
- `autotag` task: chooses tags from the given labels or existing tags (closed mode, enum-constrained
  structured output) or suggests up to `max_tags` tags (open mode). Output
  `{task, params, model, result: {category: [...]}}`, which MessyDesk turns into tags.
- Input: no silent cutting. A text over the model's `max_input_tokens` (about 4 characters per
  token) fails with a clear message. Images are converted to JPEG/PNG and scaled to the model's
  `max_image_edge` (default 2048).
- Params: `temperature` (left out for models with `"temperature": false`), `max_output_tokens`
  (MessyDesk caps it with the service group's `per_job_max_output`).
- Retries 429, 408, 409, 5xx and network errors in the adapter, honouring `Retry-After`; if they
  keep failing the job is thrown back to the queue. 4xx answers and our own errors fail at once.
- Output label `<original name>.txt` / `.json`; `response.json` to `/metadata` with model,
  provider, tokens in/out/total, finish reason and retries (stored as a Usage row).
- One job at a time per consumer. Run several consumers on the same `TOPIC` for parallel calls.
- `llm-gemini` sends images inline (nothing is left in Google's file store).

**Verified from:** `src/adapters/llm/core.mjs`, `src/adapters/llm-openai.mjs`,
`src/adapters/llm-gemini.mjs`, `tests/llm.test.mjs`.

### roihu (Slurm jobs on CSC's Roihu supercomputer)

Runs a model as a batch job on a supercomputer. The first pipeline is `nafrec` (historical
handwriting/print recognition); the service lives in the MD-roihu-slurm repository, which plays the
part a service repository normally does (config, job script, help), as MD-llm does for the LLMs.

- Started with `CONFIG_JSON_PATH=../MD-roihu-slurm/services/htr-nafrec.json`. Two modes, by the descriptor's
  `api_key_source`: **user** (default in the config): every run brings its own FirecREST token and CSC project (and an
  Allas project when different), typed in the UI form (`service.credentials` defines it), kept by the backend's
  vault and fetched with the task's `secret_ref`. The Allas keys are not asked: they are read from the user's own
  `~/.config/rclone/rclone.conf` on Roihu through FirecREST (the user ran `allas-conf` there once), and the job uses
  that same config and gets no copy. **service** (`API_KEY_MODE=service`, local use): one
  account from `.env` (see [environment-variables.md](environment-variables.md)). In user mode nothing is
  configured in the environment and nothing of the credentials is written to disk or a log.
- The environment and models are installed in the project's own `/scratch/{project}/...` on the first run (a
  setup job, once per directory). `npm run roihu -- check|setup <config>` does the same by hand in service mode.
- **Batching.** It holds many queue jobs at once (`maxConcurrentJobs()`, default 600) and groups the
  jobs of one process (`set_process`). A group is flushed when the batch is complete
  (`total_files` seen), when it reaches `batching.max_pages` (300), or when no new job has arrived
  for `gather_seconds` (8). Every group is one Slurm job: a model needs one to three minutes to start,
  so one process per page would be useless.
- **Data.** The images go to Allas (S3, bucket `project-<n>-md-roihu`) under `<topic>/<run>/in/p0001.png`;
  the job on Roihu pulls them, and pushes every finished page to `<run>/out/...`; `out/status.json`
  is written last. The consumer polls Allas (`poll_seconds`, 15) and downloads each page when all
  `required` outputs exist, then reports it with the same `/files/tmp` callback as `elg`. Allas is
  emptied when the job is over (`keep_data` keeps it).
- **Outputs** come from `provider.pipeline.outputs`: `{ path, label, extension, type, on_empty? }`.
  A page the model found no text on (status `empty`) gets the outputs that have `on_empty`
  (an empty text file), a failed page is rejected so that the queue retries it.
- **Failures.** A Slurm job that ends without `status.json` rejects its pages with the Slurm state,
  reason and the last lines of its log. An expired FirecREST token does not fail anything: the
  pages stay claimed until a new token is in place (read again from `FIRECREST_TOKEN_FILE` on every
  call); results already in Allas are still collected without it.
- **Cancel.** index.mjs calls `jobLost(jobId)` when a job heartbeat gets 404 (the batch was
  cancelled); when every page of a run is gone the Slurm job is cancelled with `scancel`.
- **Restart.** Each run is kept in `data/roihu-state.json` (`ROIHU_STATE_PATH`): file -> Slurm job.
  A job claimed again after a restart joins the existing Slurm job (if it still runs or
  completed) instead of starting another.
- The consumer must run where it can read `MD_PATH` (it reads input images from the data
  directory and writes results to `data/<db>/tmp`).
- Generic on purpose: the model is whatever `pipeline.script` does. Another model is another config
  file and job script, not another adapter.

**Verified from:** `src/adapters/roihu.mjs`, `src/hpc/*.mjs`, `tests/roihu.test.mjs`,
`tests/main-loop.test.mjs`; design in MessyDesk `wiki/proposals/Roihu-slurm.md`.

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
  - `response.files[]` entry with `ref_file_rid` (plus `label`, `extension`, `type`): no file at all;
    the backend creates a reference node sharing the bytes of that existing file (e.g. md-sharp
    `OSD_rotate` when no rotation is needed).
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

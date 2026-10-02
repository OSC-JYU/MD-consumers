# Adapter Contract

## Interface

Every adapter must export a single async function:

```js
export async function process_msg(service_url, message) { ... }
```

| Parameter | Type | Description |
|---|---|---|
| `service_url` | `string` | Base URL of the external service (may lack `http://` prefix) |
| `message` | `object` | Message object with `.json()` method returning the payload |

**Verified from:** All files in `src/adapters/` export this exact signature.

## Responsibilities

An adapter must:

1. **Parse the message** — call `message.json()` to get the payload object.
2. **Download source file(s)** — use `getFile(MD_URL, rid, userId)` from `funcs.mjs`.
3. **Call the external service** — translate task params to the service's API.
4. **Return results** — upload output file(s) back to MessyDesk using one of:
   - `sendFile()` / `getFilesFromStore()` — binary files via multipart POST
   - `sendTextFile()` / `sendStringTextFile()` — text content
   - `sendJSONFile()` — JSON content
   - Direct POST to `/api/nomad/process/files/done` — metadata-only completion
   - Direct POST to `/api/nomad/process/files/tmp` — disk-mode file references
5. **Report errors** — call `sendError(msg, error, MD_URL)` on failure.

**Verified from:** `src/funcs.mjs` exports, consistent usage across all adapters.

## Message Acknowledgment

Adapters do **not** handle message acknowledgment. The main loop (`index.mjs`) calls `queueClient.complete(job.id)` after `process_msg` resolves, or `queueClient.fail(job.id, error)` on failure. Failed jobs are retried by the backend queue (up to 3 attempts with exponential backoff).

**Verified from:** `src/index.mjs` main processing loop.

## Service URL Normalization

Adapters must handle `service_url` that may not include the `http://` scheme. The common pattern is:

```js
if(!service_url.startsWith('http')) service_url = 'http://' + service_url
```

**Verified from:** Every adapter performs this check manually.

## Timing Convention

Adapters should measure execution time and attach it to the message:

```js
const start = process.hrtime()
// ... work ...
const end = process.hrtime(start)
msg.response = { time: parseFloat((end[0] + end[1] / 1e9).toFixed(3)) }
```

Or use the helper: `withResponseTime(msg, startedAt)` from `funcs.mjs`.

**Verified from:** All adapters track time; newer ones use `withResponseTime`.

## Output Patterns

| Pattern | Used by | Description |
|---|---|---|
| Output written to data/<db>/tmp + `/tmp` callback | `elg`/`elg_fs` | Downloaded from the service (or written there by it), reported by name |
| File upload via multipart | `paddleocr` | Binary file streamed back |
| Text file via content string | `gemini-ai`, `azure-ai`, `ollama`, `test` | Content sent as string, not file stream |
| JSON metadata to `/metadata` endpoint | `gemini-ai`, `azure-ai`, `ollama` | AI response metadata (tokens, model) |
| Done signal without output | `solr`, `json-tagger` | Processing produces no output files |
| Dual file output | AI adapters | Both `result.txt` and `response.json` emitted |

## Error Handling Invariant

- If `message.json()` throws (invalid payload), the adapter calls `sendError` and returns.
- Most adapters catch their own errors, call `sendError` (one error node in the UI) and return, so the job
  is completed and not retried.
- `elg` and `test` rethrow instead: the consumer loop reports `/fail`, the backend retries the job, and after
  the last attempt the loop calls `sendError` once.
- `sendError(msg, error, url)` accepts `MD_URL` or the callback URL, sends `{error: {message, code, status,
  details}, message}` and never throws.

**Verified from:** `src/funcs.mjs` `sendError()`, `src/index.mjs` main loop.

# Non-obvious Behavior

## 1. Failed Jobs Are Retried by the Backend

When `process_msg` throws, the consumer reports the failure via `POST /api/queue/{job_id}/fail`. The backend queue retries the job up to 3 times with exponential backoff (500ms × 2^(attempts-1), capped at 30s). After max attempts, the job is marked `failed`.

**Verified from:** `src/index.mjs` main loop, backend `src/queue.mjs`.

## 2. Descriptor Re-resolution on Every Heartbeat

The service descriptor is re-fetched every 30 seconds during heartbeat. This means:
- Runtime config changes take effect within 30s
- If `SERVICE_JSON_PATH` is set, explicit descriptor metadata continues to be used
- If `SERVICE_JSON_PATH` is not set and `/config` becomes unavailable, heartbeat logs an error and skips that registration cycle
- The descriptor in memory (`service_json`) is **mutated** — later messages see the updated descriptor

**Verified from:** `src/index.mjs` heartbeat setInterval block.

## 3. `service_url` Is Not Used by AI Adapters

For `gemini-ai`, the `service_url` parameter is essentially ignored — the adapter uses the Google SDK directly. The value still determines startup logic (service discovery, Nomad). For `azure-ai`, `service_url` is used as the Azure endpoint. This inconsistency means Gemini doesn't need a running "service" but the bootstrap still requires one to be discoverable.

**Verified from:** `src/adapters/gemini-ai.mjs` (uses `@google/genai` SDK, not `service_url`).

**Inferred:** Setting `DEV_URL=http://dummy` may be needed for Gemini to bypass service discovery.

## 4. Double JSON Parse in Some Adapters

In `gemini-ai.mjs`:
```js
payload = message.json()  // returns object
msg = JSON.parse(payload) // parses it AGAIN as string
```

This suggests the NATS message `.json()` method may return a string in some code paths, or this is a legacy artifact. Other adapters call only `message.json()` and use the result directly.

**Verified from:** `src/adapters/gemini-ai.mjs` vs other adapters.

## 5. File Type Inference from Extension

`downloadFile()` in `funcs.mjs` infers the file type from extension with a small fixed list. JSON files get special "double extension" handling: `data.human.json` → type `human.json`.

This type field is then stored in MessyDesk's database and used for display routing.

**Verified from:** `src/funcs.mjs` `downloadFile()`, `extractDoubleExtension()`.

## 6. Solr Adapter Reads Files from Disk

Unlike all other adapters that download files via HTTP (`getFile()`), the Solr adapter reads directly from the filesystem using `MD_PATH`. It has **path traversal protection** that rejects absolute paths and paths resolving outside the MD root.

**Verified from:** `src/adapters/solr.mjs` `resolveMdRelativePath()`.

## 7. OSD_rotate Is a Two-Service Composite

The `imaginary` adapter's `OSD_rotate` task:
1. Downloads an OSD JSON file (orientation detection result)
2. Reads the orientation angle from it
3. Redirects to the actual source image
4. Applies rotation

This means `OSD_rotate` operates on a **derived file** (the JSON), not the image itself. The `supported_types: ["osd.json"]` in the descriptor enforces this.

**Verified from:** `src/adapters/imaginary.mjs` OSD_rotate block.

## 8. Thumbnail Jobs Produce Two Outputs

When `imaginary` detects a thumbnail job (via `isThumbnailJob()`), it:
1. Produces the requested resize
2. Produces an additional 200px-wide thumbnail with `thumb_name: 'thumbnail.jpg'`

Both are sent to MessyDesk as separate file uploads.

**Verified from:** `src/adapters/imaginary.mjs` thumbnail block.

## 9. Batch Cancellation Only in elg_fs

Only the `elg_fs` adapter checks batch status (`GET /api/batches/:rid`) before processing each file. Other adapters process all messages regardless of batch state. This means a cancelled batch will still have in-flight messages processed by non-fs adapters.

**Verified from:** `src/adapters/elg_fs.mjs` `shouldContinueBatch()`.

## 10. Consumer Deregistration Requires Clean Shutdown

If the process crashes without SIGINT, the adapter remains registered in MessyDesk until either:
- The next heartbeat from another instance for the same topic
- Manual cleanup

There is no TTL-based expiry in the registration protocol itself.

**Inferred:** From the SIGINT handler being the only deregistration path. TTL behavior depends on MessyDesk backend implementation (not in this repo).

## 11. `max_messages: 1` Sequential Processing

The NATS consume call uses `{ max_messages: 1 }` in `index.mjs`, but the `for await` loop processes messages sequentially as they arrive. This effectively means one message at a time per consumer — **no parallelism within a single consumer instance**.

**Verified from:** `src/index.mjs` `const messages = await co.consume({ max_messages: 1 })`.

## 12. index-multi.mjs Does Not Await Consumer Loops

In multi-topic mode, `processConsumer` is called without `await` — it runs in the background:
```js
processConsumer(...).catch(...)  // fire-and-forget
```

This means errors in the consumer loop only log, they don't crash the process.

**Verified from:** `src/index-multi.mjs` comment "Don't await - let it run in the background".

## 13. No Output File Label Deduplication

When processing multiple files, labels are constructed from various sources (service response, file_labels array, original filename). There is no uniqueness check — duplicate labels may be sent to MessyDesk.

**Verified from:** `src/funcs.mjs` `getFilesFromStore()` label assignment logic.

## 14. Hardcoded Solr Core

The Solr core name is hardcoded to `messydesk`:
```js
var url = `${service_url}/solr/messydesk/update?commit=true`
```

The `SOLR_CORE` env var exists as a comment but is not wired up.

**Verified from:** `src/adapters/solr.mjs`.

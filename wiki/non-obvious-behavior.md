# Non-obvious Behavior

## 1. Failed Jobs Are Retried by the Backend

When `process_msg` throws, the consumer reports the failure via `POST /api/queue/{job_id}/fail`. The backend queue retries the job up to 3 times with exponential backoff (500ms × 2^(attempts-1), capped at 30s). After max attempts, the job is marked `failed` (`permanent: true` in the answer) and the consumer sends the error with `sendError` so the user sees an error node. Adapters that catch their own errors are not retried (see adapter-contract.md).

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

## 4. `message.json()` Is a Shim

The queue loop wraps the job payload as `{ json: () => job.payload }` (a leftover of the NATS API), so
`message.json()` returns the payload object. (gemini-ai used to `JSON.parse` it again, which always failed.)

**Verified from:** `src/index.mjs` main loop.

## 5. File Type Inference from Extension

`downloadFile()` in `funcs.mjs` infers the file type from extension with a small fixed list. JSON files get special "double extension" handling: `data.human.json` → type `human.json`.

This type field is then stored in MessyDesk's database and used for display routing.

**Verified from:** `src/funcs.mjs` `downloadFile()`, `extractDoubleExtension()`.

## 6. Solr Adapter Reads Files from Disk

Unlike all other adapters that download files via HTTP (`getFile()`), the Solr adapter reads directly from the filesystem using `MD_PATH`. It has **path traversal protection** that rejects absolute paths and paths resolving outside the MD root.

**Verified from:** `src/adapters/solr.mjs` `resolveMdRelativePath()`.

## 7. Batch Cancellation Only in elg_fs

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

## 14. Solr Core

The Solr core name comes from `SOLR_CORE` (default `messydesk`).

**Verified from:** `src/adapters/solr.mjs`.

## 15. Downstream Services Own Their Own Upload/Output Cleanup — Consumers Don't

`elg`/`elg_fs` adapters never delete files on the *service* side — a service's `uploads/`/`data/` (or equivalent) directories are its own responsibility, not something MD-consumers or MessyDesk core clean up remotely. Two failure modes this causes if a service doesn't handle it:
- Raw upload files (message JSON + content) survive if a request errors before the service's own unlink runs, or the process crashes mid-request.
- Output files served lazily (e.g. deleted only when the adapter's `GET /files/{dir}/{file}` request downloads them) survive forever if a job fails downstream (batch cancelled, MessyDesk never fetches the result, etc.) since nothing ever triggers that GET.

**Convention (introduced in `MD-tesseract`, `lib/cleanup.mjs`):** each standalone service should run its own **clean sweep** — a startup sweep (once, before the HTTP server starts accepting requests) plus a timed sweep (`setInterval`, e.g. hourly) that deletes anything in its upload/output directories older than a max-age threshold (mtime-based, e.g. 24h default). This is service-local file hygiene; it has no protocol-level relationship to MD-consumers or the queue.

**Verified from:** `MD-tesseract/lib/cleanup.mjs`, `MD-tesseract/index.mjs`.

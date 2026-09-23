# Proposal: Consumer Adapter Overhaul for SQLite Queue

**Status**: Draft  
**Date**: 2026-08-13  
**Related**: [Backend queue proposal](../../MessyDesk/wiki/proposals/sqlite-queue-batch-simplification.md), [UI batch progress proposal](../../MessyDesk-UI/proposals/batch-progress-ui.md)

## Summary

Replace NATS consumption with HTTP-based queue polling against the backend. Add batch-aware processing loop with pause/resume/cancel support via a control HTTP server.

## Current Architecture (Being Replaced)

- `src/index.mjs` — NATS JetStream consumer, processes one message at a time
- `src/index-db.mjs` — SQLite direct-access alternative (being removed; SQLite moves to backend)
- `src/index-multi.mjs` — Multi-topic NATS variant
- `src/server.mjs` — Lightweight Hapi server with `/start` endpoint
- `src/funcs.mjs` — Shared utilities (file fetch, response callbacks, registration)
- `src/adapters/*.mjs` — Per-service adapters (unchanged in interface)

## New Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Consumer Process (one per service topic)                │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌────────────┐  │
│  │ Queue Poller │    │ Batch Runner│    │ Control    │  │
│  │ (claim loop)│───▶│ (file iter) │◀───│ Server     │  │
│  └─────────────┘    └──────┬──────┘    │ (HTTP)     │  │
│                            │           └────────────┘  │
│                            ▼                            │
│                    ┌───────────────┐                    │
│                    │ Adapter       │                    │
│                    │ (per-service) │                    │
│                    └───────┬───────┘                    │
│                            │                            │
└────────────────────────────┼────────────────────────────┘
                             │ HTTP
                             ▼
                     External Service
```

### Components

| Component | Responsibility |
|-----------|---------------|
| **Queue Poller** | Polls `POST /api/queue/claim`, manages heartbeat, reports completion/failure |
| **Batch Runner** | Iterates files in a batch job, respects pause/cancel flags, reports per-file progress |
| **Control Server** | Receives pause/resume/cancel signals from backend |
| **Adapter** | Unchanged — translates single file into service API call, returns result |

## File Changes

| File | Action | Notes |
|------|--------|-------|
| `src/index.mjs` | **Rewrite** | Replace NATS with queue poller + batch runner |
| `src/index-db.mjs` | **Delete** | SQLite is backend-only now |
| `src/index-cold.mjs` | **Delete** | Legacy NATS variant |
| `src/index-multi.mjs` | **Delete** | Multi-topic NATS variant; single-topic is sufficient |
| `src/server.mjs` | **Extend** | Add control endpoints (`/jobs/{id}/pause`, `/resume`, `/cancel`) |
| `src/queueClient.mjs` | **New** | HTTP client for backend queue API |
| `src/batchRunner.mjs` | **New** | Batch iteration logic with pause/cancel awareness |
| `src/funcs.mjs` | **Modify** | Remove NATS-specific code, keep file fetch/callback utilities |
| `src/adapters/*.mjs` | **No change** | Adapter interface unchanged |
| `package.json` | **Modify** | Remove `@nats-io/*` dependencies |

## Detailed Design

### Queue Client (`src/queueClient.mjs`)

HTTP wrapper for backend queue API:

```javascript
// src/queueClient.mjs
import got from 'got'

export function createQueueClient({ mdUrl, topic, adapterId, user }) {

    async function claim() {
        const res = await got.post(`${mdUrl}/api/queue/claim`, {
            json: { topic, adapter_id: adapterId },
            headers: { mail: user }
        }).json()
        return res.job || null  // null = no work available
    }

    async function heartbeat(jobId) {
        await got.post(`${mdUrl}/api/queue/${jobId}/heartbeat`, {
            headers: { mail: user }
        })
    }

    async function complete(jobId) {
        await got.post(`${mdUrl}/api/queue/${jobId}/complete`, {
            headers: { mail: user }
        })
    }

    async function fail(jobId, error) {
        await got.post(`${mdUrl}/api/queue/${jobId}/fail`, {
            json: { error: error.message || String(error) },
            headers: { mail: user }
        })
    }

    return { claim, heartbeat, complete, fail }
}
```

### Batch Runner (`src/batchRunner.mjs`)

Core batch processing logic:

```javascript
// src/batchRunner.mjs

export function createBatchRunner({ queueClient, processMsg, serviceUrl, mdUrl, user }) {
    // Control flags (mutated by control server)
    let paused = false
    let cancelled = false
    let currentJobId = null

    async function runJob(job) {
        currentJobId = job.id

        if (job.type === 'batch') {
            await runBatch(job)
        } else {
            await runSingle(job)
        }
    }

    async function runBatch(job) {
        const { files, total_files, set_process, task, service } = job.payload
        const startIndex = job.payload.resume_from_index || 0
        let processed = startIndex
        let failed = 0

        for (let i = startIndex; i < files.length; i++) {
            // --- Check pause ---
            if (paused) {
                // Report progress, then wait
                await reportProgress(job, { processed, failed, total_files, status: 'paused' })
                await waitUntilResumedOrCancelled()
                if (cancelled) break
            }

            // --- Check cancel ---
            if (cancelled) break

            // --- Process one file ---
            try {
                const fileMsg = await buildFileMessage(job.payload, files[i], i)
                await processMsg(serviceUrl, fileMsg)
                processed++
            } catch (err) {
                failed++
                await reportFileError(job, files[i], err)
            }

            // --- Report progress ---
            await reportProgress(job, { processed, failed, total_files, current_index: i + 1 })
        }

        if (cancelled) {
            await queueClient.complete(job.id)  // job is done (partially)
        } else {
            await queueClient.complete(job.id)
        }
    }

    async function runSingle(job) {
        const msg = { json: () => job.payload }
        await processMsg(serviceUrl, msg)
        await queueClient.complete(job.id)
    }

    // --- Control signals (called by control server) ---
    function setPaused(jobId) {
        if (jobId === currentJobId) paused = true
    }

    function setResumed(jobId) {
        if (jobId === currentJobId) paused = false
    }

    function setCancelled(jobId) {
        if (jobId === currentJobId) {
            cancelled = true
            paused = false  // unblock wait loop
        }
    }

    function reset() {
        paused = false
        cancelled = false
        currentJobId = null
    }

    return { runJob, setPaused, setResumed, setCancelled, reset }
}
```

### Main Entry Point (`src/index.mjs` rewrite)

```javascript
// src/index.mjs (new)
import { createQueueClient } from './queueClient.mjs'
import { createBatchRunner } from './batchRunner.mjs'
import { startControlServer } from './server.mjs'
import { resolveDescriptorSourceChain, registerServiceDescriptor } from './funcs.mjs'

const TOPIC = process.env.TOPIC
const MD_URL = process.env.MD_URL || 'http://localhost:8200'
const ADAPTER = process.env.ADAPTER
const CONTROL_PORT = process.env.CONTROL_PORT || 9100

// 1. Resolve service descriptor and URL
const { descriptor, serviceUrl } = await resolveAndRegister()

// 2. Load adapter
const { process_msg } = await import(`./adapters/${descriptor.adapter}.mjs`)

// 3. Create queue client
const queueClient = createQueueClient({
    mdUrl: MD_URL,
    topic: TOPIC,
    adapterId: crypto.randomUUID(),
    user: 'local.user@localhost'
})

// 4. Create batch runner
const batchRunner = createBatchRunner({
    queueClient,
    processMsg: process_msg,
    serviceUrl,
    mdUrl: MD_URL,
    user: 'local.user@localhost'
})

// 5. Start control server
const controlUrl = await startControlServer(CONTROL_PORT, batchRunner)

// 6. Register adapter with control URL
await registerAdapter(controlUrl)

// 7. Main loop
let backoff = 100
const MAX_BACKOFF = 2000

while (true) {
    const job = await queueClient.claim()

    if (!job) {
        await sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF)
        continue
    }

    backoff = 100  // reset on work found
    batchRunner.reset()

    // Start heartbeat
    const heartbeatInterval = setInterval(
        () => queueClient.heartbeat(job.id),
        40_000  // every 40s (lease is 120s)
    )

    try {
        await batchRunner.runJob(job)
    } catch (err) {
        await queueClient.fail(job.id, err)
    } finally {
        clearInterval(heartbeatInterval)
    }
}
```

### Control Server (`src/server.mjs` extension)

```javascript
// Added routes in server.mjs

server.route({
    method: 'POST',
    path: '/jobs/{job_id}/pause',
    handler: (request) => {
        batchRunner.setPaused(request.params.job_id)
        return { ok: true }
    }
})

server.route({
    method: 'POST',
    path: '/jobs/{job_id}/resume',
    handler: (request) => {
        batchRunner.setResumed(request.params.job_id)
        return { ok: true }
    }
})

server.route({
    method: 'POST',
    path: '/jobs/{job_id}/cancel',
    handler: (request) => {
        batchRunner.setCancelled(request.params.job_id)
        return { ok: true }
    }
})
```

### Registration (adapter heartbeat with control URL)

The consumer registers its control URL so the backend knows where to send signals:

```javascript
// During registration / heartbeat (every 30s):
POST /api/services/{TOPIC}/adapter/{adapter_id}
Body: { control_url: "http://consumer-host:9100" }
```

Backend stores `control_url` alongside adapter entry. When pause/resume/cancel is requested, backend looks up the consumer handling the job and sends the signal to its `control_url`.

## Adapter Interface (Unchanged)

Adapters still export a single function:

```javascript
export async function process_msg(service_url, message) {
    const msg = message.json()
    // ... call service, send result callback ...
}
```

For batch processing, the batch runner wraps each file into the same message format the adapter already expects. The adapter is **unaware** it's part of a batch.

### Message Wrapping for Batch Files

The batch runner constructs per-file messages that look identical to current single-file messages:

```javascript
async function buildFileMessage(batchPayload, fileRid, index) {
    // Fetch file metadata from backend
    const fileData = await getFileMetadata(mdUrl, fileRid, user)

    const msg = {
        service: batchPayload.service,
        task: batchPayload.task,
        file: fileData,
        process: { '@rid': batchPayload.set_process },
        output_set: batchPayload.output_set,
        project_rid: batchPayload.project_rid,
        userId: batchPayload.userId,
        total_files: batchPayload.total_files,
        current_file: index + 1
    }

    return { json: () => msg }
}
```

## Pause/Resume Behavior in Detail

### Pause sequence (consumer perspective)

```
Backend POSTs /jobs/{job_id}/pause
    ↓
batchRunner.setPaused(jobId) → paused = true
    ↓
Batch loop checks `paused` before next file
    ↓
If currently mid-file: finish that file, THEN stop
If between files: stop immediately
    ↓
Consumer enters wait loop (still heartbeating)
```

### Resume sequence

```
Backend POSTs /jobs/{job_id}/resume
    ↓
batchRunner.setResumed(jobId) → paused = false
    ↓
Wait loop exits
    ↓
Batch loop continues from next file index
```

### Cancel sequence

```
Backend POSTs /jobs/{job_id}/cancel
    ↓
batchRunner.setCancelled(jobId) → cancelled = true, paused = false
    ↓
If waiting (paused): unblocks wait loop, exits batch loop
If processing: finishes current file, then exits
    ↓
Reports partial completion via queueClient.complete()
```

### Crash recovery

If consumer crashes while holding a paused job:
- Heartbeat stops → lease expires (120s)
- Backend detects expired lease → marks job as `failed` (or `queued` for retry)
- If the paused job had a deleted SetProcess: backend already cleaned up the queue row during deletion

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `TOPIC` | — | **Required** — service topic |
| `MD_URL` | `http://localhost:8200` | Backend API |
| `DEV_URL` | — | Override service URL |
| `CONTROL_PORT` | `9100` | Port for control HTTP server |
| `ADAPTER` | — | Override adapter name |
| `SERVICE_JSON_PATH` | — | Explicit descriptor path |
| `HELP_URL` | — | Help docs URL |

**Removed**: `NATS_URL`, `QUEUE_DB_*` variables (no longer relevant).

## Dependencies

### Remove
- `@nats-io/jetstream`
- `@nats-io/nats-core`
- `@nats-io/transport-node`
- `better-sqlite3` (if present — SQLite moves to backend)

### Keep
- `@hapi/hapi` — control server
- `got` — HTTP client for queue API, service calls, file fetch
- `form-data` — multipart uploads
- `fs-extra`, `uuid`, `zod` — utilities
- All AI SDKs (`openai`, `@azure/openai`, `@google/genai`) — adapter-specific

## Migration Checklist

1. Create `src/queueClient.mjs`
2. Create `src/batchRunner.mjs`
3. Extend `src/server.mjs` with control endpoints
4. Rewrite `src/index.mjs` (new main loop)
5. Delete `src/index-db.mjs`, `src/index-cold.mjs`, `src/index-multi.mjs`
6. Update `src/funcs.mjs` — remove NATS helpers, add `getFileMetadata()` helper
7. Update adapter registration to include `control_url`
8. Remove NATS dependencies from `package.json`
9. Update Dockerfile (simpler — no NATS env needed)
10. Update Makefile run commands

## Risks

- **Control server port conflicts**: Multiple consumers on same host need different `CONTROL_PORT`. Mitigated by making it configurable per topic.
- **Backend cannot reach consumer**: If consumer is behind NAT or firewall, pause/resume signals won't arrive. Fallback: consumer could poll job status periodically (low-priority fallback, not primary mechanism).
- **Adapter crash mid-file**: Current file result may be lost. On retry, that file is re-processed (possible duplicate output). Backend callback handler should deduplicate by (process_rid + file_rid) pair.

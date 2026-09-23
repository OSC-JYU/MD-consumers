# Lifecycle & Heartbeat

## Startup Sequence (index.mjs)

1. Create local `data/source/` directory
2. Generate unique `adapter_id` (UUID)
3. Resolve service descriptor via source chain
4. Determine service URL (Nomad discovery, `local_url`, or `DEV_URL`)
5. If service not found and `NOMAD_HCL_PATH` is set: start service via MessyDesk API
6. Register descriptor with MessyDesk (`POST /api/services/register`)
7. Trigger help ingestion (`POST /api/services/:topic/help/ingest`)
8. Start control server on `CONTROL_PORT` (default 9100)
9. Register adapter instance with control URL (`POST /api/services/:topic/adapter/:adapter_id`)
10. Dynamically import adapter module
11. Start heartbeat interval (30s)
12. Begin polling backend queue API (`POST /api/queue/claim`)

**Verified from:** `src/index.mjs` `main()` function.

## Heartbeat

Every **30 seconds**, the consumer:

1. Re-resolves the service descriptor (picks up config changes)
2. Re-registers the descriptor with MessyDesk
3. POSTs to `/api/services/:topic/adapter/:adapter_id` with `control_url` (keeps adapter alive)

If the heartbeat fails, the error is logged but the consumer continues processing.

**Verified from:** `src/index.mjs` heartbeat `setInterval(..., 30000)`

## Job Heartbeat

While processing a job, the consumer sends a heartbeat every **40 seconds** to extend the job lease:

- `POST /api/queue/{job_id}/heartbeat`

This prevents the backend from reclaiming the job while it's actively being processed.

**Verified from:** `src/index.mjs` `heartbeatTimer` in main loop.

## Shutdown (SIGINT)

On `SIGINT`/`SIGTERM`:

1. Set `stopped = true` (exits main loop)
2. Clear heartbeat interval
3. DELETE `/api/services/:topic/adapter/:adapter_id` (deregister)
4. If this consumer started the service via Nomad startup path, request service stop
5. DELETE `/api/services/:topic` (remove service registration)
6. `process.exit()`

**Verified from:** `src/index.mjs` `process.on('SIGINT', ...)`

**Verified from:** `src/index-cold.mjs` — `stopService` called when queue empty.

## Multi-topic Mode (index-multi.mjs)

- Starts a Hapi HTTP server (default port 8201)
- Services are started dynamically via `POST /start { topic: "..." }`
- Stopped via `POST /stop { topic: "..." }`
- Status available at `GET /status`, `GET /info`, `GET /health`
- All active consumers tracked in `Map<topic, consumerInfo>`

**Verified from:** `src/index-multi.mjs`, `src/server.mjs`

## SQLite Queue Mode (index-db.mjs)

- Uses `node:sqlite` `DatabaseSync` (sync API)
- WAL journal mode, busy timeout 5000ms
- Jobs claimed with `BEGIN IMMEDIATE` transactions (row-level locking)
- Lease-based ownership: jobs have `lease_until` timestamp, re-claimable after expiry
- Heartbeat extends lease every `LEASE_SECONDS/3` ms
- Exponential backoff on idle (100ms → 2000ms)
- Failed jobs retried up to `max_attempts` with increasing `next_retry_at`

**Verified from:** `src/index-db.mjs` — complete SQLite queue implementation.

## Invariants

- **One adapter per process** (in `index.mjs` and `index-db.mjs` modes)
- **Adapter ID is ephemeral** — new UUID generated each startup
- **Heartbeat carries fresh descriptor** — descriptor changes propagate within 30s
- **No graceful drain** — SIGINT immediately exits; in-flight messages are acked before processing completes only if the handler already returned

**Verified from:** Source code analysis of shutdown handlers and ack placement.

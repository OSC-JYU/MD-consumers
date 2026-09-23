# Architecture

## Overview

MD-consumers is the **message-driven adapter layer** between the MessyDesk core API and external processing services. Each consumer instance:

1. Polls the backend **HTTP queue API** (`POST /api/queue/claim`) for available jobs
2. Claims and processes messages for a specific topic
3. Translates the message into the external service's API
4. Returns results (files, metadata, errors) back to MessyDesk via HTTP

**Verified from source:** `src/index.mjs`, `src/queueClient.mjs`

## Entry Point

There is a single entry point: `src/index.mjs`. It uses HTTP-based queue polling against the backend's SQLite queue.

| Entry point | Transport | Concurrency model | Use case |
|---|---|---|---|
| `index.mjs` | HTTP queue API | Single-topic, always-on, polling | All deployments |

## Queue Interaction

```
MessyDesk Backend (SQLite queue)
  └── Queue topic: "<TOPIC>"
  └── Queue topic: "<TOPIC>_batch"
```

The consumer claims jobs from its topic via `POST /api/queue/claim`. The backend selects the next available job and returns it. If no job is available, the consumer backs off exponentially (100ms → 2000ms).

## Core Data Flow

```
MessyDesk API ──enqueue──▶ SQLite queue ──HTTP claim──▶ Consumer (this repo)
       ▲                                                      │
       │                                                      ▼
       │                                              External Service
       │                                                      │
       └────── POST /api/nomad/process/files ◀────────────────┘
                    (result files + message)
```

1. Consumer claims a job via HTTP (contains file reference, task definition, and parameters).
2. Consumer downloads the source file from MessyDesk (`GET /api/files/:rid`).
3. Consumer calls the external service (varies by adapter).
4. Consumer uploads result file(s) back via `POST /api/nomad/process/files` (multipart form: file + message JSON).
5. Consumer reports job completion (`POST /api/queue/{job_id}/complete`) or failure (`POST /api/queue/{job_id}/fail`).

**Verified from:** `src/funcs.mjs` (`getFile`, `sendFile`, `getFilesFromStore`), `src/queueClient.mjs`, multiple adapters.

## Component Interaction

```
┌────────────────────────────────────────────────────────┐
│                    MD-consumers                         │
│                                                        │
│  ┌──────────────┐   ┌──────────────┐                  │
│  │  index.mjs   │   │  funcs.mjs   │                  │
│  │  (bootstrap) │──▶│  (shared I/O)│                  │
│  └──────┬───────┘   └──────────────┘                  │
│         │                                              │
│         ▼                                              │
│  ┌──────────────────────┐                              │
│  │  adapters/<name>.mjs │  (dynamically imported)      │
│  │  exports: process_msg│                              │
│  └──────────────────────┘                              │
│                                                        │
└────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌──────────────┐            ┌──────────────────┐
  │  MessyDesk   │            │ External Service │
  │  Core API    │            │ (imaginary, AI,  │
  │ :8200        │            │  Solr, etc.)     │
  └──────────────┘            └──────────────────┘
```

## Adapter Loading

Adapters are loaded **dynamically at runtime** via ES module import:

```js
process_msg = (await import(`./adapters/${adapter_name}.mjs`)).process_msg;
```

The adapter name is resolved from (in priority order):
1. `ADAPTER` environment variable
2. `service_json.adapter` field from descriptor

**Verified from:** `src/index.mjs`

## Single Docker Image, Multiple Services

One container image serves all service adapters. The `TOPIC` environment variable determines which queue is consumed and which adapter is loaded. This means:

- The same image is deployed N times for N services
- All adapter code ships in every container (descriptors are copied to `/src/descriptors`)

**Verified from:** `Dockerfile`, `Makefile`

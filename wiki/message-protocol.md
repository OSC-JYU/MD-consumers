# Message Protocol

## Queue Topic Pattern

Jobs are enqueued with a topic matching the service ID (e.g., `md-imaginary`). The consumer claims jobs from its assigned topic via HTTP.

**Verified from:** `src/index.mjs`, `src/queueClient.mjs`

## Message Payload Structure

The JSON payload varies by service type, but all messages share a core structure:

```jsonc
{
  // Identity
  "userId": "user@example.com",        // Owner performing the action
  
  // File reference
  "file": {
    "@rid": "#252:236",                 // OrientDB-style record ID
    "@type": "File",
    "type": "image",                    // file type: image, text, pdf, json, etc.
    "extension": "jpeg",
    "label": "document.jpeg",
    "path": "data/projects/.../file.ext",  // relative path (used by disk-mode adapters)
    "source": { /* parent file object */ } // for derived files
  },
  
  // Processing instructions
  "task": {
    "id": "resize",                     // task identifier from descriptor
    "params": {                         // task-specific parameters
      "width": 400
    },
    "model": {                          // AI services only
      "id": "gpt-4o",
      "version": "2025-01-01-preview"
    }
  },
  
  // Process context
  "process": {
    "@rid": "#281:48",
    "@type": "Process",
    "label": "Rotate",
    "path": "data/projects/.../process/281_48/files"
  },
  
  // Batch context (optional)
  "input_set": "...",                   // set RID for batch input
  "output_set": "...",                  // set RID for batch output
  "set_process": "...",                 // process RID for set-level process
  "total_files": 10,                    // total files in batch
  "current_file": 3,                    // current file index (1-based)
  
  // AI-specific
  "task.params.prompts": {
    "content": "Describe this image..."  // system prompt for AI models
  },
  "task.params.output_type": "json",    // force JSON output (AI adapters)
  "task.params.json_schema": "...",     // JSON schema for structured output
}
```

**Verified from:** `tests/publish_thumbnailer.mjs`, adapter code parsing.

## Record IDs

The system uses OrientDB-style record IDs (e.g., `#252:236`). The `#` prefix is stripped when used in URL paths:

```js
msg.file['@rid'].replace('#', '')
```

**Verified from:** `src/funcs.mjs` (`getFile`), `src/adapters/solr.mjs`

## Result Upload Protocol

### File Results

```
POST /api/nomad/process/files
Content-Type: multipart/form-data

Parts:
  - content: <file binary>
  - message: <JSON payload with updated file metadata>
```

The message JSON is modified to include:
- `file.type` — output file type
- `file.extension` — output file extension  
- `file.label` — output filename
- `file_total` — total output files for this job
- `file_count` — current output file index
- `response.time` — processing time in seconds
- `thumb_name` — (optional) thumbnail filename

**Verified from:** `src/funcs.mjs` `sendFile()`, `getFilesFromStore()`

### Metadata Results (AI adapters)

```
POST /api/nomad/process/files/metadata
Content-Type: multipart/form-data

Parts:
  - content: <JSON string>
  - message: <JSON payload>
```

Used to send token counts, model version, modality info.

**Verified from:** `src/adapters/gemini-ai.mjs`, `src/adapters/azure-ai.mjs`

### Completion Signal

```
POST /api/nomad/process/files/done
Content-Type: application/json
Body: <message object with response.time>
```

Used by adapters that produce no output files (e.g., Solr indexer).

**Verified from:** `src/adapters/solr.mjs`, `src/adapters/elg_fs.mjs`

### Error Reporting

```
POST /api/nomad/process/files/error
Content-Type: application/json
Body: { error: "<message>", message: <original payload> }
```

**Verified from:** `src/funcs.mjs` `sendError()`

## Batch Processing Fields

| Field | Semantics |
|---|---|
| `total_files` | Total number of files to process in batch |
| `current_file` | 1-based index of current file |
| `file_total` | Total output files from a single service call |
| `file_count` | Current output file index from single call |
| `batch_total_files` | Preserved parent batch counter (elg_fs) |

**Verified from:** `src/adapters/elg_fs.mjs`, `src/funcs.mjs`

## Default User

All system-level API calls (registration, heartbeat, cleanup) use the hardcoded identity:

```
local.user@localhost
```

User-initiated processing preserves `msg.userId` from the original message.

**Verified from:** All source files define `DEFAULT_USER = 'local.user@localhost'`

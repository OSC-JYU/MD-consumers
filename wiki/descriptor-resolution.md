# Descriptor Resolution

## What Is a Service Descriptor?

A JSON object defining a service's identity, capabilities, tasks, models, and connection details. It is used for:

- Registering the service with MessyDesk's backend
- Determining which adapter to load
- Providing UI metadata (task names, param help)

## Resolution Chain

The function `resolveDescriptorSourceChain()` in `src/funcs.mjs` resolves descriptors in priority order:

```
1. Runtime /config endpoint (service_url/config)
2. Local descriptor files (multiple path candidates)
3. MessyDesk backend registry (GET /api/services/:topic)
4. Fallback: { id: topic, tasks: {} }
```

Each source returns a `{ descriptor, source }` tuple where `source` identifies provenance.

**Verified from:** `src/funcs.mjs` `resolveDescriptorSourceChain()`

## Runtime Policy in Consumer Startup

`src/index.mjs` applies a stricter policy than the generic helper chain:

1. If `SERVICE_JSON_PATH` is set, that explicit descriptor is used for registration and heartbeat metadata.
2. If `SERVICE_JSON_PATH` is not set, descriptor must come from runtime `/config`.
3. If neither explicit descriptor nor runtime `/config` descriptor is available, startup aborts.

In other words, backend-registry and topic-fallback descriptors are not used by the main consumer registration path.

**Verified from:** `src/index.mjs` `resolveRequiredDescriptor()` and registration flow.

## Source Labels

| Source label | Meaning |
|---|---|
| `runtime-config` | Fetched from the service's `/config` HTTP endpoint |
| `explicit-descriptor` | Loaded from path given via `SERVICE_JSON_PATH` env var |
| `adapter-descriptor` | Found in local `descriptors/` or `src/adapters/*.service.json` |
| `backend-registry` | Fetched from MessyDesk API `GET /api/services/:topic` |
| `topic-fallback` | No descriptor found; synthetic minimal object created |

Note: `backend-registry` and `topic-fallback` remain valid helper outputs from `resolveDescriptorSourceChain()`, but are not accepted by startup registration in `src/index.mjs` unless an explicit descriptor path is provided.

## Local Descriptor File Search Paths

`getAdapterServiceDescriptor()` searches these paths in order:

1. Explicit path from `SERVICE_JSON_PATH` (resolved against cwd, project root, `/src`)
2. `.descriptors/<topic>/service.json`
3. `.descriptors/<topic>/service.json.json`
4. `descriptors/<topic>/service.json`
5. `descriptors/<topic>/service.json.json`
6. `descriptors/<topic>.json`
7. `src/adapters/<topic>.service.json`
8. (If adapter name differs from topic): same paths with adapter name substituted

**Verified from:** `src/funcs.mjs` `getAdapterServiceDescriptor()`

## Descriptor Normalization

`normalizeDescriptor(descriptor, topic)` validates and normalizes:

- Must be a non-null, non-array object
- If `id` is missing, defaults to `topic`
- If `id` is empty string, returns `null` (invalid)
- If `tasks` exists, it must be an object (not array)

**Verified from:** `src/funcs.mjs` `normalizeDescriptor()`

## Registration Flow

After resolution, the descriptor is registered with MessyDesk:

```
POST /api/services/register
Body: { source: "<source_label>", service: <descriptor> }
Header: mail: local.user@localhost
```

Registration uses exponential backoff retry (default: 5 attempts, 500ms initial delay, max 10s).

**Verified from:** `src/funcs.mjs` `registerServiceDescriptorWithRetry()`

## Nomad HCL Resolution

For Nomad-managed services in `src/index.mjs`, Nomad spec resolution order is:

1. `NOMAD_HCL_PATH` (explicit override, highest priority)
2. `<descriptor_dir>/nomad.hcl` (sibling of explicit `SERVICE_JSON_PATH` file)

No `nomad.hcl` discovery is done from MD-consumers local adapter/descriptor directories.

**Verified from:** `src/funcs.mjs` `resolveNomadHclPath()`

## Design Decision: Runtime Config Preferred

The consumer uses this order for registration metadata:
- `SERVICE_JSON_PATH` explicit descriptor (highest priority)
- runtime `/config` descriptor (required when explicit path is not provided)

This means:
- Services can self-describe their capabilities dynamically through `/config`
- Operators can override runtime metadata with an explicit descriptor file
- Missing descriptor metadata is treated as a startup error (no silent fallback)

**Inferred:** This prevents adapter resolution from silently degrading to incomplete fallback descriptors.

## TOPIC vs Descriptor ID Mismatch Warning

If `TOPIC` env var does not match `service_json.id`, a warning is logged. This can cause 404 errors because registration and adapter heartbeats use `TOPIC` in URL paths.

**Verified from:** `src/index.mjs` explicit check and warning log.

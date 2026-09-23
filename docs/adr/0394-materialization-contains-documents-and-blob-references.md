# 0394. Materialization contains documents and blob references

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at recovery: a saved copy of the working folder is readable source material, not a writable historical generation. Pull, Push, and their comparison baseline remain.
- **Relates:** [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) (local bytes), [ADR-0372](0372-local-and-remote-blobs-open-independently.md) (explicit remote hosting), [ADR-0393](0393-rows-refer-to-blobs-without-owning-their-lifetime.md) (independent references), [ADR-0395](0395-restore-is-one-request-that-carries-its-own-safety-copy.md) (recovering old content).
- **Implementation:** The checkout renderer and manifest exist in `packages/app/src/data/artifact/checkout.ts`. The structural archive and unmounted server backup machinery have been removed.

## Context

An earlier draft made the authority keep daily copies of the materialized
store and use their row references to protect attachment bytes. That assumed
rows owned files and the store delivered them automatically.

The application instead saves blobs independently and uploads explicitly.
A row may contain a local BlobId, a remote URL, both, or neither. People accept
that local-only audio is lost with its device unless they preserve it themselves.
They want readable documents that an agent can inspect and repair, without a
second exact-state backup format or restoration UI.

## Decision

**Materialization writes documents, settings, and checkout metadata. Blob keys
and URLs remain ordinary values; no blob bytes are copied or fetched.**

The existing per-store folder shape remains:

```txt
<working-copy>/
  .epicenter/manifest.json
  AGENTS.md
  kv.json
  <table>/<row-id>.md
```

A row's fields are frontmatter and its content is rendered through its codec.
A local BlobId stays a reference, not a path to an exported sibling. A remote
URL stays a URL. Pull and Push neither check the referenced bytes for existence
nor upload, download, or delete them. The canonical local blob directory is
outside this working-copy contract.

Local and Personal stores remain distinct data sources. A cached Personal
replica represents the same Personal dataset as its authority, not another
dataset to export. Materializing Local rows does not make them account-synchronized.
This record does not introduce an aggregate root-folder layout or a new
multi-store export API.

**Pull and Push use the manifest as their comparison baseline.**

The manifest records destination identity, materialization time, row field
values, body hashes, and setting values. [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md)
defines comparison against the last Pull or successful Push baseline. No
current-store conflict comparison belongs to the target workflow.

Baseline advancement follows durable local edits, not remote acknowledgement.
A ZIP operation neither refreshes nor alters that baseline. The store and
folder host exist; application and CLI integration remain unbuilt.

**A saved folder is a copy of the files as they stand, including unpushed edits.**

A person may copy or zip the folder with ordinary filesystem tools. It contains
the last materialization plus any external edits. It includes no local audio
payloads, remote downloads, or promise that a referenced URL will stay readable.
Lossy serialization and future schema incompatibility are accepted; readable
source files remain useful for inspection and repair. Packaging files does not
need to interpret an application schema.

No scheduled snapshots, server-kept copies, retention catalog, dedicated backup
UI, or guarantee of full application-state reconstruction is part of this
decision. Blob protection can be considered separately later.

## Consequences

The readable folder remains the one materialization format. A saved copy can
help recover text but cannot recover missing audio merely because it contains a
BlobId or URL. Generic local blob enumeration remains useful independently.

The structural archive and its byte-installation code are removed under
[ADR-0379](0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The Markdown reader and checkout remain separate APIs.

## Considered alternatives

- Include every local blob in the folder: couples document checkout to file
  inventory and raises a second Push-deletion policy. Deferred.
- Download remote URLs while materializing: turns readable export into network
  transfer and credential work.
- Keep server snapshots and copies-aware blob reclamation: introduces retention
  and ownership guarantees absent from independent blob hosting.
- Maintain a separate exact-state backup format as a product requirement:
  stronger fidelity is not the selected recovery promise.

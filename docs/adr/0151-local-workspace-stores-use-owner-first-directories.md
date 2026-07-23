# 0151. Local workspace stores use owner-first directories

- **Status:** Superseded
- **Date:** 2026-07-19
- **Superseded by:** [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) (the per-Workspace storage runtime is deleted; ADR-0161 proposes the replacement replica boundary)
- **Relates:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0143](0143-account-open-never-consumes-device-data.md)

## Context

Device and Account already name distinct local persistence owners, but the Bun
runtime currently hides both behind hashed persistence directories and stores
each workspace as a flat `<WorkspaceId>.records.sqlite3` file. Epicenter then
nests that runtime under a Query-owned directory. The physical tree therefore
conceals the ownership boundary that the runtime API exposes and makes a
private implementation path look app-owned.

Account directory identity has another constraint. It is derived from a
normalized deployment identity and principal id. If that derivation changes
without detection, a returning account silently opens a new empty directory
and strands the previous store.

## Decision

The Bun canonical workspace runtime receives a `workspacesRoot` and owns this
physical layout:

```txt
workspaces/
  device/
    <WorkspaceId>/
      store.sqlite3
  accounts/
    <AccountKey>/
      account.json
      <WorkspaceId>/
        store.sqlite3
```

`device` and `accounts` name storage owners. The owner precedes the Workspace
ID so account-wide lifecycle operations are bounded by one directory and can
never consume Device data. A workspace directory is the lifecycle unit for the
SQLite file and any `store.sqlite3-wal` or `store.sqlite3-shm` files SQLite
creates while the store is open.

`AccountKey` is the full lowercase SHA-256 hex digest of the version-one
canonical encoding of `account`, the normalized deployment identity, and the
principal id. Callers never supply it. Its exact derivation is pinned by a
golden test.

Each Account directory contains `account.json`, a versioned witness containing
the key-derivation name and canonical deployment and principal inputs. Opening
an existing Account directory verifies that the witness derives the directory
name and refuses a mismatch. The directory name remains the persistence
identity; the witness is not a registry or a second selector. Device needs no
identity marker because its literal directory is its identity.

Workspace IDs remain human-readable path segments validated by the workspace
definition. Physical paths and SQLite files remain runtime-private and are not
portable workspace exports or writable app capabilities.

This is a greenfield cut. The runtime does not read, move, alias, or migrate
the previous hashed directories, `.epicenter-runtime.json` markers, or
`<WorkspaceId>.records.sqlite3` files.

## Consequences

- A person can identify Device workspaces and the workspace members of an
  Account directory without interpreting runtime hashes.
- Device and Account stores with the same Workspace ID cannot collide.
- Account identity derivation drift becomes a loud open failure instead of a
  silent empty store.
- The reusable Bun runtime, not each host application, owns SQLite file and
  sidecar naming.
- Closing a workspace before removing its directory gives deletion one exact
  physical boundary.
- Account witnesses store deployment and principal identifiers in plaintext
  beside already host-private local data.

## Considered alternatives

- **Inject a path callback from Epicenter.** Rejected because Device and
  Account are already runtime concepts, while a callback would leak the same
  taxonomy without letting the runtime enforce isolation.
- **Allocate a random Account ID and persist a lookup registry.** Rejected
  because locating that registry entry still requires the same account inputs
  and introduces another durable mapping that can be lost.
- **Call the file `workspace.sqlite3`.** Rejected because the physical SQLite
  file is runtime state, not the portable workspace.
- **Call the file `runtime.sqlite3`.** Rejected because durable Device data may
  have no other copy and is not disposable runtime output.
- **Keep one flat directory.** Rejected because it erases the owner and
  workspace lifecycle boundaries and mixes SQLite sidecar families.

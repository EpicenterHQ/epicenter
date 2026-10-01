# 0143. Account open never consumes Device data

- **Status:** Accepted
- **Date:** 2026-07-17
- **Supersedes:** [ADR-0139](0139-account-runtime-open-adds-device-state-through-native-intents.md)
- **Superseded by:** [ADR-0399](0399-moving-data-into-an-account-is-a-row-copy.md) entirely: Local is always open beside Personal, so there is no store to add, delete, or keep, and moving data is an ordinary write.
- **Amended by:** [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), which makes these lifecycle operations take a Workspace ID rather than an application lens.

## Context

Device and Account workspaces are separate local persistence owners. The current
Account runtime automatically converts matching Device data into account intents
and deletes the Device source before `open()` returns. That makes sign-in an
implicit upload and prevents a product from offering Add, Delete, or Keep after
the account workspace is independently usable.

## Decision

Opening an Account workspace acquires only Account storage and starts its normal
synchronization lifecycle. It never inspects, leases, imports, or deletes Device
storage.

If matching Device data exists, the product presents three explicit actions:

```txt
Add
  admit the Device workspace's current logical rows, documents, and KV
  into the open Account replica through ordinary native intents
  delete Device data only after those intents commit locally

Delete
  delete Device data without changing the Account workspace

Keep
  leave Device storage unchanged for a later decision
```

Browser and Bun runtimes expose the same owner-specific verbs:

```ts
const copy = await device.capture(workspaceId);
await account.add(workspaceId, copy);
await device.delete(workspaceId);

// Keep performs no call.
```

`add()` commits the whole logical copy into Account intent state before it
resolves. Source deletion is a separate later action, so an interrupted product
flow preserves Device data. Device runtimes do not expose `add()`, and Account
runtimes do not expose `capture()` or `delete()`.

Add transfers logical application state only. It never copies SQLite pages,
replica identity, receipt, checkpoint, acquisition scratch, or other protocol
state. Ordinary first-create-wins, KV folding, document merging, and authority
order resolve overlaps. The product may review or filter records before
admission; the storage runtime owns no automatic merge policy.

Add waits until the Account replica has installed its first complete authority
state, then commits the whole logical copy into local Account intents before it
resolves. It preserves globally unique row ids so application references remain
valid. A deleted Account row id is permanently retired by the authority, so
re-adding an old Device copy cannot resurrect a different row lifetime at that
address.

Device and Account expose the same logical workspace model under different
storage owners. Their private SQLite layouts may differ. Account reset,
enrollment, or rebaseline never resets Device data.

## Consequences

- Sign-in activates Account data without uploading or deleting signed-out work.
- The user can use the Account workspace before resolving Device data.
- `open()` loses its second-storage lease, addition failure, and source-deletion
  lifecycle.
- Add reuses native intent durability and synchronization rather than creating a
  database-transfer protocol.
- Apps must present or deliberately defer the pending Device-data choice.

## Considered alternatives

- **Automatically add on Account open.** Rejected because authentication is not
  consent to upload and consume signed-out data.
- **Copy the Device SQLite file.** Rejected because runtime protocol state is not
  portable authority state.
- **Make Device and Account share one physical database.** Rejected because
  account switching would recreate owner partitions inside that database.

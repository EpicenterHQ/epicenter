# 0916. Export saves a local checkpoint before copying code

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md), its source-selection rule, and [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md), its checkpoint subject and lock scope.

## Context

Exporting the last existing commit can omit work completed since the backup
clock ran. Requiring a separate checkpoint makes the person manage that timing.
A checkpoint also uploads the private backup, which can delay local export.

## Decision

Export validates its destination, saves a local checkpoint of the whole private
Epicenter, and copies code from that exact commit. It includes pending code,
records, and staged files in the private checkpoint. Only filtered app code
enters the exported directory. A refused or deferred snapshot stops export
before changing its destination. Edits made after the snapshot wait for the
next export.

Local snapshots and backup uploads have separate ownership. The root lock
covers saving and capturing the commit and branch. Checkpoint releases that
lock before uploading the exact inspected commit with an ordinary non-force
push. Export takes only the local snapshot. The checkpoint clock or a manual
checkpoint uploads it later.

Automatic checkpoint subjects name the changed app code, records, and root
files. Long subjects use a file count. An explicit message remains unchanged.
The subject describes paths; it does not claim the work is complete or tested.

## Consequences

One export command includes the current app code without waiting for a timer
or a network upload. It also records other included pending work in the private
Epicenter. Local saving can proceed while another checkpoint uploads an older
snapshot. Concurrent uploads can fail with an ordinary non-fast-forward refusal;
a later checkpoint retries the newer saved state.

Publication still requires reviewing and committing the generated files in
their separate repository. `new --from` continues to copy committed publication
code and warn about local source changes outside the copied commit.

## Considered alternatives

- Require a manual checkpoint: preserves separate commands but makes fresh
  exports depend on the person remembering the backup clock.
- Copy the working tree directly: avoids a checkpoint but loses one recoverable
  source revision for the complete export.
- Upload before exporting: couples local code sharing to the backup connection.
- Generate commit subjects with a model: adds a network dependency and can
  misrepresent unfinished changes from several apps.

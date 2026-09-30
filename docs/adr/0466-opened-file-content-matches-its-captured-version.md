# 0466. Opened file content matches its captured version

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** version-consistent native media opening and operation-scoped capture cleanup without a universal file mirror.

## Context

A transcription captures an audio reference before awaiting provider output.
The admitted output must correspond to those input bytes. Checking the path's
hash before returning a lazy file Blob does not preserve that relationship.

A Bun check on 2026-09-30 wrote `audio-A`, read a `Bun.file` Blob, replaced the
path with `audio-B`, and read the same Blob again. It returned `audio-B`.
The experiment verifies lazy-view behavior; it does not implement a native
file-folder adapter.

## Decision

**An opened file's consumed bytes match the content version reported with it,
or the read refuses.** A `FileRef` is a literal path and captured content
version. Opening such a reference is a conditional read of the current path;
it does not promise retrieval of overwritten, uncommitted history.

`files.open(path)` captures the bytes and version together.
`files.open(ref)` additionally requires the current path to match `ref.version`.
Neither may return a lazy mutable file view under a previously computed version.

**Current media paths contain actual media bytes, not Git LFS pointers.**
Opening `recordings/interview.opus` reads the current audio at that path. It
does not require a commit, upload, network fetch, or an LFS lookup when those
bytes are already present. Git history may store an LFS pointer containing a
SHA-256 object ID and byte size; that pointer describes the recorded object,
not a guarantee that an externally edited working file still matches it.

Hashing reads bytes to compute their SHA-256 fingerprint. The fingerprint
identifies content, not the row's stem or path. A rename preserves the
fingerprint when bytes are unchanged; replacing audio at the same path changes
its fingerprint. Equal fingerprints cannot distinguish a move from a copy or
two independently created files with identical bytes. The explicit rename
operation knows its source and destination without hashing. This distinction
lets a workflow record which audio produced its output. Table listing discovers attachment paths without hashing media.

**Share content fingerprints with LFS when they describe the same verified
bytes; do not introduce a second media identity scheme.** An already verified
immutable LFS object can supply its SHA-256 and size. Opening current uncommitted
or externally modified media captures those current bytes and their version;
an older pointer cannot supply that proof. Compute the fingerprint while
capturing or consuming the bytes where possible, rather than adding a separate
hash pass. A verified capture can supply the same fingerprint when those exact
bytes later enter LFS history. This reuse is an implementation optimization,
not permission to skip verification or a requirement to move every open through
the LFS object store. See the [Git LFS specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).

Browser immutable objects can provide this observation. Native reads use
immutable memory, an operation-scoped temporary capture, an immutable Git/LFS
object, or a consumption protocol that verifies the actual delivered bytes and
rejects mismatch before they can authorize derived output. Opening a file
descriptor or checking its hash before streaming does not alone pin its bytes.

**The read owner accounts for any capture until consumption finishes.**
Temporary captures have explicit cleanup on completion, failure, and interrupted
operation recovery. A capture needed by a running operation cannot be reclaimed
merely because its original path changed. This rule does not require a permanent
second copy of every current file.

A generated-output publication also checks its captured input requirement at
publication. That check includes the owner row's existence at the captured table
and stem, exact attachment version, and complete same-stem candidate set. It does not substitute
for verifying the bytes actually supplied to the provider. A title-only change
need not reject a separate result-row creation.

## Consequences

- Whole-media memory is a simple pinning mechanism, with a cost proportional
  to recording size. Temporary capture trades memory for disk and cleanup.
- A path can remain readable while an older reference refuses. Git historical
  reads are separate from opening current files.
- The `read` byte API and `open` media API remain distinct until one content
  representation proves their native and browser transport needs. Their names
  do not justify eager whole-media buffering.
- Input pinning and publication admission protect different intervals. Neither
  replaces capture receipts or app-level deletion admission.

## Considered alternatives

- Return `Bun.file(path)` after hashing it. A later replacement changes the
  bytes read from the Blob without changing the version already reported.
- Keep a permanent mirror of every file. It supplies historical bytes at the
  cost of copying and retaining every current file; this rule needs captures
  only for admitted reads.

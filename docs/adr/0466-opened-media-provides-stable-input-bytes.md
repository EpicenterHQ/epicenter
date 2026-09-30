# 0466. Opened media provides stable input bytes

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** stable native media reads, operation-scoped capture cleanup, and migrated transcription workflows.

## Context

A transcription consumes audio and returns text. A row supplies the attachment
path and any required fields; it does not own the running inference operation.
Requiring the row and audio to remain unchanged until the result is saved adds
media versions and publication checks to an otherwise independent function.

A Bun check on 2026-09-30 wrote `audio-A`, read a `Bun.file` Blob, replaced the
path with `audio-B`, and read the same Blob again. It returned `audio-B`.
That lazy view cannot represent audio already captured for an operation.
The experiment does not implement a native file-folder adapter.

## Decision

**`files.open(path)` supplies stable media bytes for consumption.** It takes a
literal folder-relative path and reports a read failure if the media cannot be
obtained. Once captured, the content consumed by the operation does not change
when the source path is replaced, renamed, or deleted. The read does not promise
a filesystem-wide atomic snapshot against concurrent native writers.

Opening media requires no content hash or media version token. There is no
media `FileRef` or conditional `files.open(ref)` contract. Browser immutable
objects can supply the bytes; native reads can capture them into memory or an
operation-scoped temporary file. The transport remains an implementation choice
and must account for capture lifetime and cleanup through consumption.
A lazy view of the mutable source path alone does not supply stable input.

**Transcription consumes supplied audio and returns text.** A row-based caller
checks existence, the fields the operation requires, and an unambiguous readable
attachment before supplying audio. It need not require unrelated fields to
conform. Missing or unusable inputs fail before inference starts.

The caller owns result persistence, cleanup of transcript text, and delivery.
Saving a separate result does not recheck the input row's existence, stem,
attachment candidates, or audio contents. A source-path annotation records where
the input came from; it does not certify the current file's contents. Rename or
deletion after input capture does not itself invalidate the returned text.
A workflow must not recreate a deleted recording merely to attach its result.
Cancellation remains product-owned under ADR-0471.

Updating an existing Markdown row uses its ordinary conditional-write contract
under ADR-0464. That protects the destination's source from intervening edits;
it introduces no media hash check. The caller chooses the destination explicitly.

**Git LFS owns media hashing for history storage under ADR-0468.** Working paths
and complete saved-folder copies contain actual media. Opening available audio
requires no commit, upload, or LFS lookup. LFS computes the SHA-256 object ID when
it ingests audio for history; ordinary media reads and transcription require no
additional hash pass. See the [Git LFS specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).

## Consequences

- Transcription can run independently of the input row after audio capture.
  Separate result persistence does not need a source-version admission step.
- Memory captures cost memory proportional to recording size. Temporary captures
  trade memory for disk and explicit cleanup on success, failure, or cancellation.
  No permanent mirror of every current file is required.
- The `read` byte API and `open` media API retain their transport distinction;
  neither name introduces mandatory media hashing.
- Table entries retain Markdown versions for conditional edits. Historical
  media retrieval remains separate from opening current files.

## Considered alternatives

- Hash audio on every open and recheck the row and attachment before saving text.
  This couples inference results to a mutable input address without being needed
  by the chosen audio-in, text-out contract.
- Return a lazy mutable path view as captured audio. Later reads can consume
  replacement bytes instead of the input the operation already acquired.

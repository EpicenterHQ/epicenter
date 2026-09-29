# 0450. Current files own portable document data

- **Status:** Proposed
- **Date:** 2026-09-28
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) at definitions as interpretations; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at the existing Yjs checkout; [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at Markdown as an export artifact.
- **Unbuilt:** a file-authoritative document library in the live applications, app-owned attachment lifetimes, and complete current-state recovery.

## Context

Today, a Markdown checkout is rendered from a Yjs store. Editing the checkout requires a push back into that store. Whispering records an `audioBlobId` in a row, while its audio lives in a separate blob store. Copying the Markdown files alone cannot recover a recording, and deleting a recording through the app leaves its audio behind.

The intended library lets a person, an application, or an agent work on the same current files. A file should not become a temporary representation that must be imported into a different authoritative document before an edit counts.

## Decision

**For a portable document library, its current logical files are the authoritative saved data.** Documents are Markdown source files. Attachments owned by those documents are files in the same logical set. The set consists of relative paths and their contents; a browser adapter may store it differently from a native folder. Where a person or agent can edit a native folder, those files are the live source, not a checkout of another document store.

Definitions interpret the source for an application. They do not decide whether a file exists or rewrite it merely because this release cannot understand it. Opening, reading, and indexing preserve malformed documents, unknown fields, unsupported bodies, and unrecognized files. Derived indexes, typed views, and editor models do not become another authority over saved content. A temporary Yjs editor is possible, but its unsaved state cannot replace newer source without an explicit edit decision.

**Applications create and delete a document together with the attachments it owns in the current file set.** A reference to another document's file does not transfer ownership. An external edit changes the files directly; a missing document does not authorize an automatic sweep of remaining files. The convention that identifies an attachment's owner, and the handling of ambiguous files during an app deletion, require a later decision.

**A complete copy of the saved current state contains the actual bytes of every file in that state.** It can be opened without the original application database, account, service, or history. A media pointer alone is not a complete copy. This rule does not prescribe a ZIP format, a snapshot procedure, or whether a device keeps every attachment materialized at all times.

This decision applies to libraries deliberately moved to this model. Existing Yjs stores and their checkouts continue under their current rules until migrated. Device settings, credentials, operation receipts, and other application databases do not become Markdown documents by implication.

## Consequences

- File-to-Yjs pull and push cease to be the normal editing boundary for a migrated library. An independently persisted Yjs row or body cannot override its current files.
- The application must preserve source outside the edit it intends to make and must account for files changed by another writer. The edit and conflict rules remain to be designed.
- App-level attachment ownership removes the need for a separate application-facing blob lifetime for a recording. Physical byte storage, transfer, historical retention, and reclamation remain separate questions.
- A complete copy must include media bytes even if storage or sync uses placeholders internally. A partial or interrupted copy cannot claim to recover the saved current state.
- File layout, IDs, attachment cardinality, save publication, sync, export packaging, and the `defineStore` and `defineTable` APIs remain open.

## Considered alternatives

- Keep Yjs authoritative and export Markdown. This retains the conversion and push boundary for data whose intended normal form is a file.
- Let Markdown cite an independent blob store and make export assemble a different portable format. This leaves the ordinary saved files unable to recover their own recordings without private application state.
- Fix one sibling attachment path and one attachment per document here. That chooses a filename grammar and cardinality before the ownership rule needs either one.

# 0450. Current files own portable document data

- **Status:** Proposed
- **Date:** 2026-09-28
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) at definitions as interpretations; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at the existing Yjs checkout; [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at Markdown as an export artifact.
- **Unbuilt:** file-authoritative document data in the live applications, app-owned attachment lifetimes, and complete current-state recovery.

## Context

Today, a Markdown checkout is rendered from a Yjs store. Editing the checkout requires a push back into that store. Whispering records an `audioBlobId` in a row, while its audio lives in a separate blob store. Copying the Markdown files alone cannot recover a recording, and deleting a recording through the app leaves its audio behind.

The intended Epicenter data folder lets a person, an application, or an agent work on the same current files. A file should not become a temporary representation that must be imported into a different authoritative document before an edit counts.

## Decision

**For portable document data, its current logical files are the authoritative saved data.** A data folder contains named tables of Markdown rows, root `kv.json`, and row-owned attachment files. The folder is a logical set of relative paths and their contents; a browser adapter may store it differently from a native directory. Where a person or agent can edit a native folder, those files are the live source, not a checkout of another document store.

**A row is a table member saved in a Markdown file.** Use "row" for the member and "row file" when discussing its saved bytes. Fields appear in frontmatter; the body follows it. A file remains saved data when its fields or body cannot be interpreted by the current application. An inferred row value is an interpretation of that data, not its complete saved representation. "Row source" does not name another object. Apps can call rows recordings, notes, or other domain names.

Definitions interpret the source for an application. They do not decide whether a file exists or rewrite it merely because this release cannot understand it. Opening, reading, and indexing preserve malformed documents, unknown fields, unsupported bodies, and unrecognized files. Derived indexes, typed views, and editor models do not become another authority over saved content. A temporary Yjs editor is possible, but its unsaved state cannot replace newer source without an explicit edit decision.

**Applications create and delete a row together with its owned attachment in the current file set.** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) specifies zero or one same-stem sibling attachment and refusal of ambiguous app deletion. A reference to another row's file does not transfer ownership. An external edit changes the files directly; a missing row does not authorize an automatic sweep of remaining files.

**A complete copy of a data folder's saved current state contains the actual bytes of every file that folder owns.** It can be opened without the original application database, account, service, or history. A media pointer alone is not a complete copy. A link to another data folder remains an external reference; copying both folders preserves the linked bytes and their relative path. This rule does not prescribe a ZIP format, a snapshot procedure, or whether a device keeps every attachment materialized at all times.

This decision applies to data folders deliberately moved to this model. Existing Yjs stores and their checkouts continue under their current rules until migrated. Local-only settings can use a data folder's `kv.json`; file authority does not require synchronization. Credentials and private transactional databases retain their separate storage contracts.

## Consequences

- File-to-Yjs pull and push cease to be the normal editing boundary for a migrated data folder. An independently persisted Yjs row or body cannot override its current files.
- The application must preserve source outside the edit it intends to make and must account for files changed by another writer. The edit and conflict rules remain to be designed.
- App-level attachment ownership removes the need for a separate application-facing blob lifetime for a recording. Physical byte storage, transfer, historical retention, and reclamation remain separate questions.
- A complete copy must include media bytes even if storage or sync uses placeholders internally. A partial or interrupted copy cannot claim to recover the saved current state.
- IDs, save publication, sync, export packaging, and the `defineStore` and `defineTable` APIs are separate decisions. Attachment cardinality and sibling layout follow ADR-0456.

## Execution

Work from authoritative files toward application views:

1. Establish path-based reading and enumeration independently of definitions.
   Opening must preserve invalid YAML, unknown fields, unsupported Markdown,
   duplicate IDs, and orphaned attachments. Ambiguity remains inspectable by path.
2. Define source-preserving edits and row/attachment publication with explicit
   interruption recovery. Typed edits refuse source they cannot safely interpret
   unless the user explicitly repairs it. Other writers' changes must be detected
   before replacing source. This does not imply arbitrary multi-file transactions.
3. Build typed table/KV views and optional indexes over that file boundary.
   Keep body parsing and collaborative editor state in the editors that need
   them. An editor must handle changed source before saving its own interpretation.
4. Migrate application workflows against those guarantees. Replace current
   multi-row `transact` callers with a proven file operation or an explicit
   recovery strategy; do not satisfy that API with notification batching alone.
   Replace independent recording blob references with owned sibling attachments.
5. Remove the migrated consumers' Yjs persistence and checkout pull/push path.
   Remove body codecs required solely to export their data, while retaining
   conversion needed by editors. Existing inferred value types can remain where
   they still describe the table reads.

## Considered alternatives

- Keep Yjs authoritative and export Markdown. This retains the conversion and push boundary for data whose intended normal form is a file.
- Let Markdown cite an independent blob store and make export assemble a different portable format. This leaves the ordinary saved files unable to recover their own recordings without private application state.

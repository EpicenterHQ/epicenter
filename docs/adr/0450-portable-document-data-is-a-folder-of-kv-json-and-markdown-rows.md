# 0450. Portable document data is a folder of kv.json and Markdown rows

- **Status:** Proposed
- **Date:** 2026-09-28
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the file layout; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at the existing Yjs checkout
- **Unbuilt:** opening canonical folders in desktop and browser apps, complete row-owned attachments, Git synchronization, consistent folder exports, and migration from existing stores.

## Context

`renderArtifact` produces `kv.json` and `<table>/<row-id>.md`, but the files are an artifact of a Yjs store. Recording rows still contain `audioBlobId`; their audio lives in a separate blob store and may be uploaded through another channel. Copying the artifact does not copy a complete recording.

ADR-0337 makes the folder a working copy: a person pulls data into it and pushes edits back to the store. That cycle gives a document two owners and requires a manifest to reconcile them. A separate Local and Personal store would also require attachment transfer and deletion coordination.

## Decision

**Applications operate on current files. Definitions constrain application writes. Sync transfers current data. Export produces a complete independent copy.**

**For portable document data, the folder contains the authoritative current data, including files owned by rows.** A person chooses the folder and its name. An app opens that folder directly; the folder's name and parent path have no meaning in the format. For example:

```txt
My Data/
  kv.json                          stored values, excluding device settings
  notes/n456.md                    one Markdown row
  recordings/r123.md               another Markdown row
  recordings/r123.wav              audio owned by that recording
```

The general paths are `kv.json`, `<table>/<row-id>.md`, and optionally one sibling `<table>/<row-id>.<extension>` whose extension is not `md`. `kv.json` is one JSON object. A row's Markdown path supplies its table and stable row identity. Its frontmatter holds fields; its body holds document content when the row has a body. A recording's audio is its sibling file, whether the source is WAV, WebM, or another supported format. A reusable file belongs to its own row in a `files` table; other rows may refer to it without owning its lifetime. No independently synchronized blob ID, blob inventory, attachment-filename pointer, or per-recording upload marker is part of this format.

**The final dot separates a row ID from its file extension.** The extension is one nonempty ASCII alphanumeric segment; `md` in any letter case identifies a row, never an attachment. Dots within row IDs remain meaningful: `r1.take.opus` belongs to `r1.take.md`, and `r1.tar.gz` belongs to `r1.tar.md`, not `r1.md`. Apps choose a lowercase extension for new files, use `bin` when an import has no usable extension, and preserve the exact existing path when editing. They never create a case variant of an existing path. A folder adapter checks destination name limits and case or Unicode collisions before writing; it refuses an unrepresentable copy rather than merging or renaming source paths silently.

The row ID replaces the imported file's basename. An app may keep an original name as descriptive metadata; that name does not select or address the attachment. Reserving `.md` means a separate opaque attachment cannot retain that suffix beside its owning row. An importer must refuse that operation or obtain an explicit choice of another representation; it must not silently rewrite the attachment into row frontmatter. Files outside this grammar remain source files to preserve, not candidates to normalize or delete.

**An attachment has one owning row, and a row owns at most one attachment.** A table definition may require an attachment; a valid row in that table has exactly one. Several rows may reference the same owning row. Deleting a referring note does not delete a shared file row or its bytes. Deleting the owning row through the app removes its attachment from current data; applications decide how to handle remaining references. No reference counting or automatic cascade is implied.

**A row file is the publication point for its owned file.** An app finishes writing the owned bytes before publishing the Markdown row. It removes the Markdown row before removing owned bytes. An interrupted operation may leave orphan bytes, which readers preserve and do not present as a completed row. A row whose expected bytes are absent remains visible with a missing-file error; the app does not silently discard or repair its source. Apps do not replace a recording's original audio in place.

**Git is the expected history and synchronization engine for a working folder.** A completed publication sync ensures the published rows and their exact owned bytes are durably retrievable at the destination. A receiving client may download attachments on demand; until it has all current bytes, its local folder is not a complete offline copy. The sync representation retains each unmaterialized attachment's expected path and exact byte identity, including optional attachments. An absent local file never proves that no attachment exists, and placeholders are not playable bytes. An interrupted publication may expose an incomplete revision; clients must report it as incomplete. The folder format does not prescribe a Git host; an Epicenter-operated remote is not required. Removing a row and its owned file removes them from the current revision. Git may retain older references, but archival recovery does not require retaining their attachment bytes. Restoring an earlier revision may restore the same row identity; unavailable bytes must be reported. There is no permanent row retirement or audio purge promise. An app opens the current files without requiring `.git`. Neither `library.json` nor `epicenter.json` is required to identify the file layout.

**An archive is a complete copy of the folder's chosen final state.** It contains the saved working files, including untracked and unrecognized files, rather than only files in a Git commit. Epicenter's archive operation excludes `.git`; device-private files belong outside the data folder. A ZIP may package that same layout. Opening it requires no original account, running service, Git history, bundle, or separate `snapshot/` directory. A checksum manifest is optional integrity evidence. Before reporting an archive complete, Epicenter retrieves all attachment bytes belonging to the current state, including populated optional attachments, and materializes every recognized transport placeholder, even one without a valid owning row. Unavailable bytes prevent that success claim. The archive scope is a whole selected folder. Selected-row exports and discovery of their dependencies are separate capabilities. Copying a fully materialized folder while writes are paused provides the same current-state contents; an arbitrary copy during writes does not establish consistency.

Export captures file versions before materialization. Each remote read returns those exact bytes or fails; a newer file at the same path is not a substitute. The destination is staged outside the source and published only after copying succeeds. The initial archive contract preserves regular-file bytes and relative paths, not filesystem metadata. Unsupported entries, including symbolic links, prevent a complete export rather than being followed or silently skipped. Recovery opens the copy directly or extracts it into a fresh folder. It does not merge rows into an existing store or remap their IDs. A ZIP reader must validate entry paths, entry types, and destination collisions before extracting.

**Copying preserves source bytes independently of application validation.** Apart from materializing recognized transport placeholders, unknown or malformed rows, unsupported bodies, conflict markers, orphan files, and ambiguous attachments survive copying and reopening without parse-and-rewrite normalization. Opening and indexing do not rewrite them. A faithful copy may still contain invalid application data; Epicenter reports those problems without deleting or repairing files to claim validity. Preserving every available file does not establish completeness when referenced bytes are unavailable.

A required attachment already absent from the captured inventory is a defect in the source, which a recovery copy preserves and reports. It does not block copying the remaining data. A file present in that inventory whose captured bytes cannot be read or fetched does block completion. This distinction prevents one damaged recording from making the rest of the folder impossible to recover.

The selected transfer mechanism identifies placeholders through its metadata or declared handling; pointer-like text alone never authorizes replacement. Expected paths and byte identities remain locally discoverable until materialization finishes, and retrieved bytes must match those identities.

An app may interpret files through a definition, but an unreadable field, unsupported body, or conflicted file does not remove the source. Apps enforce attachment requirements on their own writes and validate external edits. Multiple candidate attachments remain on disk with an ambiguity error; the one-attachment rule never authorizes deleting unexpected files. Editing a file changes the data without pushing it into a Yjs row. An app detects changes made since it read a file before replacing that file. Sync and app writes must be coordinated so a Git worktree change cannot silently overwrite a pending edit.

An app edit preserves source outside the intended change, including unknown fields and unsupported body syntax. If the app cannot preserve that source, it refuses the edit rather than rewriting it lossily. An unreadable `kv.json` is never replaced with defaults.

App writes, sync, and export serialize cooperating writers. Detecting a changed file can preserve a pending edit, but a check followed by a rename is not an atomic compare-and-swap against an unrelated process. A consistent export requires a quiescent source or a stable snapshot supplied by its adapter.

This rule applies to portable document folders. It does not turn borrowed mirrors, credentials, device settings, or every application database into Markdown files. ADR-0268 and ADR-0337 still govern existing Yjs stores and their checkout behavior until those stores are deliberately migrated.

## Consequences

Apps, editors, and agents can work on the same current files. SQLite and search indexes derive from them and can be rebuilt. For migrated folders, the Yjs-to-folder pull, push, and baseline manifest cease to be the normal editing boundary. Row ownership removes the independent application-facing blob inventory, and this format requires no permanent retirement protocol. Attachment transfer still needs verification and interrupted-operation recovery; its choice does not change the folder's ownership or archive contract. Remote reclamation must account for bytes still needed by current revisions and unfinished transfers; no cleanup algorithm is established here.

Final-state archives require no historical attachment retention. Unused shared file rows may remain until explicitly removed. Git LFS or another attachment transfer mechanism must materialize actual bytes for an archive; pointers alone are incomplete. Transfer selection remains open and requires proof of current-file synchronization, playback, and complete export. Any future historical recovery promise must separately define which old attachment bytes it retains.

Flat pairing removes one directory per row and the need to select an attachment by filename. Whole-folder recovery avoids dependency-closure traversal and merge-import policies. The costs are renamed attachment basenames, a reserved Markdown suffix, and explicit diagnostics for external edits that violate the app's one-file rule. Recovery guarantees only the contents of a retained complete export; later changes need another export.

Git does not make several filesystem writes atomic or prevent a person from committing a Markdown row without its audio. A completed local creation requires the row and its attachment to be durable locally. Publication sync requires durable remote availability; a complete offline archive requires all bytes locally. To free storage while keeping a row, a device may evict its local attachment only after verifying that those exact bytes are durably retrievable remotely; an upload marker alone is insufficient. Browser and phone adapters must preserve the same logical paths and completion rules; their folder access and Git transport require separate proof.

## Considered alternatives

- Keep Yjs authoritative and treat Markdown as an export. This retains the pull and push boundary for data whose normal form is the file.
- Keep separate Local and Personal storage formats. This requires conversion between two authoritative representations instead of opening the same logical folder format on each device.
- Require `.git` to read a folder. This makes opening a current-state copy depend on history metadata even though its data files are present.
- Require every archive to preserve Git history and old attachments. This adds retention obligations beyond preserving the chosen final contents.
- Put each attachment in a row directory. This preserves arbitrary original filenames, but adds a directory when the app admits only one file and would still need to report multiple candidates.
- Select an attachment through a frontmatter filename or a generic attachment list. This adds a second relationship to maintain when the row ID and one sibling already identify ownership.
- Merge a recovery archive into an existing store. This requires identity, conflict, and deletion policies that opening a fresh folder avoids.

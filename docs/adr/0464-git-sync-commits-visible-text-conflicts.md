# 0464. Git sync commits text conflicts and honors file deletion

- **Status:** Proposed
- **Date:** 2026-09-29
- **Unbuilt:** divergent Git sync for the browser and native data folders.

## Context

Portable data folders make current Markdown rows, `kv.json`, and owned attachments the saved data. The file-notebook prototype commits and transfers files but stops when Git histories diverge. Requiring every merge result to parse as a row, settings object, or chat would make synchronization depend on application repair rules.

## Decision

**Git sync merges paths without interpreting their application meaning.** For a file present in the common ancestor, deletion wins over a concurrent edit to that same path. Both sides deleting it, or one side deleting it while the other leaves it unchanged, also leaves the path absent. A file created on one side when it did not exist in the common ancestor is an addition, not a deletion. This rule applies to whole files, not to YAML or JSON keys or Markdown passages.

For text files retained by both sides, sync uses a three-way text merge against the common ancestor. A clean result becomes the current file even if an application cannot interpret it. An overlapping conflict becomes literal markers in the current file. Sync commits and can push that marker-bearing file without waiting for repair. A person or agent can repair it in a later commit. The merge commit retains both histories as parents, including an edit that lost to a file deletion. Git sync is optional for a data folder.

Applications preserve unreadable source. A typed reader refuses writes or model context it cannot safely interpret, including unresolved conflict markers. An unreadable `kv.json` is an error, not a missing setting. Sync does not fork chats, mint row IDs, or repair application data.

Sync does not restore an attachment because its row survived, remove an orphan because its row was deleted, or merge files by row identity. Files changed on both sides with incompatible opaque bytes, including opaque files added at the same path, still need a byte-safe decision when divergent sync is implemented. This record does not require the browser and native Git implementations to produce identical marker text or set a local commit cadence beyond recording local changes before merging them.

## Consequences

- Ordinary text conflicts can synchronize without waiting for a repair UI or AI. The affected typed view remains unavailable until the file is repaired.
- A clean merge may change the meaning of a chat or another document. Git's text merge does not establish application-level coherence.
- When deletion beats an edit, the edited version disappears from current files without a marker or repair prompt. It remains in the merge's parent history while that history is retained. A copy of current files alone cannot recover it. Recovering historical media also requires its LFS bytes to remain available.
- A row and attachment can become separated by external edits or other path-level merges. Sync preserves the resulting paths; applications decide whether missing media or dangling references make a particular row unusable.
- Git's ordinary modify/delete merge stops for a decision, so an implementation must explicitly choose and commit the deletion. The current browser and native prototypes still stop at divergence, and the browser also refuses incoming deletions. This record describes intended behavior, not an implemented sync path.
- Current media files must contain bytes, not Git LFS pointers, to meet [ADR-0450](0450-current-files-own-portable-document-data.md)'s complete-copy guarantee. A sync implementation must handle LFS transport separately from text merging.

## Considered alternatives

- Keep the merge unfinished until every text conflict is repaired. A text conflict would block synchronization.
- Keep the edit when the other side deletes the file. This can preserve an edited row while its unchanged attachment is deleted, and a later deletion must be repeated.
- Add a row-aware rule to restore that attachment. This gives sync ownership of application relationships and does not resolve dangling references across different rows.
- Merge YAML or JSON by key. This makes sync depend on valid application syntax and leaves Markdown bodies and other text conflicts unresolved.
- Choose one side for every text conflict. The current file would hide the need for repair.

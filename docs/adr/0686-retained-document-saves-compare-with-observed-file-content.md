# 0686. Retained document saves compare with observed file content

- **Status:** Proposed
- **Date:** 2026-10-23
- **Amends:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md)
  at document publication and acknowledgement by raw commands, and
  [ADR-0676](0676-structured-edits-share-the-acquired-working-document.md)
  at document publication. Their shared source, path lane, and detached
  complete writes remain.
- **Unbuilt:** Checked document publication in both storage engines, conflict
  and resolution in document snapshots, removal of raw-command draft
  acknowledgement, and caller conflict handling. Current document saves remain
  unconditional.

## Context

`files.document(path)` and `tables.<name>.document(id)` share a Folder-owned
working source. It accepts text immediately, retains that text across component
unmount and failed saves, and may publish it after a debounce or a later retry.
Today that publication is unconditional. If another Folder handle or an outside
program changes the file after the document reads it, the delayed save can
overwrite that change without notice. A successful `files.write`,
`files.delete`, or complete table command can also acknowledge a draft it did
not publish.

One-shot commands have a different lifetime. `files.write` and
`tables.<name>.write` publish their call's content, report the outcome, and
retain no draft for autosave. `files.delete` and `tables.<name>.delete` likewise
report their own outcome. Some write text, such as a send receipt; others copy
binary bytes. File extension does not determine whether an operation holds a
working draft.

## Decision

**A retained text document saves against the stored content on which its draft
was based.** The Folder still owns one text source and one ordered command lane
per path. `replace`, `patch`, and `save(input)` accept text before publication.
Autosave and explicit `save` submit exact captured text. At the storage attempt,
the document publishes only if the path still holds its base or already holds
the submitted text. Otherwise it keeps the draft and reports a conflict. The
comparison runs again on a browser repository retry. Text accepted before
acquisition waits for a read: it can create an absent file, but it cannot
replace an existing file it has not observed. A failed read keeps the text and
permits no publication.

**A publication acknowledges only the document input it captured.** An awaited
save reports its captured Markdown content even when an observer or later
typing changes the document before the result arrives. Later typing stays
pending after an older save succeeds. When it descends from text that just
landed, its comparison base advances to that landed text. A storage failure
retains accepted text for retry and remains separate from a conflict.

**Raw file and complete table commands never accept or acknowledge document
input.** `files.write`, `files.delete`, `tables.<name>.write`, and
`tables.<name>.delete` remain one-shot, unconditional commands in the same path
lane. They report their own outcomes to their callers. A successful raw command
at a dirty document's path updates the observed stored side. If it differs
from the draft's base, the draft becomes conflicted; the raw command does not
clear the draft or install binary bytes as
editable content. A clean document follows the latest applicable observation,
including a missing or non-text file. Git synchronization keeps its separate
history merge contract.

**A conflict exposes the text needed for a whole-file choice without retaining
a binary draft.** The document's ordinary `content.text` is the local text.
The conflict adds the base text, if any, and the latest applicable stored text,
if any. An applicable missing or non-text observation sets the existing
`loadError`, which explains why stored text is absent. A failed read supplies
no new stored version. Neither binary bytes nor a second copy of
local text belongs in the conflict. An overtaken read cannot create a conflict;
a refused storage comparison causes a current read. Autosave and flush skip the
conflicted path until the person or application resolves it.

**Conflict choices apply only to the reviewed local and stored versions.**
Accepting storage relinquishes the reviewed draft and follows a fresh read
after already admitted path commands; a failed read or newer typing keeps the
draft. Supplying chosen text accepts it as a new draft and publishes only over
the reviewed stored version. Deliberate removal of an open document checks
the reviewed stored version and clears only the reviewed local input on
success. Later typing survives as a draft against a missing file. A one-shot
raw deletion never discards local text.

## Consequences

Editing surfaces, including a table cell or compact card, must show held text
and a usable whole-file conflict choice. They do not need field-level merge or
binary editing state. The Folder still needs path ordering, captured text
identity, autosave timing, ordered reads, and checked publication for documents.
It no longer needs raw commands to capture or acknowledge a document's intent.
Cached interpreted Markdown fields may still need runtime immutability; this
decision does not remove that separate snapshot guarantee.

Raw calls keep their current simple shape. A Messages receipt replacement,
binary copy, and file deletion need no prior-content argument. That also means
a raw write can replace another writer's content, and a raw delete after a
confirmation dialog can remove a file changed while the dialog was open.
Creation commands may still overwrite a name created between a list check and
the write. A separate create-only operation could protect that case without
making every one-shot operation conditional.

The comparison protects against cooperating Folder handles. A native outside
process may race a read and replacement unless the filesystem offers an atomic
compare operation. The API must not promise a cross-process transaction that
the native storage engine cannot provide.

## Considered alternatives

- **Check every raw write and delete against prior content.** This would also
  protect the caller's decision window, but it requires a prior read and
  comparison argument for every one-shot replacement and deletion, including
  binary files. The retained-document guarantee does not depend on it.
- **Make every raw write create-only by default.** This changes the meaning of
  the existing `write` command and forces receipt updates and file maintenance
  through another path. An explicit create operation can be added where name
  collision matters.
- **Keep document saves unconditional.** A delayed autosave or later retry can
  silently overwrite an outside edit that arrived after the document's read.
- **Refuse raw commands while a document is dirty.** Typing can begin while a
  command waits in the lane, so refusal still needs an execution-time check
  and the same conflict model. It blocks a rename that first copies a draft
  and then intentionally removes the old path.
- **Retain binary and deletion drafts in the document.** Binary copy and
  removal would inherit autosave, retry, snapshot, and conflict behavior that
  current callers do not use.

# 0686. Folder publications name the file content they replace

- **Status:** Proposed
- **Date:** 2026-10-23
- **Supersedes:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md),
  unconditional local publication and acknowledgement by raw commands.
- **Amends:** [ADR-0676](0676-structured-edits-share-the-acquired-working-document.md)
  at complete row publication; its acquired-document boundary remains.
- **Unbuilt:** Checked publication in both storage engines, create-only complete
  writes, document conflicts and resolution, and caller migration. Current
  Folder writes remain unconditional.

## Context

`files.document(path)` and `tables.<name>.document(id)` share a Folder-owned
working source. They keep accepted text through component unmount and failed
saves. A path lane orders their saves with `files.write`, `files.delete`, and
`tables.<name>.write`. Today every publication is unconditional. A successful
raw command can acknowledge a text draft it did not publish; another Folder
handle or outside program can change a file between observation and save, and
the save can overwrite that change without notice.

The uses of these commands have different lifetimes. Document edits retain text
for autosave and retry. File commands copy or create bytes, delete files, or
record one-shot text such as a send receipt. Complete table writes mostly
create a new row. Binary files are copied and removed, but are not edited as
retained working documents. A `.md` suffix does not determine the lifetime:
a receipt is one-shot text, while a document can encounter binary content at
its path.

## Decision

**Every local Folder publication names the stored content it replaces.** A
document save uses the stored content on which its accepted text was based.
`files.write`, `files.delete`, `tables.<name>.write`, and
`tables.<name>.delete` use an explicit expected prior content when replacing
or deleting a file. A complete write without that expectation creates only
when the path is absent. The storage engine compares at publication, including
on a browser repository retry; a prior read or list check alone is insufficient.
If the path already holds the
desired content, the publication succeeds without another write, including
after a reply was lost. Otherwise, a mismatch refuses without changing the
stored file. This rule covers local Folder operations; Git synchronization
keeps its separate history merge contract.

**A working document retains only text and never accepts a raw command as its
own input.** Its accepted text is visible immediately. Autosave and an awaited
`save` submit exact captured text in path order; a successful receipt clears
only the captured input, so later typing stays pending. Its awaited result
identifies that captured Markdown content, even if an observer changed the
document before the result arrived. When that input lands, later text composed
over it advances its comparison base to the landed text. A failed storage
attempt retains the text for retry. A raw file or table command carries only
its own operation and returns its own outcome. It neither clears a document
draft nor installs a binary payload as document content. A successful raw
command at a dirty document's path changes the observed stored side and leaves
the draft in conflict. It is not refused merely because that draft exists.
Without a draft, the document follows the latest applicable observation;
a missing file or binary replacement does not leave old text presented as
current.

**A changed stored file pauses publication of the affected text draft.** A
document compares the latest applicable stored observation with the version on
which its draft is based. Text accepted before acquisition is held while the
document reads; it creates an absent file or conflicts with an existing one.
A failed read retains the text and permits no publication. A differing text,
missing file, or binary replacement appears as a conflict. The document
exposes the base text, current local text, and current stored text or its
missing/binary kind. It retains no binary draft or binary bytes in the
conflict snapshot. An overtaken read cannot manufacture
a conflict; a storage refusal triggers a current read before reporting one.
Autosave and flush skip a conflicted path until the conflict is resolved.

**Conflict choices act on the reviewed local and stored versions.** Accepting
the stored side gives up only the reviewed local draft and follows a fresh read
after already admitted path publications; a failed read or newer typing keeps
that draft. Supplying chosen text, whether
the local text or a manual merge, accepts it as a new draft and publishes it
only over the reviewed stored version. Deleting a reviewed document is a
document action that checks the stored version and clears only the reviewed
local input on success. Later typing survives as a draft against a missing
file. Raw deletion of an unopened or binary file uses its own expected stored
content and never discards local text.

## Consequences

An editor must show a held draft and a usable whole-file conflict choice,
including for a table cell or compact card. No field-level or automatic merge
is promised. A file created by another writer between a name check and a
complete write is preserved. One-shot replacements, including Messages
receipts and `.gitignore` maintenance, must supply the content they observed;
one-shot deletion needs an observed target. A raw command can succeed while a
same-path draft remains unsaved, so the application cannot treat its success
as proof that the editor is saved.

The Folder still needs a per-path lane, captured text identity, autosave timing,
ordered reads, and a storage comparison for each publication. It no longer
needs raw commands to capture, acknowledge, or adopt document input, nor a
retained binary editing state. A conflict is derived from the draft's base and
the latest applicable stored observation; it needs no second queue or replay
of structured patches. Cached interpreted Markdown fields may still need
runtime immutability; removing binary drafts does not by itself remove that
separate snapshot guarantee.

The comparison can protect against cooperating Folder handles. A native
outside process may race a read and replacement unless the filesystem offers
the same atomic compare operation. The API must not describe that narrower
native guarantee as a cross-process transaction.

## Considered alternatives

- **Unconditional last-write-wins.** It keeps the current smaller storage
  operation but can silently erase an outside edit and lets an unrelated raw
  success clear a retained draft.
- **Refuse raw commands while a document is dirty.** Typing can begin after a
  command enters the lane, so refusal still needs an execution-time check and
  the same conflict model. It also blocks a rename that first copies the draft
  and then intentionally removes the old path.
- **Keep raw writes unconditional and guard only documents.** The same path
  would again have two publication contracts; a raw replacement could erase
  an outside change without a reviewed expectation.
- **Retain binary and deletion drafts inside the document.** Binary copy and
  removal would inherit autosave, retry, snapshot, and conflict behavior that
  current callers do not use. One-shot file operations keep their payloads
  with their callers instead.

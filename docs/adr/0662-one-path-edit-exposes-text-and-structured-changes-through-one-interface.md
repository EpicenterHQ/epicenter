# 0662. One path edit exposes text and structured changes through one interface

- **Status:** Superseded
- **Date:** 2026-10-21
- **Superseded by:** [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md).
- **Amends:** [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md), the public row/text editor split. The folder still owns each path's input, saving and lifetime.
- **Implementation history:** The common-editor proposal was implemented, then its API was replaced by the retained-source snapshot in [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md). The proposal below preserves the earlier interface, including its now-withdrawn promise to retain invalid text. It is not the current API reference.

## Context

App forms use `RowEdit` to change fields and body. Source views use `TextEdit`
to replace whole text, but some also construct a row edit just to read schema
diagnostics. The generic Grid and Board use `TextEdit.changeFields()` to edit
arbitrary Markdown paths, including files outside declared tables.

These are views and operations over the same path-owned input. The split makes
callers choose editor types without giving them different ownership or saving
guarantees. Generic document lists already read the source, but the edit owner
does not necessarily keep those reads, so Grid also reconstructs held fields
over its listed document.

## Decision

**One editor interface addresses one file path and accepts structured changes
or whole-file text replacement.**

The common API is:

```ts
const fileEdit = folder.files.edit('notes/one.md');
fileEdit.change({ fields: { title: 'Hello' } });
fileEdit.change({ body: 'Some writing' });
fileEdit.replaceText(nextWholeFileText);
await fileEdit.save();

folder.tables.notes.list();
const noteEdit = folder.tables.notes.edit('one');
noteEdit.change({ fields: { title: 'Typed through the notes schema' } });
```

The table accessor binds the path and schema and returns the same editor
interface with schema-typed fields. It adds no input owner or save queue.
Collection operations remain spelled directly as `folder.tables.notes.list()`
and `folder.tables.notes.edit(id)`; do not alias the collection namespace.
Whether collection binding belongs at
folder opening or afterwards is outside this decision.

**The editor exposes exact text and a structured interpretation as separate,
pure reads.**

`getText()` answers current editable text without Markdown parsing or schema
validation. `getMarkdown()` interprets that same text through the bound schema,
including applicable unsaved changes. It answers a stable snapshot containing
only:

```ts
type MarkdownContent<TFields = Record<string, unknown>> = {
  text: string;
} & (
  | { body: string; fields: TFields; issues: null }
  | { body: string; fields: Record<string, unknown>; issues: Issue[] }
  | { body: string | undefined; fields: undefined; issues: Issue[] }
);
```

`MarkdownContent` is a value snapshot with no independent identity or lifecycle.
`FileEdit` is the editing capability and keeps the path.

The snapshot keeps source and body from the same version, which
callers need when translating body offsets to source offsets. It does not copy
the handle's path, a row ID, directory, filename stem or raw bytes. Those remain
with the address, collection or file-reading operation that needs them.

Whenever `getMarkdown()` returns a snapshot, its `text` equals `getText()` for
that version. Fields and body reflect that text. A syntax error preserves exact text and
diagnostics and exposes a body only when its closing fence is known; a schema
error preserves actual parsed field values. Accepted text with NUL or a lone
surrogate remains exact even though storage refuses it: the snapshot has a
`not-text` issue and unavailable body and fields. Only `issues === null`
narrows fields to the bound schema.

Without usable text, both reads answer `undefined`; read status distinguishes
unread, missing and non-text files. Held whole text remains readable and
interpretable when the stored file disappears. A structured change that cannot
be represented in source is refused before acceptance. Failed reads keep the
last usable view. Neither getter initiates I/O. Document parsing is lazy and
cached; snapshot identity holds until its text, schema or diagnostics change.

**Each remaining method exposes a distinct operation or observable fact.**

| Member | Contract |
| --- | --- |
| `path` | The fixed root-relative address. |
| `getText()` | Current exact editable text, without parsing. |
| `getMarkdown()` | Current fields, body, exact source and diagnostics. |
| `getPending()` | The exact unsaved source, save progress and failure, or `undefined`. |
| `getReadStatus()` | What is known of storage, whether reading runs, and the last read failure. |
| `isLocked()` | Whether an exclusive action or closing refuses new input. Saving alone does not lock typing. |
| `change({ fields?, body? })` | Apply the named field assignments and/or replace the body, preserving changes to unnamed units. Returns acceptance or refusal as `ChangeResult`. |
| `replaceText(text)` | Replace the current local source; later structured changes apply to it. Returns acceptance or refusal as `ChangeResult`. |
| `read()` | Read storage explicitly; answer `Result<void, ReadError>` after updating the editor. Call a getter for the desired projection. |
| `subscribe(listener)` | Notify imperative readers and framework adapters of changes; return the stop function. |
| `save()` | Attempt held input, previous failures included, or join its running save. The same failed input does not loop on its own. |
| `resolveConflict(choice)` | Accept the current source or guard an explicit whole-source resolution against the last reported conflict. |
| `discard()` | Explicitly release held input, returning it for copying; refuse during a save or exclusive action. |
| `delete()` | Fence the path, save held input, then conditionally delete the file. |

There is no `changeFields()`, `changeBody()`, editor `retry()`, last-read source
token, or separate row/text editor lifecycle.

**Framework adapters track reads without introducing another document owner.**

One Svelte adapter accepts the core editor and exposes tracked `.text`,
`.markdown`, `.pending`, `.readStatus` and `.locked` getters. Commands remain
methods. A React adapter keeps explicit read methods over committed-render
snapshots. Commands apply to the live source in call order; a later body or
whole-source replacement determines that source rather than merging handlers.
Adapters are recreated only when their bound address or interpretation changes.

## Consequences

Source views can read text and schema diagnostics from one editor. Generic Grid
and Board use the same structured-change command as app forms. Document list
reads must populate the path owner through its ordered-read mechanism; controls
do not call a separate `seed()` or coordinate a save-and-refresh handshake.

The source draft has no document/text pending distinction. It retains submitted
versions, saving status and exclusive-operation guards. A closed malformed
header still has a known body, while an unclosed header refuses a structured
body change. A file without an opening fence has empty fields and its prose
as body under the common Markdown framing rule.

Source-only readers retain a method that overlaps `markdown.text`. That overlap
avoids parsing and validating Markdown for every source-only read, including
plain-text and configuration files. Structured readers retain one shared parser
and stable snapshots rather than rebuilding those in each UI.

## Migration questions outside the frozen surface

- How structured operations on non-Markdown paths are refused or scoped.
- How the source conflict resolver presents a held draft against a changed or
  deleted stored file, including recovery during folder close.

## Considered alternatives

- **Keep separate row, generic-document and text editors.** Their read
  interpretations differ, but the commands and ownership do not. A third editor
  interface and adapter add another choice without a new capability.
- **Only expose text and make controls parse it.** This repeats schema binding,
  snapshot caching and recovery interpretation in consumers.
- **Only expose a structured document.** Source-only controls would pay for
  Markdown parsing and schema validation they do not use.
- **Combine every read into `getState()`.** This hides independently changing
  facts and either forces parsing or introduces lazy nested APIs. It does not
  remove the underlying responsibilities.
- **Restrict Grid to declared tables.** This removes existing root, nested and
  undeclared Markdown editing to fit the old API. The common path editor makes
  that feature loss unnecessary.

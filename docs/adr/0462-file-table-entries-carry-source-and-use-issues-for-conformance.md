# 0462. File table entries carry source and use issues for conformance

- **Status:** Proposed
- **Date:** 2026-09-29
- **Implementation:** source-backed entries, captured versions, readable malformed rows, and issue reporting in `@epicenter/app/files` and Todos.
- **Unbuilt:** migration of released applications to file-backed table reads.

## Context

A Markdown row still exists when its frontmatter is malformed or a declared field
fails validation. Splitting table reads into valid rows and a separate invalid
inventory makes applications reconstruct that fact when they list, select, and
repair documents. Returning only a validation error loses the exact file the
person or agent needs to edit.

The current Yjs-backed table API returns value snapshots and reports
nonconformance through its own read results. This record concerns the proposed
file-backed table API, whose saved Markdown is the source. It does not change
the Yjs read contract.

## Decision

Table methods live under `folder.tables.<table>` alongside literal-path access
through `folder.files`, as specified in
[ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md).
`get(stem)` takes the file stem under
[ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md):
`folder.tables.recordings.get('interview')` reads `recordings/interview.md`.
An entry's `stem` is derived from that filename, while its `path` includes the
table directory and `.md`. Neither is an authored frontmatter field.

**`list()` and `get(stem)` return the same source-backed entry shape for a readable
Markdown file, whether or not its declared fields conform.** Every entry carries
its path. An entry has no usable stem when its filename cannot supply a valid one;
`list()` still returns it for path-based selection and source repair. Removing
the exact lowercase `.md` suffix yields the complete literal stem. No case
folding, Unicode normalization, or filename alias maps distinct files to one
stem. Exact stems therefore need no duplicate-ID inventory or resolution API.
Case-sensitive filesystems can contain `Interview.md` and `interview.md` as
distinct rows; a destination that cannot represent both refuses the collision.
Lookup verifies literal directory-entry spelling rather than inheriting a
case-insensitive filesystem's aliases. A file ending in `.MD` is preserved by
raw file access, but is neither a `.md` row nor an owned attachment.
`get(stem)` returns `undefined` only when no row has that literal stem. A present file
that cannot be fully interpreted remains an entry with exact `source` and
conformance issues. An I/O failure to read the file is an operation failure,
not an entry issue. After successful path enumeration, the file boundary
reports an individual failed read by path rather than hiding that path. If
enumeration itself fails, `list()` refuses the operation instead of returning
an empty table.

**The value of `issues` discriminates the two entry variants; no separate
`status` field or nested `parsed` result is added.** The valid variant has a
valid stem, `issues: undefined`, complete `fields`, and a body. The invalid
variant has a nonempty `issues` array, a usable stem only if its filename yields one,
only independently validated declared fields, and a body when its boundary can
be identified. Invalid filenames and ambiguous attachments contribute issues even
when every declared field validates. Both variants keep the unmodified source
for repair.

Unknown frontmatter keys are preserved in `source` and do not contribute
conformance issues merely because the current declaration omits them. Several
same-stem attachment candidates contribute an attachment issue and leave
`attachment` undefined; the entry does not choose one.

**An entry is one immutable observation of its row file.** Its `source` and
`version` come from the same captured bytes. `version` is content identity:
SHA-256 plus byte length. A table write receives the whole entry; UI callers
do not separately fetch or assemble a version token. The publisher still
checks the current file because another writer may have changed it.

An entry is already a snapshot. An editor calls the entry it last accepted its
baseline; that role adds no wrapper or second value type. `fields` and `body`
are interpretations of `source`, not independently saved data. The optional
`attachment` is the folder-relative path of the one unambiguous owned sibling.
Listing or reading a row does not hash its media. The path does not promise
that its bytes remain current or available. `files.open(path)` supplies stable
media bytes under ADR-0466 without requiring a hash or returning a media version.
The workflow consumes those bytes independently of later changes to the row.

```ts
type Entry<TFields> = {
  readonly path: string;
  readonly version: { readonly sha256: string; readonly size: number };
  readonly source: string;
  readonly attachment: string | undefined;
} & (
  | {
      readonly stem: string;
      readonly fields: Readonly<TFields>;
      readonly body: string;
      readonly issues: undefined;
    }
  | {
      readonly stem: string | undefined;
      readonly fields: Readonly<Partial<TFields>>;
      readonly body: string | undefined;
      readonly issues: readonly [Issue, ...Issue[]];
    }
);

const result = await table.get(stem);
if (result.error) return showReadFailure(result.error);
const entry = result.data;
if (entry === undefined) return;
if (entry.issues !== undefined) {
  showRepairView(entry.source, entry.issues, entry.fields);
} else {
  showDocument(entry.fields, entry.body);
}
```

`get` returns a Result containing an entry or `undefined`, with typed file and
table read failures. Absence is the successful result's `undefined`, not a
validation failure. `list` returns `{ entries, unreadable }`; individually
unreadable paths carry their read failure and do not hide readable entries.
The package README and `FileTable` type name the current error variants.

`issues` is `undefined` or a nonempty array, never `null` or `[]`.
`issues: undefined` means the property value is the discriminant. It does not
promise that the key is absent from the JavaScript object. The producer returns
a nonempty issue list whenever the entry is invalid, so callers never have to
infer validity from an empty array.
Serialization may omit an undefined key; callers check its value rather than
the physical presence of the key. Entries and file references are plain captured
data, not resource handles. Their source and diagnostics remain readable after
the folder closes; further operations through that folder refuse.

Exact UTF-8 source includes a leading byte-order mark when one was present.
Decoding and re-encoding an unchanged `source` must reproduce the captured
bytes. A file that is not valid UTF-8 has no source-backed entry; enumeration
reports its path as unreadable by the text interpretation, while raw file
access preserves the bytes. It must never become an editable empty string.

## Consequences

- A table has one inventory of source-backed entries for files it can read.
  Applications can derive valid and repair-needed groups without a second
  public `invalid` collection. Paths whose bytes cannot be read remain file
  boundary diagnostics.
- Callers retain one entry as the baseline and replace it only with an
  accepted save result or a deliberately adopted read. A newer read cannot
  silently authorize overwriting source while the editor has unsaved input.
- Literal stems give each row one address without ID normalization or duplicate
  identity repair. An invalid filename is selected by path because it has no
  usable stem. Destination filesystem collisions remain publication checks.
- Callers migrating from the Yjs `get(id)` contract distinguish an absent stem,
  an operational refusal, and a present entry whose action inputs are unusable.
  Honeycrisp selection needs a path-based source repair route; Whispering audio
  and transcription need only their actual validated inputs, not whole-row
  conformance.
- An unrelated bad field does not hide independently valid fields. An
  application can use those fields for a limited action while still showing the
  issue and preserving the exact source.
- An unavailable relation field cannot prove that a file is unrelated to a
  folder. A folder deletion that promises to reparent every child must refuse
  while such files remain unresolved, or narrow that promise explicitly.
- Malformed frontmatter may leave no validated fields, and ambiguous
  frontmatter framing may leave no usable body. The entry remains selectable
  and editable through `source`.
- An operation may rely only on fields it read and validated. It may replace an
  invalid old field with a new value that validates, provided the edit preserves
  unrelated source and conditionally replaces the observed file. Serializing
  `Partial<TFields>` as the whole document would discard stored facts.
- Conforming fields do not prove that a rich editor can safely rewrite the
  Markdown body or preserve YAML formatting. Body interpretation and edit
  admission belong to the editor; the table keeps the source available.

## Considered alternatives

- Return valid rows and invalid documents in separate inventories. Callers
  need two paths for selection and must rejoin them for repair workflows.
- Nest `{ value } | { issues }` under `parsed`. It adds a wrapper without
  preserving more information than the source-backed entry provides.
- Discriminate on the physical presence of the `issues` key. An explicit
  `undefined` value gives TypeScript callers a direct narrowing check and
  avoids a second runtime convention about whether the key was emitted.

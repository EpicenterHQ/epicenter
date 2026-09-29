# 0462. File table entries carry source and use issues for conformance

- **Status:** Proposed
- **Date:** 2026-09-29
- **Unbuilt:** the file-backed table read API and its application callers.

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

**`list()` and `get(id)` return the same source-backed entry shape for a readable
Markdown file, whether or not its declared fields conform.** Every entry carries
its path. An entry has no ID when its filename cannot supply a valid one;
`list()` still returns it for path-based selection and source repair. If two
files claim one ID, `list()` returns both with an identity issue on each entry,
and `get(id)` refuses to choose one.
`get(id)` returns `undefined` only when no file claims that ID. A present file
that cannot be fully interpreted remains an entry with exact `source` and
conformance issues. An I/O failure to read the file is an operation failure,
not an entry issue. After successful path enumeration, the file boundary
reports an individual failed read by path rather than hiding that path. If
enumeration itself fails, `list()` refuses the operation instead of returning
an empty table.

**The value of `issues` discriminates the two entry variants; no separate
`status` field or nested `parsed` result is added.** The valid variant has a
valid ID, `issues: undefined`, complete `fields`, and a body. The invalid
variant has a nonempty `issues` array, an ID only if its filename yields one,
only independently validated declared fields, and a body when its boundary can
be identified. Invalid filenames and duplicate IDs contribute issues even
when every declared field validates. Both variants keep the unmodified source
for repair. A clean entry describes one observed file set; ID-based writes
still recheck identity and conditional replacement because another writer may
change that set.

```ts
type Entry<TFields> = {
  path: string;
  source: string;
} & (
  | {
      id: string;
      fields: TFields;
      body: string;
      issues: undefined;
    }
  | {
      id: string | undefined;
      fields: Partial<TFields>;
      body: string | undefined;
      issues: readonly [Issue, ...Issue[]];
    }
);

const entry = await table.get(id);
if (entry === undefined) return;
if (entry.issues !== undefined) {
  showRepairView(entry.source, entry.issues, entry.fields);
} else {
  showDocument(entry.fields, entry.body);
}
```

`issues: undefined` means the property value is the discriminant. It does not
promise that the key is absent from the JavaScript object. The producer returns
a nonempty issue list whenever the entry is invalid, so callers never have to
infer validity from an empty array.

## Consequences

- A table has one inventory of source-backed entries for files it can read.
  Applications can derive valid and repair-needed groups without a second
  public `invalid` collection. Paths whose bytes cannot be read remain file
  boundary diagnostics.
- Duplicate IDs remain distinct entries by path in `list()`. ID-based actions
  refuse the ambiguity until the files are repaired. An invalid filename is
  selected by path because it has no row ID.
- Callers migrating from the Yjs `get(id)` contract distinguish an absent ID,
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

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
Markdown row, whether or not its declared fields conform.** Every entry carries
its path, so `list()` keeps both files visible if they claim the same ID.
`get(id)` returns `undefined` only when no file claims that ID; it refuses an
ambiguous ID rather than choosing a file. A present file that cannot be fully
interpreted remains an entry with exact `source` and conformance issues. An
I/O failure to read the file is an operation failure, not an entry issue.

**The value of `issues` discriminates the two entry variants; no separate
`status` field or nested `parsed` result is added.** The valid variant has
`issues: undefined`, complete `fields`, and a body. The invalid variant has a
nonempty `issues` array, only independently validated declared fields, and a
body when its boundary can be identified. Both variants keep the unmodified
source for repair.

```ts
type Entry<TFields> = {
  id: string;
  path: string;
  source: string;
} & (
  | {
      fields: TFields;
      body: string;
      issues: undefined;
    }
  | {
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

- A table has one inventory of entries. Applications can derive valid and
  repair-needed groups without a second public `invalid` collection.
- Duplicate IDs remain distinct entries by path in `list()`. ID-based actions
  refuse the ambiguity until the files are repaired.
- An unrelated bad field does not hide independently valid fields. An
  application can use those fields for a limited action while still showing the
  issue and preserving the exact source.
- Malformed frontmatter may leave no validated fields, and ambiguous
  frontmatter framing may leave no usable body. The entry remains selectable
  and editable through `source`.
- Structured edits may use only fields the reader actually validated. The
  entry shape does not authorize an application to overwrite malformed or
  unknown source from a partial interpretation.

## Considered alternatives

- Return valid rows and invalid documents in separate inventories. Callers
  need two paths for selection and must rejoin them for repair workflows.
- Nest `{ value } | { issues }` under `parsed`. It adds a wrapper without
  preserving more information than the source-backed entry provides.
- Discriminate on the physical presence of the `issues` key. An explicit
  `undefined` value gives TypeScript callers a direct narrowing check and
  avoids a second runtime convention about whether the key was emitted.

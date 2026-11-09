# 0129. Matter and Workspace share fields, not authority policy

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which deletes Matter.
- **Date:** 2026-07-15
- **Relates:** [ADR-0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md), [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md), [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)

## Context

Matter vaults and application workspaces both need recognizable field values,
typed editors, diagnostics, and SQL reads. Treating that shared vocabulary as
one authority model would require bidirectional Markdown and record sync,
rename inference, writable projections, and one completeness policy for two
different sources.

## Decision

Matter and Workspace share exactly one `@epicenter/field` vocabulary and one
present-value validator. A field kind, refinement, editor, and SQLite storage
shape mean the same thing in both substrates. Neither substrate implements a
second parser for whether a present value inhabits a field domain.

They intentionally do not share authority or row-completeness policy.

Matter is user-shaped and Markdown-authoritative. Its optional folder-level
`matter.json` is a lens over files. The existing top-level `optional` list drives
missing-required diagnostics because users hand-edit keys. Matter treats absent
frontmatter and explicit YAML null as the same missing cell. Its SQLite mirror
is disposable and read-only, and it keeps invalid values visible for diagnosis.

Workspace is application-shaped and canonical-JSON-authoritative. Its
TypeScript definition is a release-local lens over schema-opaque records. It
uses the same lens-level `optional` list, but JSON null remains a present value
only when `nullable(...)` admits it. Typed reads separate conforming and
nonconforming rows. Connection-local SQLite views are disposable read
projections, never validation or write authorities.

The two sources never synchronize each other bidirectionally. A future combined
query may read both, but it cannot erase their authority boundary or create a
cross-source transaction.

## Consequences

- `field.*` remains about present values. Optionality, nullish behavior, and row
  diagnostics remain substrate policy.
- A date, boolean, select, reference, or JSON value validates identically in
  Matter and Workspace.
- Matter users may let structure emerge in files before declaring it. Workspace
  developers may change release-local lenses without migrating canonical data.
- Both SQL surfaces are projections rather than verdict sources. Invalid source
  data remains inspectable instead of being coerced or silently healed.
- A field reference is advisory. It creates no foreign key, cascade, inverse
  relationship, cross-source link authority, or generic repair engine.

## Considered alternatives

- **Use one completeness policy.** Rejected because YAML null and application
  JSON null carry different honest substrate meaning.
- **Give Matter Workspace's record authority.** Rejected because exploratory
  files would become application synchronization commands.
- **Make Markdown the portable writable form of every Workspace.** Rejected
  because filenames, frontmatter, and file deletion would become a second
  application protocol.
- **Keep separate field validators.** Rejected because one vocabulary with two
  verdict implementations would drift into two dialects.

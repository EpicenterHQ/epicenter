# 0420. Epicenter working copies use the Matter file contract

- **Status:** Proposed
- **Date:** 2026-09-21
- **Unbuilt:** Faithful store-to-Matter schema mapping, generated per-table contracts on Pull, checkout-aware editing restrictions in Matter, root KV schema representation, and shared working-copy indexing integration.

## Context

Matter describes table folders using `matter.json`, reads rows from Markdown
frontmatter and bodies, and derives a disposable SQLite query index. Epicenter's
working-copy direction also uses Markdown rows and read-only SQL. Maintaining
two file contracts would duplicate schema interpretation, validation, and query
mapping while making the same folder behave differently in different tools.

The existing implementations are not interchangeable. In
`packages/matter-core/src/core/contract.ts`, optionality is folder policy and
nullable schema wrappers become untyped. Epicenter store definitions include
nullable fields. Matter also permits body editing, whereas the agreed agent
Push path refuses it. Root `kv.json` needs a schema representation that table
folders alone do not provide.

## Decision

**An Epicenter working copy uses Matter's typed Markdown format.**

Each table carries its own `matter.json`. The root groups tables and contains
KV and Epicenter working-copy metadata; it does not repeat all table schemas.

```text
working-copy/
  recordings/
    matter.json
    <recording-id>.md
  folders/
    matter.json
    <folder-id>.md
  kv.json
  <Epicenter destination and baseline metadata>
  <optional disposable query index>
```

Angle-bracket entries describe roles, not newly specified filenames. Opening a
table folder is sufficient to interpret its fields. Cross-table references can
still require the containing workspace. Copying a table folder alone does not
transfer Epicenter destination identity or make it independently pushable.

**The shared format does not imply shared authority.**

In standalone Matter, files are authoritative. Matter and ordinary editors
write them, and its grid and SQL index follow them. No account or Push baseline
is required.

In an Epicenter checkout, the live store remains authoritative for synchronized
application data. Pull materializes files and a comparison baseline. File edits
are prepared changes until Push validates and submits permitted field differences
through the running store owner. There is no automatic filesystem-to-store sync.

**Pull generates the file schema from the application definition.**

Generated `matter.json` describes the serialized fields without importing app
code. It does not serialize content codecs, transports, credentials, or live
resources. The running owner validates Push against its own mutation contract;
editing local schema or editing-policy metadata cannot grant additional writes.
Modified generated contracts must be reported and refused rather than adopted
as store migrations. Standalone Matter schemas remain user-authored.

The app developer owns its definition. Pull obtains the portable schema from
the definition used by the running owner; a server catalog is not required.
A catalog may publish that definition without becoming a second schema authority.
Changing an app definition requires an explicit release and data-upgrade policy;
editing a checkout does not change the definition understood by an existing app.

Removing a generated contract or checkout metadata does not turn a submission
into an unrestricted import. A checkout with a missing destination or baseline
cannot Push. Application schema changes must not silently reinterpret prepared
edits: incompatible submissions refuse while preserving files. Updating the
checkout schema belongs to an explicit working-copy operation.

Within a checkout, `<table>/<row-id>.md` maps to the declared table and immutable
row ID. Renaming a file does not rename the record. Matter's reserved names,
including query columns such as `body`, require explicit collision handling;
schema export must not overwrite a user field or silently change its identity.

**Declared nullable fields have one empty value and two file spellings.**

A complete typed record represents an empty nullable field as `null`. Canonical
Markdown omits that key. Reading a declared nullable field accepts an absent key,
explicit YAML null, or a bare `key:` as the same empty value. Missing or null
non-nullable fields fail validation. Empty strings, zero, and false remain
values subject to their field constraints. `undefined` is not a persisted field
value. Top-level field null always means empty, including for JSON fields;
nested JSON nulls remain ordinary data.

Push normalizes the files and baseline under the same checkout contract before
comparison. Removing a populated nullable key submits a clear. Leaving an empty
key absent submits nothing, even if the live store has since acquired a value.
Replacing explicit null with omission changes formatting only. In an internal
update patch, an omitted property still means no edit and explicit null clears.

Strict parsing precedes normalization so malformed syntax cannot become a
clearing instruction. Schema drift must not turn fields absent from an older
checkout into edits. This boundary completes sparse file records; it does not
silently repair incomplete persisted rows or reinterpret unknown fields.

The shared field model has one emptiness policy rather than independent
optional and nullable choices. Its serialized schema encoding remains to be
implemented. Preserve field types and supported constraints; unsupported fields
must be diagnosed rather than silently downgraded to claim compatibility.
Root KV needs one explicit schema representation and absence policy; this
record does not infer key deletion from the nullable row-field rule or invent a
second table schema registry.

**Matter tooling respects checkout editing restrictions.**

Epicenter checkout bodies are readable context. Matter must expose their
read-only status, and Push rejects any body change before applying a submission,
regardless of the editor used. Protected fields are likewise not made writable
by appearing in frontmatter. Standalone Matter keeps its own body-editing
capability. Creation and deletion in Epicenter checkouts remain outside the
settled field-update contract until separately specified.

**SQL indexes are derived reads, never another authoring format.**

Reuse Matter's file interpretation and index-building machinery for working-copy
queries rather than build an Epicenter-specific Markdown query engine. An index
maps rows to stable IDs and file paths, reports invalid files, and states its
refresh point. Rebuilds do not modify files or Push baselines. Pull need not ship
a SQLite file; local tooling can derive it from the files and contracts.

The live application SQL projection follows the live store, not the working
folder. It can share value-to-SQL mapping where semantics match, but it has a
different source and lifecycle. Neither SQL view accepts user mutations or
participates in Push. Indexing remains optional.

**Scripts edit the same files as people and Matter.**

A trusted TypeScript script can use parsing and field-edit helpers to batch-edit
frontmatter or KV. It needs no persistent store handle or Yjs replica. Importing
`matter.json` supplies a schema value, not automatic static types for parsed
rows or arbitrary SQL results. Generated types are optional future tooling;
runtime validation remains necessary for externally edited files.

## Consequences

One typed-file contract serves standalone folders and Epicenter checkouts.
Destination identity, access, baseline advancement, and interrupted-Push recovery
remain Epicenter responsibilities. Matter does not become a synchronization
service, and filesystem writes do not become live store mutations.

Implement the schema mapping and checkout restrictions, then wire Pull and
field-only Push through the running owner with durable recovery. Reuse indexing
when a caller needs it. Native persistence migration, space membership, and
TypeScript code generation do not block the file workflow.

The composition is a target, not a statement that schema compatibility, body
restrictions, KV integration, or application wiring already ship. Existing data
and ongoing document-lineage work are not migrated by this record.

## Considered alternatives

- One root contract repeating every table schema: table folders lose their
  self-description and schemas gain a second location to maintain.
- A separate Epicenter Markdown format: duplicates parsing and indexing for
  folders intended to be opened by the same tools.
- Let edited checkout schemas redefine the store: turns descriptive local data
  into mutation authority and an implicit migration mechanism.
- Editable SQLite working copies: adds another authoring representation and
  diff contract where files already express the supported edits.
- Require application imports or generated TypeScript for every script: removes
  the portable-file benefit before a caller needs static typing.

## Verification

Prove nullable omission and explicit null normalize identically; removing a
populated nullable field clears it; unchanged absence submits no edit; omitted
patch properties remain untouched; missing required fields fail; schema drift
and malformed files cannot produce clears; opening a table folder retains its
schema; standalone Matter body edits remain supported;
checkout body and generated-contract edits refuse before any Push mutations;
index rebuilds leave files and baselines unchanged; and the same permitted file
edits produce the same Push changes regardless of which editor created them.

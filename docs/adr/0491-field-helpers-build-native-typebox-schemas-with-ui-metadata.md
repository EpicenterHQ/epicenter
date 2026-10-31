# 0491. Field helpers build native TypeBox schemas with UI metadata

- **Status:** Accepted
- **Date:** 2026-10-02
- **Amends:** [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md) at the refusal of inert JSON Schema `default` annotations. Initialization and recovery remain application-owned.
- **Amended by:** [ADR-0525](0525-a-field-is-plain-json-schema.md) at native callbacks: `Type.Refine`, `~guard`, and codecs are refused in fields, the frozen-copy protection is removed, and a prepared field is a JSON copy rather than a `Memory.Clone` snapshot.
- **Amended by:** [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at the three reads: `check` replaces `accepts`, `conformance`, and `inputIssues`, and a missing field is an issue only when it is required.

## Context

First-party App and Folder declarations need generic editors, and their values
need TypeBox validation, including nested payload schemas and native
refinements. A closed schema recognizer duplicated those checks and discarded
hidden constraints when a schema was copied as JSON.

An earlier draft of this record kept a helper-only field vocabulary: a hidden
provenance mark, refused at compile time when absent, and editor metadata that
repeated select options and nullability beside the schema. That made the hint a
gate on what could be stored, gave the schema and the metadata two places to
disagree, and put a refinement callback inside a helper, so a helper schema
did not survive JSON. No data or caller depended on it.

The first accepted form of this record made the native schema the field and
then wrapped it again where a storage read it. A compiled definition was a
second public shape beside the declaration: a field object holding the schema,
an eagerly resolved editor, and `check` and `issues` closures; a table object
holding a `Map` of those, a repeated `name`, and `conformance` and
`inputIssues` methods; and a definition holding a `Map` of tables. App then
re-typed that shape for its body codec. Every consumer learned two
vocabularies for one definition, and resolving the editor eagerly meant
running each field's validator on `null` while the definition was compiled.
This record is amended in place to the shape below.

## Decision

**A field declaration is any native `TSchema`.**
`FieldMap` in `4467140355:packages/definition/src/declaration.ts` takes one, as an object:
TypeBox's `TSchema` is an empty interface, so a primitive is excluded by type
and refused by `prepareData`. An
unannotated `Type.Object`, `Type.Enum`, `Type.Any`, or `Type.Refine` is a
field. Nothing records which function built a schema, and a schema read back
from JSON is admitted like any other. The schema alone decides whether a value
conforms.

**A prepared definition has the declared shape, and native schemas are public throughout.**
`prepareData` in `4467140355:packages/definition/src/prepare.ts` checks a declaration and
returns `{ id, title?, kv, tables }` again, with the type it was given: `kv` is
a record of native schemas by field name, and each table is `{ fields, body? }`.
`defineStore` and `defineFolder` return that prepared definition, and an opened
store's `definition` is the same object. There is no compiled field or table
type, no `Map`, and no name stored anywhere but a record key. Table and field
names cannot be integers, so a record keeps its declaration order. `kv`,
`tables`, and each `fields` are frozen records without a prototype, so a name
such as `constructor` is an ordinary entry and a name the definition lacks
reads as `undefined`. A storage threads a table's name from its key.

**`x-field` is an optional, serialized editor hint that validates nothing.**
It holds a `kind`, and a reference additionally holds its `target` table.
`fieldEditorOf(schema)` in `4467140355:packages/definition/src/field/editor.ts` reads the
editor a schema asks for: `{ kind }`, plus `options` for a select and `target`
for a reference. It is a pure reader of keywords: it keeps no state, runs no
validator, and takes any schema, prepared or not. It is exported because its
reader is in another package: App's checkout guide prints each field's editor,
and a generic editor reads the same vocabulary. Options are the schema's
declared `enum` or `items.enum`; other keywords and native refinements may
narrow what the check admits, and nothing filters the list by running them.

**Whether a field admits `null` is asked of its check, where the answer is used.**
It is `accepts(schema, null)` on the prepared field, and it is not part of the
editor. It is not inferred from keywords: `Type.Any()` names no `null` and
admits one, a refinement over a union with `null` can refuse it, and a
validator that throws on `null` does not admit it. Preparation validates no
value, so it probes nothing and runs no callback. A stored `null` a field does
not admit fails where it is read. A failure to compile the native schema
remains a definition error.

**Only a plain union with `null` is read through.**
A union of exactly `{ type: 'null' }` and one other schema, with only
annotations beside its `anyOf`, takes its other member's hint when it has no
`x-field` of its own. That is what `field.nullable` builds. A union with its own
`x-field` uses that one, and an unusable one is not replaced by the member's.

**A hint that cannot be honored resolves to the JSON editor.**
That covers a schema with no hint, an unknown kind, a malformed hint, a
reference target that is not a usable table name, and a hint naming a widget
whose shape the schema does not have. The shape checks ask a keyword or two of
one schema node and err toward JSON: a node with a composition keyword
(`anyOf`, `allOf`, `oneOf`, `not`, `if`, `then`, `else`, `$ref`) and a string
`enum` beside a non-string `type` both get the JSON editor. A formatted kind
also needs a compatible `format`: `uri` for `url`, `date` for `date`, and
`date-time` for `instant` and `datetime`, the formats the helpers set. A string
schema that declares that format, or none, fits; one that declares another
(`format: 'email'` under a `date` hint) gets the JSON editor. `string` and
`reference` name no format. They are not a schema recognizer, none asks whether
a schema can be satisfied, and no editor is guessed for a schema without a
hint.

**`field.*` helpers add portable keywords and editor hints to native schemas.**
Helpers introduce no refinement callback or codec. Keyword-based constraints
and hints survive `JSON.stringify` and `JSON.parse`; native callbacks supplied
as inputs remain local. `field.json(inner)` is a copy
of `inner` with the JSON hint. `field.nullable(inner)` is
`Type.Union([inner, Type.Null()])` over any native schema. Helpers keep their
narrow option guards, so an option cannot replace a `type`, a `format`, or the
hint. There is no `maxBytes` option.

**One JSON-safety check runs before native validation, for every field.**
Every read holds a value to `isJsonSafe` before the compiled validator sees
it, in `accepts`, `conformance`, and `inputIssues`. The check
refuses non-JSON values and cycles and sets no depth or width limit. Folder KV
keeps its separate budget; frontmatter imposes no fixed depth or width budget.
A value that is JSON gets TypeBox's own errors and paths. A native validator
exception fails only that field with `schema validation threw`, so sibling
fields and source remain readable.

**Three reads over prepared fields share one validator and one diagnostic.**
`accepts(schema, value)` is the only decision about a value.
`conformance(fields, payload)` reads a stored payload: every declared field is
required and checked by itself, valid siblings are returned as the payload's
own objects, and an undeclared key is ignored. `inputIssues(fields, values,
{ complete })` checks supplied values: an undeclared key is an issue, and a
complete row must have every declared field. A key supplied as `undefined` is
a value that is not JSON; an absent key is missing. Both report structured
`{ field, path?, message }` issues from one private per-field diagnostic, so
there is no public per-field diagnostics function, no second string-only error
list, and no parallel table of validators. TypeBox's compiled `Check` decides
validity. `Errors` describes a failure and may be capped or empty, so a value
`Check` refuses is always at least one issue.

**Which reads a storage runs on a write is that storage's rule.**
This record adds no enforcement. App checks names and that a value is JSON
when it writes, and reads through `conformance`. Folder checks supplied values
with `inputIssues` before it writes a file.

**Validation reads a value and never writes it, native callbacks included.**
TypeBox calls a `Type.Refine` callback and a `~guard` with the value being
validated, and a callback that wrote to it changed the caller's source and
could make a conforming value stop being JSON. The schema snapshot walk
records whether a field holds a function or a `~guard`. Such a field validates
a private, deeply frozen copy; a field of keywords alone, which is every
unrefined helper, reads the value in place and copies nothing. The copy is
iterative, so depth stays unlimited, and it keeps null prototypes, an own
`__proto__` key, arrays, and shared nodes. A class instance that is not an
array is refused rather than flattened, and a cycle is refused before any
validator runs. An array subclass passes `Array.isArray`, as it does in
`isJsonSafe`, and its copy is a plain array. The caller's value is never
frozen. A refused write throws in strict code and fails that field like any
other throwing callback.

The guarantee is about the argument a callback is given, and only that. A
callback is a deterministic predicate over content. Preparation invokes none.
A read may invoke them more than once, and asking whether a field admits
`null` invokes them with `null`; timing and call count are not guaranteed. Closure state, state
a guard object keeps, side effects, and nondeterminism are the author's
obligations. Object identity is outside the stored JSON content contract.
This is not a sandbox.

The supported values are stored JSON content: array elements and own
enumerable string-keyed data properties. Non-enumerable, accessor, and
inherited properties are outside that contract. A keyword-only field reads the
caller's value and a callback field reads the enumerable copy, so the two can
answer differently for such a value: `Type.Object({ hidden: Type.Number() })`
admits an object with a non-enumerable `hidden`, and the same schema under
`Type.Refine` refuses it. This is a documented limit, not a normalization the
reads enforce.

The shared reads own this protection, so App and Folder need no callback
protection of their own. Folder still owns the copies it makes for other
reasons: of input it holds across an await, and of the immutable snapshots it
publishes.

**`prepareData` owns one snapshot of each declared field, frozen where it is a copy.**
It clones own string-keyed data properties with TypeBox's `Memory.Clone`,
freezes the copied plain objects and arrays, and compiles a validator for the
result. The snapshot, `x-field` hint included, is the field the prepared
definition holds, so the editor read from it and the validator agree. Native
composition happens before preparation. A body conversion is carried by
reference and never read.

**A validator belongs to an owned snapshot, never to the author's schema.**
Each validator, with whether its schema holds a native callback, is held in a
private `WeakMap` keyed on the snapshot. Every field of every preparation gets
a fresh snapshot, so a schema declared in two definitions or under two names
is prepared twice, and an edit between two `defineStore` calls reaches only
the second. Preparation is memoized on the declaration object and on the
definition it returns, so preparing a prepared definition returns it. A schema
that was never prepared has no validator: a read given one throws. It is a
programmer error, and it is neither compiled on the spot, which would validate
against a schema nothing froze, nor answered `false`, which would report the
mistake as a refused value. `accepts` does answer `false` for `undefined`,
which is what a name the definition does not declare reads as.

The snapshot is not a full freeze. `Memory.Clone` keeps a function by
reference, and it keeps any node with a `~guard` key by reference whole, with
every keyword beside the guard, at the root or nested. Those nodes and the
guard's own state stay the author's objects, unfrozen and outside the
snapshot. A field whose root has a `~guard` is therefore the author's object
in the prepared definition too: its validator is keyed on that object and is
the latest preparation's.

**A codec is carried and never run.**
The reads call TypeBox's `Check` and `Errors`, which do not decode or
encode. Codec metadata stays on the schema and is not portable as JSON, and no
value is transformed here.

**A native `default` annotation is admitted and inert.**
Validation reads a value and never fills or changes it, so no default is
applied anywhere: a missing declared field and a missing required property are
still issues. Helpers do not take `default` as an option.

**A storage does not gate admission on a hint.**
Folder accepts a reference field as the string schema it is. No storage checks
that a reference's target exists, and renaming or deleting a row repairs
nothing that names it.

## Consequences

The provenance mark, the helper-only declaration type, and duplicated metadata
are gone. An author can edit a helper's schema natively before preparation, and
the check and the editor follow the edited schema together.

A definition has one public shape. The compiled field and table types, their
`Map`s, the repeated table name, the eagerly resolved editor, and App's
re-typing of them for its body codec are gone: `prepareData` returns the type
it was given, so a storage's own body type needs no adapter. A consumer that
held a compiled table now holds a table's `fields` record and its name.

`defineStore` and `defineFolder` return an owned snapshot, not the author's
objects. A caller that compared a definition's `kv` or `tables` by identity
with what it declared, or edited a schema after declaring it and expected the
store to follow, sees a difference. No caller did.

A raw schema cannot be read through. Code that builds a field record by hand
and hands it to a read gets an error naming the mistake, where it used to get
a compiled field from `compileData`. Reads take fields from a prepared
definition.

JSON safety is a property of the reads over a prepared field, not of a schema.
A helper schema validated directly with TypeBox's `Compile` admits what its
keywords admit: `field.json(Type.Any())` checked that way admits a `Date`.

A JSON-safe value is not the same thing as a serializable schema. A native
`Type.Refine` callback added by an author runs locally, a codec is carried
without running, and neither is part of the schema's JSON form. No exporter or
dialect importer exists.

A reference is an editor intent over a string. Its target is held to the table
name grammar because consumers print it. Identifiers may dangle.

A refinement that throws when given `null` does not fail preparation, and is
not called by it. The schema may admit other values, so refusing the
definition over one value rejected more than it protected. A reader that
wants to say a field admits `null` pays one check per field where it asks:
the checkout guide does, once per field, when it is generated.

A field with a native callback pays one copy of each value per read. Fields
built from keywords pay nothing.

## Considered alternatives

- A `{ kind, schema }` field wrapper duplicates the native schema boundary.
- A hidden provenance mark required at compile time makes an editor hint a
  storage gate and refuses schemas that validate correctly.
- Metadata that carries select options and nullability gives the schema and
  the hint two places to disagree after a native edit.
- Inferring a rich editor from an unannotated schema needs a recognizer and
  changes an editor when a schema is refactored.
- Refusing a schema that declares a `default` needs a walker over a closed list
  of schema-holding keywords, and guards against an initialization that no code
  performs.
- A compiled definition beside the declaration (a field object with `schema`,
  `editor`, `check`, and `issues`; a table object with a `fields` map, a
  `name`, and `conformance` and `inputIssues` methods) gives one definition
  two public shapes, and each storage an adapter to type the second one.
- An editor resolved when the definition is prepared needs an answer about
  `null` before anyone asks, so it validates `null` against every field and
  runs author callbacks during a declaration.
- A `nullable` flag on the resolved editor, passed in by the caller or probed
  by the resolver, lets an editor disagree with the check or makes the
  resolver run a validator. The resolver reads keywords; the check answers
  about `null`.
- Inferring that a field admits `null` from its keywords is wrong in both
  directions: `Type.Any()` admits it without naming it, and a refinement can
  refuse a `null` the union names. Asking TypeBox's uncompiled `Value.Check`
  can also differ from the compiled validator where a branch throws.
- Keying a validator on the author's schema object makes a schema reused in a
  second definition read through the first definition's validator after an
  edit.
- Compiling a schema that was never prepared when a read first meets it
  validates against an object nothing froze, and answering `false` for it
  reports a programmer error as a refused value.
- A public per-field diagnostics function beside `conformance` and
  `inputIssues` is a third way to ask one question. `inputIssues` over one
  supplied key is that diagnostic.
- A separate runtime entry point for the reads has no caller that needs the
  split: every reader of the reads also reads the vocabulary.
- Keeping the resolver in App, beside the guide that calls it, separates the
  shape checks from the helpers whose schemas they describe.
- Copying non-enumerable, accessor, or inherited properties into the callback's
  copy, or refusing a value that has one, adds machinery or a stricter JSON gate
  for values no storage produces.
- Freezing the caller's value in place protects it from a callback and takes
  away the caller's right to edit its own object.
- `structuredClone` for the callback's copy recurses, so it overflows on a deep
  value and would add the depth ceiling `isJsonSafe` avoids.
- Copying every value, callback or not, charges keyword-only fields for a risk
  they do not have.
- Deciding whether a hinted schema is satisfiable (a `format` against a
  `pattern`, say) is schema analysis. The format rule compares one keyword.
- A native conditional (`if`, `then`, `else`) that gates a payload on JSON
  safety covers only `field.json`, hides a callback in the schema, and reports
  a failed payload as one generic `then` error.
- A refinement after a recursive schema validates too late to reject a cycle.
- A byte ceiling on a string helper needs a callback, which does not survive
  JSON. Storage limits belong to the storage that has them.
- Freezing helper outputs interferes with native composition and assigns schema
  ownership before the definition is prepared.

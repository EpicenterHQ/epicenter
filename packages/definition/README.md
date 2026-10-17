# @epicenter/definition

The definition vocabulary every Epicenter storage reads: the field helpers,
table definitions, the table name grammar, the preparation that checks a
definition and owns its field schemas, and the one read over a prepared
definition.

It is inert. Importing it acquires nothing, and it knows no storage. Its only
dependencies are `typebox` and `wellcrafted`.

```ts
import { check, defineTable, field, prepareDefinition } from '@epicenter/definition';
import { Type } from 'typebox';

const todos = defineTable({
  fields: {
    title: field.string(),
    due: field.nullable(field.instant()),
    note: field.optional(field.string()),
    estimate: Type.Object({ hours: Type.Number() }),
  },
});

const settings = defineTable({
  fields: { theme: field.optional(field.select(['light', 'dark'])) },
});

const { data: definition } = prepareDefinition({ tables: { todos, settings } });

check(definition.tables.todos.fields, stored, 'read');                // { conforming, issues }
check(definition.tables.settings.fields, { theme: 'dark' }, 'input'); // no issues
```

## One type, written and prepared

A definition is a `Definition`: `{ title?, local?, tables }`. It names no dataset;
the storage that opens it does. Each table is `{ fields }`, where `fields` is
a record of native schemas by field name, plus `additionalProperties: false`
when the table is closed. Settings, when an app keeps them, are a table too,
`settings` (`SETTINGS_TABLE`). `prepareDefinition` returns that same structure with the
same literal type, so `CreateRowOf` and every field's `Static<>` read a
prepared definition exactly as they read the one written. A top-level key the
type does not name, such as an `id` or a `kv`, is malformed. There is no second,
compiled representation: no field wrapper, no table object with methods, no
`Map`, and no name stored anywhere but the record key.

What preparation adds is ownership and a validator:

- It checks the title, the table and field names, that every schema is plain JSON (see
  [A field is plain JSON](#a-field-is-plain-json)), and that TypeBox can
  compile it.
- Each field becomes the declared schema's JSON, deeply frozen, `x-field` hint
  included. `tables` and each `fields` are frozen records with no
  prototype, so a table or field named `constructor` or `toString` is an
  ordinary entry and a name the schema lacks reads as `undefined`.
- A table named `settings` (`SETTINGS_TABLE`) holds settings, one row per
  concern, and declares only `field.optional` fields: a setting may always be
  unset. A required field there is refused with its name; `defineFolder`
  refuses it in the types too.
- TypeBox's compiled validator for each field is held privately beside it.
  `check` looks it up by the field's identity.

`prepareDefinition` is memoized on the definition object and on the one it
returns, so preparing a prepared definition returns it. A definition with an
`id` is malformed. `defineFolder` returns the prepared definition, and the
folders opened from it read through that snapshot.

The one read is `check(fields, values, mode)`; see
[Checking values](#checking-values). A field that was never prepared has no
validator. Handing one to `check` throws: it is a programmer error, not a
value that failed. Nothing is compiled lazily, and the answer is never a
silent `false`.

## Who uses it

| Package | What it adds |
| --- | --- |
| `@epicenter/folder` | `defineFolder`, which prepares a `Definition`. A folder's row body is the file's Markdown text. The opener names the folder. |

It gets the `defineTable` brand, the `CreateRowOf` lens, and `check` over the prepared fields. It does not copy a validator.

## Why this name

The package holds the things a `Definition` is made of and the function that
prepares one. Its import closure is those modules and nothing else:

```text
src/field/        the field.* helpers, the editor hint, and fieldEditorOf (./field)
src/declaration   FieldMap, TableDeclaration, Definition, row lenses
src/define        defineTable and the declared-table brand
src/prepare       prepareDefinition, check, isOptional
src/shape         mismatches, containment, requiredOutside
src/table-name    the table name grammar
src/json          JsonValue and its guards
```

There is no store, schema migration, or query code here, so `definition` says
what it is more exactly than `schema`, `data`, or `core` would.

## A field is one native schema

A field is any native TypeBox schema that is plain JSON. `Static<>` reads it,
and TypeBox's `Compile` decides whether a value conforms. A bare
`Type.Object(...)`, `Type.Enum(...)`, or `Type.Any()` is a field in
`defineTable`, with the exact `Static<>` TypeBox gives it. A
`Type.Refine(...)` or codec is refused: its callback cannot be written to a
file. Declared as a field, its type is refused where it is written; nested
inside another schema, preparation refuses it.

The `field.*` helpers are wrappers for the common cases. Each returns a native
schema and sets one enumerable keyword on it, `x-field`, which says which
editor the author meant:

```ts
field.select(['draft', 'published']);
// { enum: ['draft', 'published'], 'x-field': { kind: 'select' } }

field.reference('pages');
// { type: 'string', minLength: 1, 'x-field': { kind: 'reference', target: 'pages' } }
```

| Helper | Native schema | Hint kind |
| --- | --- | --- |
| `string`, `reference(table)` | `Type.String`; a reference is never empty | `string`, `reference` |
| `url`, `date`, `instant`, `datetime` | `Type.String` with a format | the helper's name |
| `number`, `integer`, `boolean` | `Type.Number`, `Type.Integer`, `Type.Boolean` | the helper's name |
| `select(options)`, `multiSelect(options)` | `Type.Enum`, `Type.Array(Type.Enum)` | `select`, `multiSelect` |
| `tags` | `Type.Array(Type.String())` | `tags` |
| `json(schema)` | a copy of `schema` | `json` |
| `nullable(schema)` | `Type.Union([schema, Type.Null()])` | none of its own |
| `optional(schema)` | `Type.Optional(schema)` | `schema`'s |

Helpers take the options their types list (`title` and `description`
everywhere; length, range, and list bounds where they apply) and throw on any
other key, so an option cannot replace a `type`, a `format`, or the hint.
`default` is not among a helper's options.

A native schema may carry a `default` annotation, at its root or nested
(`Type.String({ default: 'untitled' })`). It is inert here. Validation never
fills or changes a value, so a missing declared field is still an issue, a
missing required property still fails, and no payload is initialized or
recovered from a default. An application that wants one applies it itself.

`field.optional(inner)` is a field a row may leave out. `RowOf` and
`CreateRowOf` read it as `name?:`, a declaration file lists it outside
`required`, and an absent optional field is not an issue; a present one is
checked against `inner`. Absent and `null` stay distinct:
`field.optional(field.nullable(inner))` allows both. Optionality is
outermost, so `field.nullable` and `field.json` refuse an optional inner. Every
field of the `settings` table is one.

`field.json` and `field.nullable` take any required native schema. `field.json(inner)`
adds no validation: it is `inner` with the JSON editor chosen, which matters
when `inner` carries a hint for another editor. `field.nullable(inner)` is the
native union, and `inner` keeps its hint as a member.

### The hint is not validation

`x-field` holds a `kind`, and a reference also holds its `target`. Nothing
else. It never changes what a field accepts: the same schema with no hint, a
wrong hint, or an unknown hint checks, reports issues, and conforms
identically.

`fieldEditorOf(schema)` reads the editor a schema asks for:

```ts
const { status } = definition.tables.posts.fields;

fieldEditorOf(status);
// { kind: 'select', options: ['draft', 'published'] }
check({ status }, { status: null }, 'input').issues;
// []: this field is field.nullable(field.select([...]))
```

| Part | Where it comes from |
| --- | --- |
| `kind` | The hint, when the schema has that widget's shape. Otherwise `json`. |
| `options` | The schema's declared `enum` for a select, `items.enum` for a multi-select. |
| `target` | The hint, for a reference, when it is a usable table name. |

`options` is the declared list. The check never admits a value outside it,
but another keyword on the same schema can refuse one of them, and nothing
filters the list by running the check.

`fieldEditorOf` reads keywords and nothing else. It keeps no state and runs no
validator, so it works on any schema, prepared or not, and it says nothing
about `null`. Whether a field admits `null` is a question for its check, asked
where the answer is used. It is not read off the keywords, because they do not
decide it: `Type.Any()` names no `null` and admits one, and `not: { type:
'null' }` beside a union with `null` refuses it.

A field gets the JSON editor when:

- it has no hint: a bare `Type.Enum` is not a select, and nothing is guessed;
- the hint's kind is unknown or the hint is malformed;
- a reference's target is not a usable table name;
- the schema does not have the shape the named widget edits: a `string` hint
  on a number, a `select` hint with no string `enum`, or a string `enum`
  beside a `type` that is not `string`;
- the schema declares a `format` other than the one the named widget writes:
  `Type.String({ format: 'email', 'x-field': { kind: 'date' } })`. The formats
  are `uri` for `url`, `date` for `date`, and `date-time` for `instant` and
  `datetime`. The same format, or no format, fits. `string` and `reference`
  name no format, so any format fits them;
- the schema, or the item schema of a list, is composed: it has `anyOf`,
  `allOf`, `oneOf`, `not`, `if`, `then`, `else`, or `$ref`.

These are conservative checks of a keyword or two on one schema node, not a
schema recognizer. They err toward the JSON editor, and none asks whether the
schema as a whole can be satisfied.

One composition is read through: a union of exactly `{ type: 'null' }` and one
other schema, with only annotations beside the `anyOf`. That is what
`field.nullable` builds, and the same union written with `Type.Union` reads
the same. When the union has no `x-field` of its own it takes its other
member's hint, so `field.nullable(field.select([...]))` is a select that also
admits `null`.
A union that has its own `x-field` uses that one, and an unusable one gets the
JSON editor; it is not replaced by the member's. A validation keyword beside
the `anyOf`, such as a root `type`, also decides what the field admits, so that
union is not read through.

The prepared snapshot is frozen, so an editor read from a prepared field
describes the schema its validator checks.

### A field is plain JSON

A prepared field is the declared schema's JSON, deeply frozen. What is
checked in memory is exactly what a declaration file holds, so a definition in
code and the same definition read from `epicenter.json` validate alike.
Preparation refuses, with the table, field, and path named:

- a function anywhere, which is how a `Type.Refine`, a `~guard`, or a codec is
  held, including under one of TypeBox's hidden keywords;
- an accessor, a symbol key, a hidden keyword that is not TypeBox's own, a
  visible `~` keyword in a schema, and anything other than plain objects and
  dense arrays;
- a value JSON would rewrite: a non-finite number, and `undefined` in an
  array or as a `const`;
- a schema that contains itself; one shared by two properties is fine;
- a `format` outside TypeBox's stock portable set, or one whose handler an
  application replaced. TypeBox passes every value for a format it does not
  know, so a misspelled format would check nothing. Only `format` at a schema
  position counts: inside `default`, `const`, `enum`, `examples`, or an
  `x-field` hint it is data, and a property named `format` is a field;
- a `$ref` that TypeBox's resolver cannot follow to a schema inside the
  field. Such a field would fail every value, so every row would read as
  invalid. The reason names the reference.

TypeBox's hidden `~` keywords are dropped, except that an optional field keeps
`~optional`, hidden as TypeBox keeps it; `isOptional` reads it. A misspelled
keyword such as `maxLenght` is inert, as JSON Schema treats any unknown
keyword.

### Every field holds JSON

A schema can be structural about what it admits: `Type.Any()` admits a
`Date`, `NaN`, a class instance, and a cycle. None of those survives being
stored. So `check` asks whether a value is JSON before the field's schema
runs. A value that is not JSON fails with `must be a JSON value`, and the
schema's validator is not called. That order matters for a recursive schema
(`Type.Cyclic`), which follows a cyclic value until the stack overflows.
`undefined` at the top level is absence, not a value; inside a value it is not
JSON.

Being JSON has no size: `isJsonSafe` sets no depth or width limit, and a value
reachable by two paths is fine. The 16-level, 1024-key budget is `isJsonValue`
and `isJsonObject`, which the storages that want it apply themselves. A value
that is JSON and fails its schema gets TypeBox's own errors, at their own
paths. If a recursive validator throws, that field reports `schema validation
threw`, and valid sibling fields stay readable. No check changes the value it
is given.

### Who owns a declared schema

A helper copies its arguments: changing an options object, an option list, or
a wrapped schema after the call changes nothing, and nothing the caller passed
in is frozen. An author who edits a schema before preparation owns that edit,
and the editor follows the schema.

`prepareDefinition` takes ownership. Every field of every preparation gets its own
frozen copy and validator, so one declared schema used in two declarations, or
under two names, is prepared twice: edit it between two `defineFolder` calls
and the first folder keeps the checks it was defined with while the second
reads the edit. The author's own schema object is not a prepared field, and
`check` refuses it.

### References

`field.reference(table)` is a nonempty string with a hint that names a table.
The target is editor intent, and it must be a usable table name (`isTableName`):
the helper throws on any other string, and a hand-written hint with one gets
the JSON editor. No storage checks that the table or the row exists, and no
storage rewrites a reference when a row is renamed or deleted. A stored
identifier may dangle.

## Checking values

`check(fields, values, mode)` checks values against prepared fields, one field
at a time, so a field that fails never takes a valid one with it:

```ts
const { fields } = definition.tables.todos;

check(fields, stored, 'read');      // a stored row
check(fields, supplied, 'input');   // a row to write
// { conforming, issues }
```

| Mode | Undeclared key | Absent required field |
| --- | --- | --- |
| `read` | ignored | issue |
| `input` | issue | issue |

An absent optional field is never an issue, and a top-level key holding
`undefined` is absent. `conforming` holds each present field whose value is
JSON and passes its own validator, as the caller's own values.

Each field has its own compiled validator. One `Type.Object` over the whole
row would be checked once, but TypeBox stops reporting at 8 errors, so a bad
field late in a row would read as valid, and a missing key inside a nested
object would be blamed on a top-level field of the same name.

Which mode a storage runs is that storage's rule. App checks names and that a
value is JSON when it writes, and reads through `read`. Folder checks a row it
reads or writes with `read`, or with `input` for a closed table.

An issue is `{ field, path?, message }`. TypeBox's compiled `Check` is the
authority: a value it refuses is an issue even when its error report is empty.
`path` is a JSON pointer inside the field's value, such as `/1` for the second
item of a list. It is present only when the validator named a location that
can be walked in the value; TypeBox joins object keys into its path unescaped,
so a path through a key containing `/` or `~` is reported against the whole
field. Messages and the number of issues are for people, not for code to match
on.

## Whether one definition contains another

An app that opens a folder it did not define reads it through its own
definition: the tables and fields it knows (ADR-0538). `mismatches(declared,
shape)` lists every way the folder's definition (`declared`) does not contain
the reader's (`shape`), empty when it does:

```ts
mismatches(folder.definition, board);
// [{ kind: 'missingField', table: 'todos', field: 'due', message }, ...]
```

| Mismatch | When |
| --- | --- |
| `missingTable` | the reader reads a table the folder's definition lacks |
| `missingField` | the reader reads a field the folder's definition lacks |
| `incompatibleField` | the folder admits a value there the reader refuses, or lets a row leave out a field the reader requires |
| `incompatibleTable` | the reader closes a table (`additionalProperties: false`) the folder leaves open or defines more fields in |

`containment(shape, declared)` answers for one field: `undefined` when
every value the folder's field admits is one the reader's field accepts, or
why not. Containment of JSON Schemas is not decidable in general, so it asks a
fixed set of questions and refuses what they cannot decide, naming the
keyword. Its reasons call the reader's field "the shape":

- A reader field that constrains nothing accepts everything. Two schemas whose
  keywords match, annotations and `x-field` aside, contain each other.
- A folder `enum` or `const` is contained when the reader field's validator
  accepts each listed value, so a reader select contains a select of some of
  its options, and a reader `string` contains any select.
- A folder `anyOf` or `oneOf` is contained when each member is, so a reader
  `field.nullable(x)` contains both `x` and `x | null`. A reader `anyOf`
  contains what one member contains.
- Otherwise both name one `type`, the same, or `integer` under a reader
  `number`. The reader's string length, `pattern`, and `format`, numeric
  bounds and `multipleOf`, array `items`, bounds, and `uniqueItems`, and
  object `properties`, `required`, and `additionalProperties` must each be
  implied by the folder's own. `field.datetime()` contains
  `field.instant()`, not the reverse.

A keyword the folder adds beyond these only narrows it, so it is ignored. A
reader keyword outside them, or a reader `oneOf`, `not`, conditional, or
`$ref`, is refused.

`requiredOutside(declaredTable, shapeTable)` lists the fields the folder's
table requires that the reader's table does not define: a row added through
the reader's table could not supply them.

## Commands

```sh
bun test          # field helpers, table name grammar, preparation and check
bun run typecheck
```

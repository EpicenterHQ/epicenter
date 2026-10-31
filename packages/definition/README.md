# @epicenter/definition

An app's file contract and the pure rules every Epicenter tool applies to it:
the layout, the note codec, and the merge
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
`@epicenter/folder`'s openers, the `epicenter` CLI, and the server all import
these.

It is inert. Importing it acquires nothing, and it knows no storage. Its
dependencies are `typebox`, `wellcrafted`, `yaml` (the note codec) and
`nanoid` (the name helpers).

## The file contract

The package is four subpaths.

| Subpath | What it holds |
| --- | --- |
| `@epicenter/definition/contract` | `defineContract`, path templates (`fill`, `match`), `compileContract`, `checkContract`, the `Client<T>` types every opener returns, and `updateNote`, the rule for an edit that meets a `Conflict` |
| `@epicenter/definition/note` | The note codec and its house style, `formatNote` |
| `@epicenter/definition/merge` | `settle`, the note merge the server and the merge driver run, plus conflict blocks, conflict copies and Git hashes |
| `@epicenter/definition/ids` | `timeId()` and `nanoid()`, for naming files |

```ts
import { checkContract, defineContract } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';

const recorder = defineContract({
  name: 'whispering',
  collections: {
    recordings: {
      path: 'recordings/{id}.md',
      fields: { title: { type: 'string' }, durationMs: { type: 'number' } },
      required: ['title'],
    },
    audio: { path: 'recordings/{id}.{ext}' },
  },
});

// An opener's client: create takes the placeholders and the value together.
await device.recordings.create({ id: timeId(), title: 'Standup' });

// What `epicenter check` reports: one issue per file that does not fit.
checkContract(recorder, [{ path: 'recordings/a.md', text: '---\ntitle: 1\n---\n' }]);
```

A contract's `name` is the app's, a lowercase slug (`whispering`), not a
repository address: the repository is `<account>/<name>`. `$schema` and
`description` may sit beside it in the published JSON.

A collection whose path ends in `.md` holds notes: front matter `fields` as
JSON Schema properties, with JSON Schema's own `required`, plus a body. Any
other path holds files. A note reads as `{ ...placeholders, ...fields, body,
version }` and a file as `{ ...placeholders, bytes, version }`; every update
and delete passes back the `version` it read as `over`.

### Merging a note

`settle(base, current, incoming, { parties })` is the one note merge. The
server runs it when a web write lands on a moved `main`, and
`epicenter merge-driver` runs it for `git merge`. `incoming` is the later
arrival:

```ts
import { settle } from '@epicenter/definition/merge';

const base = '---\ntitle: Standup\n---\nPay Alice\n';
const current = '---\ntitle: Daily\n---\nPay Alice now\n';
const incoming = '---\ntitle: Weekly\n---\nPay Alice later\n';
const parties = {
  current: { author: 'desktop', time: '2026-10-31T01:00:00Z' },
  incoming: { author: 'web', time: '2026-10-31T01:00:05Z' },
};
settle(base, current, incoming, { parties }); // { text, blocks: true }
```

```md
---
title: Weekly
---
<<<<<<< current desktop 2026-10-31T01:00:00Z 5b643f5
Pay Alice now
||||||| base 946457d
Pay Alice
=======
Pay Alice later
>>>>>>> incoming web 2026-10-31T01:00:05Z cfa4e0a
```

A front matter key both sides set goes to the later arrival. The body merges
by line, then by word within a line both sides changed; two different changes
at the same spot make one conflict block of whole lines. An edit beats a
delete. A binary file never merges: `settlePointer` lands it, or names a
conflict copy `<stem> (conflict <hash7>).<ext>` with `conflictSibling`.
Whatever `settle` writes is in house style.

### How a folder is stored in Git

`storedWithLfs(path)` (`/contract`) is true for every path that is neither a
`.md` note (in any case) nor hidden (a segment starting with `.`): those files
are Git LFS pointers. `REPOSITORY_ATTRIBUTES` is the `.gitattributes` block
that says so, with `merge=epicenter` on notes; `epicenter init` commits it and
the server writes it in a repository's first commit. `REPOSITORY_IGNORE` keeps
`.DS_Store` and `.epicenter/` out of Git.

## A note field is plain JSON

A contract's note field is a native TypeBox schema that is plain JSON, so a
published contract validates exactly as the field does in memory.
`compileContract` refuses a field, with the path named
(`contract/schema-problem.ts`), that holds:

- a function anywhere, which is how a `Type.Refine`, a `~guard`, or a codec is
  held, including under one of TypeBox's hidden keywords;
- an accessor, a symbol key, a visible `~` keyword in a schema, and anything
  other than plain objects and dense arrays;
- a value JSON would rewrite: a non-finite number, and `undefined` in an
  array or as a `const`;
- a schema that contains itself; one shared by two properties is fine;
- a `format` outside TypeBox's stock portable set, or one whose handler an
  application replaced. TypeBox passes every value for a format it does not
  know, so a misspelled format would check nothing. Only `format` at a schema
  position counts: inside `default`, `const`, `enum`, or `examples` it is
  data, and a property named `format` is a field;
- a `$ref` that TypeBox's resolver cannot follow to a schema inside the
  field. Such a field would fail every value. The reason names the reference.

## Commands

```sh
bun test          # the contract, note codec, merge, and ids
bun run typecheck
```

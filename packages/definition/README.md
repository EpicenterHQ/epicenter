# @epicenter/definition

An app's file contract and the pure rules every Epicenter tool applies to it:
the layout, the note codec, and the merge
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)),
plus the names an app's site derives.
`@epicenter/folder`'s openers, the `epicenter` CLI, the server, and the apps
all import these.

It is inert. Importing it acquires nothing, and it knows no storage. Its
dependencies are `typebox`, `wellcrafted`, `yaml` (the note codec) and
`nanoid` (the name helpers). The one exception is
`@epicenter/definition/site/app-data`, which reads the OS to name the
application-data root and so runs only in Bun or Node.

## The file contract

The package is seven subpaths.

| Subpath | What it holds |
| --- | --- |
| `@epicenter/definition/contract` | `defineContract`, path templates (`fill`, `match`), `compileContract`, `checkContract`, the shapes of a contract's notes and files (`NoteOf`, `FileEntryOf`, `InvalidNoteOf`, `NotePatch`), and a note as text (`noteText`, `readNoteText`) |
| `@epicenter/definition/front-matter` | The front-matter primitive of ADR-0796 and ADR-0797, with no YAML: `parseFrontMatter`, `patchFrontMatter`, `merge3` (fields by key, the body by lines, ADR-0795), and `mergeLines`, a port of Git's three-way line merge. The engine and the apps do not use it yet |
| `@epicenter/definition/note` | The note codec and its house style, `formatNote` |
| `@epicenter/definition/merge` | `settle`, the note merge a folder runs over a note that changed under its write, plus conflict blocks, Git hashes, and Git LFS pointers |
| `@epicenter/definition/ids` | `timeId()` and `nanoid()`, for naming files, and `timeOf()`, when a `timeId` was made |
| `@epicenter/definition/site` | The names a site derives: the app registry (`APPS`, dev ports, `localUrl`, `resolveOAuthAudiences`), an app's folder, repository and data identifier from its production site (ADR-0722), and the repository name grammar |
| `@epicenter/definition/site/app-data` | The application-data root on this machine (`epicenterDataRoot`), an app's directory below it, and `isAppId` |

`fixtures/front-matter.json` holds every front-matter case with its exact
output bytes, for the TypeScript primitive and a Rust twin; its test also
checks each body merge against Git's own `merge-file`.

`fixtures/app-names.json` holds the site naming cases. `site/app-names.test.ts`
and the standalone desktop shell (`packages/tauri-epicenter-standalone`) both
read it, so the TypeScript and Rust derivations cannot drift.

```ts
import { checkContract, defineContract } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';

const recorder = defineContract({
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

A contract describes the app's collections. The app's site names its repository.
`$schema` and `description` may sit beside `collections` in published JSON.

A collection whose path ends in `.md` holds notes: front matter `fields` as
JSON Schema properties, with JSON Schema's own `required`, plus a body. Any
other path holds files. A note reads as `{ ...placeholders, ...fields, body }`
and a file as `{ ...placeholders }`, with its `bytes` when read whole. No read
carries a version and no write takes one: the folder reads a file just
before it writes it, and settles a change made since with `settle`
([ADR-0774](../../docs/adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md)).

### Merging a note

`settle(base, current, incoming, { parties })` is the note merge a folder
runs when a note changed between showing it and writing it; sync merges with
`merge3` from `@epicenter/definition/front-matter`, and the server never
merges (ADR-0773). `incoming` is the later
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
delete. A binary file never merges: `settlePointer` lands the later write,
and the version it replaced stays in history (ADR-0771). Whatever `settle`
writes is in house style.

### How a folder is stored in Git

`storedWithLfs(path)` (`/contract`) is true for every path that is neither a
`.md` note (in any case) nor hidden (a segment starting with `.`): those files
are Git LFS pointers. `REPOSITORY_ATTRIBUTES` is the `.gitattributes` block
that says so, with `merge=epicenter` on notes; `epicenter init` commits it and
the server writes it in a repository's first commit. A hidden path is not a
folder's data (`isHiddenPath`); the CLI's own `.gitignore` block keeps
`.DS_Store` and a folder's unfinished writes out of Git.

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
bun test          # the contract, note codec, merge, ids, and site names
bun run typecheck
```

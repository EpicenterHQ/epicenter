# 0933. An app's data is top-level folders of Markdown records and single Markdown files

- **Status:** Proposed
- **Date:** 2026-11-16
- **Supersedes:** [ADR-0918](0918-a-collection-selects-a-record-by-its-keys-and-a-file-that-is-not-there-reads-as-absent.md) (a collection selects a record by its keys) and [ADR-0919](0919-a-collection-declares-its-files-beside-its-fields-and-they-rest-in-the-folder-named-by-its-key.md) (file slots), once accepted.
- **Amends:** [ADR-0920](0920-a-field-can-list-values-and-can-refer-to-another-collections-record-by-its-key.md): a ref names its target by key name and holds one id. [ADR-0921](0921-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md): the check's rules below, with no count of skipped files.
- **Relates:** [ADR-0934](0934-code-reaches-a-record-by-its-keys-name-and-its-id.md) (how code reaches these records); [ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md) (the actions generated for them); [ADR-0920](0920-a-field-can-list-values-and-can-refer-to-another-collections-record-by-its-key.md) (refs); [ADR-0921](0921-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md) (the check); [ADR-0923](0923-a-read-gives-only-what-the-file-holds-and-no-field-has-a-default.md) (absent switches and lists); [ADR-0924](0924-front-matter-is-key-json-lines-each-read-on-its-own-and-no-yaml-is-read.md) (front matter grammar).

## Context

An app declares Markdown records one collection at a time, each with a path
template, and registers them in `defineApp`:

```ts
const notes = defineCollection({ path: 'data/notes/{time}.md', fields: { kind: field.select(kinds) } });
const settings = defineCollection({ path: 'data/settings.md', fields: { level: field.select(levels) } });
const checks = defineCollection({ path: 'data/checks/{name}/{day}.md', fields: { /* … */ } });
export default defineApp({ collections: { notes, settings, checks }, actions: { ...notes.actions() } });
```

A template lets a folder name carry data (`{name}`, `{asOf}`, `{period}`), so a
path must be matched in both directions, and `defineApp` must refuse two
collections that could hold one file (`data/drafts/{id}.md` beside
`data/drafts/chat.md`). A path-pattern declaration that described any file at
any depth (an earlier draft of this record) needed overlap, precedence, label
agreement, per-item required files, and disk identity resolution on a
case-insensitive Mac, each found by review.

Of the 28 collections in the real apps, 25 are one folder of Markdown files or
one Markdown file. Three use folder levels: finance
`data/balances/{asOf}/{account}.md` and `data/flows/{period}/{id}.md`, flights
`data/checks/{name}/{day}.md`.

What every app needs from the declaration is that `epicenter check` validates
the front matter of its Markdown records. How an app arranges anything else
(a page's video, a cache, review images) differs by app and is the app's code.

## Decision

**An app's data is one `defineData({...})`. A key that ends in `.md` is one file in `data/`; any other key is a folder in `data/` whose records are the `.md` files directly inside it.**

An app's `local/` folder holds files that stay on this computer.
`defineData` does not describe it; the app reads and writes those files through `folder`.

```ts
// code/data.ts
import { defineData, field } from '@epicenter/app';

export const data = defineData({
	notes:             { fields: { kind: field.select(kinds), project: field.text({ optional: true }) } },
	watches:           { fields: { from: field.list(field.text()), to: field.list(field.text()) } },
	checks:            { fields: { watch: field.ref('watches'), day: field.date() } },
	'settings.md':     { fields: { level: field.select(levels) } },
});
```

```ts
// code/epicenter.ts
import { defineApp } from '@epicenter/app';
import { data } from './data';

export default defineApp({ description: 'Flights I am watching', data, actions });
```

```txt
data/
  notes/2026-11-16T09-12-04-120Z-k3x9a2f8.md   a record of notes, id 2026-11-16T09-12-04-120Z-k3x9a2f8
  watches/sfo-nyc.md                           a record of watches, id sfo-nyc
  checks/sfo-nyc.2026-11-16.md                 a record of checks
  settings.md                                  the one file of settings.md
```

- A key is a name as `isName` defines one (lowercase letters, digits, and
  dashes, starting with a letter: `notes`, `device-drafts`), then optionally
  `.md` for one file. So two keys never share a name on a
  disk that ignores case.
- Each value is `{ description?, fields }`. `description` says what one file
  is ("a word I'm learning") for the generated actions and for
  `epicenter list`. Field kinds, optional fields, absent switches and
  lists, and undeclared front matter keys behave as a collection's do today.
  A field cannot be `readOnly`
  ([ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md)). `path`, `body`, `id`, and `edit` cannot be
  field names: the first three are a record's own, and the generated `set`
  takes `edit` beside the fields
  ([ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md)).
- The declaration lives in `code/data.ts`, so the app's `lib/` files import
  `data` without importing `epicenter.ts`. This is a convention; nothing
  looks for the file by name.

**A record's id is its file name without `.md`, one segment.**

An id is not empty, is at most 200 UTF-8 bytes, has no `/`, `\`, or control
character, does not start with `.`, does not start or end with a space, and is
in Unicode NFC. A handle tidies an id before it checks it: surrounding
whitespace is removed and the text is put in NFC, so ` Dune` reaches `Dune`
and an accented word typed two ways is one file. It changes nothing else:
inner spaces and case are the app's to decide. An id that still breaks a rule
is refused. `field.id()` is the input field a hand-written action uses to
refuse an untidy id at the door.

Whoever adds a record names it: a word by the word, a book by its title, a
note by `timeId()`. A generated `add` given no id uses `timeId()`
([ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md)).
The declaration says nothing about how ids are chosen.

An id names a file; the fields hold the meaning. A composite id such as
`sfo-nyc.2026-11-16` is opaque: code that needs the watch and the day reads
the `watch` and `day` fields, never the id's parts.

**The lens is Markdown front matter and nothing else.**

In a folder key's folder, a `.md` file is a record. A subfolder, a file with
another extension, and a name starting with `.` are the app's own: no handle
names them and `epicenter check` does not read them.
`pages/intro.md` beside `pages/intro/final.mp4` is one
record and a folder the app arranges. An entry in `data/` that no key names,
such as a cache, is the app's own too.

**A relation is a field: `field.ref(key)` holds the id of a record in folder key `key`.**

`field.ref('watches')` holds `"sfo-nyc"` for `data/watches/sfo-nyc.md`. The key
is a folder key of the same `defineData`.
`field.list(field.ref('watches'))` holds several. A read never opens the
record a ref names; `epicenter check` is where a ref is resolved.

**`epicenter check` reports each file in a key's place that does not fit, and nothing else.**

```txt
$ epicenter check flights
flights
  watches      4 files, none with problems
  checks       312 files, 3 with problems
    checks/sfo-nyc.2026-11-02.md
      day is not a date
      watch "sfo-bos" names no file in watches/
    checks/SFO-nyc.2026-11-03.md and checks/sfo-nyc.2026-11-03.md
      are one file on a disk that ignores case
  settings.md  fits
```

- A record whose front matter does not fit is a problem, with a line per
  field.
- A `.md` file in a folder key's folder whose name is not a valid id is a
  problem: it looks like a record and nothing can reach it. A name starting
  with `.` is the app's own, not a problem.
- Two names in one folder that are equal under NFC and case folding are a
  problem, because they become one file on a Mac.
- A ref is a problem unless it equals, byte for byte, the id of a listed
  record in its key.
- A one-file key whose file is absent is not a problem.

## Consequences

- `defineCollection`, its path templates, placeholders, `{time}`, `Keys`,
  `pathOf(keys)`, and the overlap check in `defineApp` are deleted, along with
  the path-pattern machinery of the earlier draft (`data-pattern.ts`, overlap,
  precedence, match-back, disk identity). Two keys can never hold one file,
  because each key is its own name in `data/`.
- The check has no count of skipped files. What it does not read is the app's
  by this record, and what it reads either fits or is a problem someone can
  fix.
- Three collections move: `checks/<watch>/<day>.md` becomes
  `checks/<id>.md` with `watch: field.ref('watches')` and `day`;
  `balances/<asOf>/<account>.md` and `flows/<period>/<id>.md` do the same with
  `account`, `asOf`, and `period`. A check whose watch was deleted, invisible
  as an orphan folder today, is reported by `epicenter check`.
- A lookup by a natural key becomes an id the app formats, such as
  `${watch}.${day}`.
- A page's video, a cache, or review images are arranged by the app through
  `folder`, and an app that wants them checked writes an action that checks
  them. Markdown nested in a subfolder is never checked.
- A collection's placeholder name becomes `id` in its records: `time` in
  capture, tasks, writing, mail, vocab, and zhongwen; `title` in reading; `word` in
  vocab and zhongwen; `name` in flights. Action inputs may keep their names.
- A one-file key may have required fields, because its absent file reads as
  absent ([ADR-0934](0934-code-reaches-a-record-by-its-keys-name-and-its-id.md)),
  not as an empty record that every field must accept.

## Cutover

Every app in a home runs on one installed `@epicenter/app`. The runtime that
adds `data` keeps `collections`; an app declares one or the other and moves in
one commit, together with the call changes of
[ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md),
so each app is rewritten once. The minor release after the last app moves
deletes `defineCollection`.

## Considered alternatives

- **Path patterns in one flat map, any depth (the earlier draft of this record).** Every file describable, at the cost of overlap, precedence, per-item required files, and disk identity resolution.
- **A fixed layout of one file, a folder of files, and a folder of record folders.** Each reviewer chose different builders and a different main file (`<id>.md` beside `<id>/`, or `<id>/record.md`) for the third shape; how a record's other files are arranged differs by app.
- **Ids that span folders (`balances/2026-11-15/checking`).** Reversible and keeps three layouts, but sweeps a page's companion folder into its collection and leaves meaning in folder names that nothing validates.
- **File slots and `field.file()` naming a record's files ([ADR-0919](0919-a-collection-declares-its-files-beside-its-fields-and-they-rest-in-the-folder-named-by-its-key.md), Astro's `image()`).** A file the app names the same for every record is not data; one the record chooses is the app's to arrange.
- **Glob loaders, as Astro's `glob()`.** A glob tests a path but cannot make one from an id, and the cases that needed `**` hold files nobody validates.
- **A count of skipped files in the check.** It kept files a key used to cover from dropping out of view, but named none of them and changed nothing a person could do.
- **An absent one-file key reading as an empty record.** It let a page read settings before the file existed, at the cost of a rule that every field of a one-file key be optional.
- **`defineRecords`.** More exact about what is declared, but `data.watches` reads as `data/watches/` at every call site, and the call site is what code reads.
- **No app-owned JSON.** Front matter breaks on top-level arrays and large nested values; JSON stays a plain file the app reads.
- **Only folder keys, with `settings/settings.md`.** Moves the cost of one rule into every one-file app as a folder of one file and an id repeated at every call.

# Collections select by key and keep their files

**Date**: 2026-11-15
**Status**: In Progress (waves 1 and 2 are built in their own worktrees; nothing is merged)
**Owner**: Braden
**Decisions**: ADR-0917, ADR-0918, ADR-0919, ADR-0920, ADR-0921, all Proposed

## One sentence

`defineCollection` keeps its one path template, names a record by its keys,
gains file slots, lists, and references, and `epicenter check` reports what does not fit,
built in five waves that each land complete.

## What an app looks like afterward

```ts
const collections = defineCollection({
  path: 'data/collections/{collection}.md',
  fields: { title: field.text() },
});

const pages = defineCollection({
  path: 'data/pages/{page}/page.md',
  fields: {
    title: field.text(),
    tags: field.list(field.text()),
    collections: field.list(field.ref(collections)),
  },
  files: { narration: { accept: ['audio/mpeg'], optional: true } },
});

await pages.add({ page: 'tools', title: 'Tools', body: '...' });
await pages.set({ page: 'tools' }, { narration: upload });
await pages.get({ page: 'tools' });
await pages.list();
```

## Waves

Additive work first, the break after it, the largest piece last. Waves 2 to 4
all edit `packages/app/src/collection.ts`, so they run one at a time, each on
its own branch off `main`.

### Wave 1: `epicenter check` (ADR-0920)

- [ ] `epicenter check [<app>]`, human output with counts by kind, `--json`,
  read-only run, non-zero exit on any problem.
- [ ] Tests for a misfit field, a missing required field, unreadable front
  matter, grouping, zero files, a one-file collection, a `.local` collection.
- [ ] `packages/cli/README.md` documents it.

Works on today's collections. It also shows how each real app's data fits its
declaration before anything breaks.

### Wave 2: `field.list` and `field.ref` (ADR-0919)

- [ ] `field.list(item)`. `field.tags()` keeps working until wave 3, so this
  wave breaks no app.
- [ ] `field.ref(collection)`, the `x-epicenter-ref` annotation, refusal of a
  missing or inexact key on `add` and `set`.
- [ ] The check reports a reference with no record behind it. This part waits
  for wave 1 to be on `main`.

### Wave 3: selection by key (ADR-0917)

- [ ] Every method takes keys where it took `path`: `get(keys)`,
  `set(keys, change)`, `edit(keys, change)`, `update(keys, change)`,
  `delete(keys)`. `add` and `list()` are unchanged. A row can be passed as
  the keys.
- [ ] `set` accepts a function of the record as its change and throws
  `ActionError.Missing` itself.
- [ ] A collection with no placeholder gets every method and verb, without
  the keys argument, and loses its defaults and its upsert.
- [ ] Unreadable front matter refuses; an unclosed opening fence counts.
- [ ] A file whose name is not the one its key makes lists with a problem.
- [ ] Verbs take keys in one flat input. `holds`, `other`, and
  `field.tags()` are removed.
- [ ] The check reports front matter no field declares.
- [ ] Every app under `~/Epicenter/apps` moves in the same step as installing
  the new command, because the command supplies `@epicenter/app` to each app
  it loads: the calls that pass `path`, 13 `field.tags()` calls, the
  collections with no placeholder, and each UI's routes. About 59 `add` calls
  do not change. The trial's rewrite of Vocab, Flights, and Mail is the
  starting point.

### Wave 4: files (ADR-0918 and ADR-0921)

- [ ] `files` on `defineAction`; `field.file` and its scans removed.
- [ ] Ordinary calls and the command line carry files; input bytes are
  deleted at the end of every call and run.
- [ ] `files` on `defineCollection`, the record's folder, `dirOf`,
  `folder.move`.
- [ ] A route that serves a kept file to a page. No page can show kept media
  today, and no record decides this yet.
- [ ] First real target: the interview example in `packages/cli/examples`.

Needs ADR-0921 accepted first: it amends ADR-0915, which is Accepted.

### Wave 5: the Vault (under the Vault spec)

- [ ] Declare pages, journal, and collections with the new API.
- [ ] Move each page to `data/pages/<page>/page.md` and rewrite links.

## How this meets "The vault as an Epicenter app"

That spec (`specs/20261113T234315-the-vault-as-an-epicenter-app.md`) is not on
`main`. It lives in the checkout at `/Users/braden/Code/epicenter`. Where the
two meet:

| That spec | This plan |
| --- | --- |
| Its draft `epicenter.ts` declares pages, journal, and collections | gains `field.ref(collections)`, `field.list`, and a `narration` slot |
| Success criterion `epicenter vault check` (the app's own action) | unchanged; `epicenter check vault` is the generic report beside it |
| Open question 4, a slug without `finishedAt`, "leave it to `check`" | stays the Vault's own check; the generic check has no rules across fields |
| "A page keeps its path (`pages/<page>.md`) and its history" | **conflicts with wave 5**, which moves every page into a folder |

The last row is a decision to write into that spec. On 2026-11-15 Braden
chose `data/pages/<page>/page.md`, because most pages are meant to gain
narration and a script, and accepted the cost of moving about 3,300 files and
rewriting their links. `git mv` keeps each file's history followable, but the
paths do move, which that spec says they would not.

## Open questions

1. **YAML front matter.** Every page and journal entry in the Vault is YAML.
   Today the first field write rewrites the block as `key: <JSON>` lines.
   - **Recommendation**: keep `key: <JSON>` as the one written form, stop the
     silent rewrite, and add a deliberate one-time conversion. Rows such as
     `posts` then sit on one long line.
2. **Deleting a record's folder.** ADR-0918 leaves the folder when the
   Markdown file is deleted.
3. **A reattached run.** Whether it needs every past yield or only the latest
   is outside these records.
4. **Cut from the first version**: a file kept under the uploader's own name,
   typed keys, a `move` on a record, a reference to the same collection or
   in a cycle, and an `at` selector. Add each when an app needs it.

## What was checked, and what was not

- Type-only experiments for selection by key compile against the real `field`
  and `defineAction` types.
- A read-only run of a draft collection over the Vault's 3,323 pages: about
  150 ms, 926 rows with problems, 924 of one kind.
- The wave 1 build of `epicenter check`, run read-only against the home on
  2026-11-15: 12 apps, 27 collections, no problems, about one second, and no
  file under `apps/` changed.
- A trial rewrote the collection calls of Vocab, Flights, and Mail against
  the ADR-0917 signatures as types only. All three type-check, and its
  findings changed the record in six places.
- Waves 1 and 2 are built and pass their tests in their own worktrees. They
  are not committed.
- No runtime for key selection or `files` exists.
- No independent review of ADR-0917 to ADR-0921 has been done.

## Success criteria

- [ ] `epicenter check` on the home exits zero, or every remaining problem is
  one a person chose to leave.
- [ ] No app builds a path under `data/` by hand to reach a declared record or
  its file.
- [ ] A page saves a file with one ordinary call and shows it afterward.
- [ ] `grep -r "path: .*pathOf\|field.file\|field.tags"` over the apps finds
  nothing.

# Collections select by key and keep their files

**Date**: 2026-11-15
**Status**: In Progress (waves 1 and 2 are built in their own worktrees; nothing is merged)
**Owner**: Braden
**Decisions**: ADR-0918, ADR-0919, ADR-0920, ADR-0921, ADR-0922, all Proposed

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

Additive work first, the break after it, the largest piece last. Waves that
edit `packages/app/src/collection.ts` run one at a time. Each wave is built
on its own branch and merged into `worktree-collection-decisions`, which
lands on `main` as one branch.

### Wave 1: `epicenter check` (ADR-0921)

- [ ] `epicenter check [<app>]`, human output with counts by kind, `--json`,
  read-only run, non-zero exit on any problem.
- [ ] Tests for a misfit field, a missing required field, unreadable front
  matter, grouping, zero files, a one-file collection, a `.local` collection.
- [ ] `packages/cli/README.md` documents it.

Works on today's collections. It also shows how each real app's data fits its
declaration before anything breaks.

### Wave 2: `field.list` and `field.ref` (ADR-0920)

- [ ] `field.list(item)`. `field.tags()` keeps working until wave 3, so this
  wave breaks no app.
- [ ] `field.ref(collection)`, the `x-epicenter-ref` annotation, refusal of a
  missing or inexact key on `add` and `set`.
- [ ] The check reports a reference with no record behind it. This part waits
  for wave 1 to be on `main`.

### Wave 3: selection by key (ADR-0918)

- [x] Every method takes keys where it took `path`: `get(keys)`,
  `set(keys, change)`, `edit(keys, change)`, `update(keys, change)`,
  `delete(keys)`. `add` and `list()` are unchanged. A row can be passed as
  the keys.
- [x] `set` accepts a function of the record as its change and throws
  `ActionError.Missing` itself.
- [x] A collection with no placeholder gets every method and verb, without
  the keys argument, and loses its defaults and its upsert.
- [x] Unreadable front matter refuses; an unclosed opening fence counts.
- [x] A file whose name is not the one its key makes lists with a problem.
- [x] Verbs take keys in one flat input. `holds`, `other`, and
  `field.tags()` are removed.
- [ ] Every app under `~/Epicenter/apps` moves in the same step as installing
  the new command, because the command supplies `@epicenter/app` to each app
  it loads: the calls that pass `path`, 13 `field.tags()` calls, the
  collections with no placeholder, and each UI's routes. About 59 `add` calls
  do not change. The trial's rewrite of Vocab, Flights, and Mail is the
  starting point.

### Wave 3b: repairs from the design review (ADR-0918, ADR-0923)

Three reviewers formed their own accounts, then worked through the design
and each other's. These are the changes all three supported.

- [x] A value that does not fit reads as absent; a switch reads `false` and a
  list `[]` only when the key is missing; no schema carries `default`.
- [x] A change computed by a function may not write a field whose value did
  not fit.
- [x] `set` carries `body` in code; the `set` verb takes fields and `was`;
  `edit` is a verb only.
- [x] `list()` returns whole records; the `list` verb leaves out `body`.
- [x] A key finds its file by its exact name first.
- [x] The `delete` verb exists only when named.
- [x] For a collection with no placeholder, the `set` verb makes the file.

### Wave 4a: one JSON object on the command line (ADR-0925)

- [x] `epicenter <app> <action> [<json> | -]`; `positional`,
  `RESERVED_FIELDS`, and `--input` removed; help lists keys and an example.
- [x] Every written command in the repository's READMEs, vision, skill, and
  examples.

Built before the apps move, so they move once.

### Wave 4b: front matter (ADR-0924)

- [x] `split` reads each line on its own; a `key: <text>` line that is not
  JSON is that key's problem and is kept.
- [x] The `Bun.YAML` branch and the whole-block rewrite are deleted.
- [x] `epicenter check` lists each such line with what to write.
- [x] A routine's file and `EPICENTER.md` refuse a line that is not JSON.

Touches `packages/app/src/front-matter.ts` and `collection.ts`, not the
command line's input, so it can be built beside wave 4a.

### Wave 4c: the apps under `~/Epicenter/apps`

One pass over all 12, on the owner's go-ahead, with the command that has
waves 3 to 4b:

- [ ] Calls that pass `path` take keys; `field.tags()` becomes
  `field.list(field.text())`; defaults move to where the value is read.
- [ ] 49 `positional` lines are deleted; each README's commands take JSON.
- [ ] Hand-written actions that the default verbs now cover are deleted.
- [ ] `epicenter check` exits zero on the home afterward.

### Wave 5: files (ADR-0919 and ADR-0922)

- [ ] `files` on `defineAction`; `field.file` and its scans removed.
- [ ] Input bytes are deleted at the end of every run.
- [ ] `files` on `defineCollection`, the record's folder, `dirOf`,
  `folder.move`.
- [ ] A route that serves a kept file to a page. No page can show kept media
  today, and no record decides this yet.
- [ ] First real target: the interview example in `packages/cli/examples`.

Needs ADR-0922 accepted first: it amends ADR-0915, which is Accepted.
ADR-0917 already lets every page call carry a file, so this wave adds no
transport.

### Wave 6: the Vault (under the Vault spec)

- [ ] Convert each page's front matter to `key: <JSON>` lines with a script
  in the Vault's own code, on the terms in ADR-0924.
- [ ] Declare pages, journal, and collections with the new API.
- [ ] Move each page to `data/pages/<page>/page.md` and rewrite links.

## What the agents-first rulings removed

| Removed | By | What a person loses |
| --- | --- | --- |
| Flags and positional words, `positional`, reserved field names, `--input` | ADR-0925 | short calls typed by hand |
| Reading YAML, the whole-block rewrite, the one-key YAML patch that was never built | ADR-0924 | YAML styles in front matter |
| A file given on the command line, and a second way for a page to send one | ADR-0922, ADR-0917 | nothing in use |
| Defaults in schemas | ADR-0923 | nothing; the default is written where it is read |

Kept, though an agent is the main caller, because a person still reviews the
files: unchanged lines stay byte for byte, undeclared keys stay, reads report
problems instead of throwing, a key finds its exact file name first, and a
save from outside names what it replaces (`was`, `edit`).

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

1. **YAML front matter.** ADR-0924 proposes: no YAML is read, each line is
   read on its own, and a folder of YAML is converted once by its own script.
   All three reviewers support it on one condition, that no tool in use
   saves front matter as YAML.
2. **Deleting a record's folder.** ADR-0919 leaves the folder when the
   Markdown file is deleted.
3. **A reattached run.** Whether it needs every past yield or only the latest
   is outside these records.
4. **Cut from the first version**: a file kept under the uploader's own name,
   typed keys, a `move` on a record, a reference to the same collection or
   in a cycle, and an `at` selector. Add each when an app needs it.

5. **The write lock.** An action takes the app's `flock` at its first write
   and holds it until it ends. A trace on 2026-11-15 found it does three jobs:
   it closes a two-line gap in `folder.update` between processes
   (`packages/cli/src/disk.ts`, the re-read and the rename), it makes `add`
   refuse an existing file (there is no create-only write), and it tells a
   live job from a dead one for Codex's `settle` and Mail's `apply`. Mail
   takes it early with an `update` that changes nothing. Flights and Mail's
   sync built their own locks, because this one starts at the first write
   and covers the whole app.
   - **Recommendation**: leave it alone in these waves. A later record could
     give an action a way to take a named hold on purpose, and make `add`
     create-only at the file. Removing the lock without those loses real
     guarantees.

## What was checked, and what was not

- Type-only experiments for selection by key compile against the real `field`
  and `defineAction` types.
- A read-only run of a draft collection over the Vault's 3,323 pages: about
  150 ms, 926 rows with problems, 924 of one kind.
- The wave 1 build of `epicenter check`, run read-only against the home on
  2026-11-15: 12 apps, 27 collections, no problems, about one second, and no
  file under `apps/` changed.
- A trial rewrote the collection calls of Vocab, Flights, and Mail against
  the ADR-0918 signatures as types only. All three type-check, and its
  findings changed the record in six places.
- Waves 1 to 3b are built and merged with `main` at `04f87cb235`: 182 tests
  pass in `packages/app` and 238 in `packages/cli`, and both type check.
- Three reviewers ran five rounds on ADR-0918 to ADR-0925. The two defects
  they reproduced in wave 3 (a misfit list read as `[]` and then overwritten;
  a file with two spaces in its name listed but out of reach) no longer
  reproduce on the merged code.
- A count on 2026-11-15, values unread: all 554 front matter lines in the
  apps' 111 files are `key: <JSON>`; none of the Vault's 3,329 pages is.
- Waves 4a and 4b are built and merged. The example writing app, copied to a
  scratch Epicenter, took JSON as an argument and from stdin, and refused two
  words, text that is not JSON, an array, and a mistyped key, each with exit 2.
- With the merged command, an app that calls `field.tags()`, passes
  `positional`, or declares a default fails to load until wave 4c.
- No runtime for `files` exists.

## Success criteria

- [ ] `epicenter check` on the home exits zero, or every remaining problem is
  one a person chose to leave.
- [ ] No app builds a path under `data/` by hand to reach a declared record or
  its file.
- [ ] A page saves a file with one call and shows it afterward.
- [ ] `grep -r "path: .*pathOf\|field.file\|field.tags"` over the apps finds
  nothing.

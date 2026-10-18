# 0611. Epicenter v1 is a Git service, a CLI, and a library over namespaces of typed Markdown

- **Status:** Proposed
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (a data folder keeps `epicenter.ts`, and `epicenter generate <dir>` writes the `epicenter.json` it declares): a table's schema is the literal JSON Schema in its `.epicenter.json`, and nothing generates it.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at the root `epicenter.json`, its `app` and `title`, "never reads the folder's `epicenter.json`", and "A data folder is every real, non-dot directory directly in the Epicenter folder": each table carries `<table>/.epicenter.json`, an app reads it, and the unit a person owns is a namespace; [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principles 2, 3, 5, 9, and 10: principles 6 to 8 stand for the deferred desktop host and the rest read as restated below; [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `https://git.epicenter.so/<namespace>/<name>.git`, Connect, and the proposed name: the remote is `https://git.epicenter.so/<namespace id>.git` and nothing proposes a name; [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "A repository belongs to exactly one namespace", the role table, personal and group kinds, and "People never see the word namespace": a namespace is one repository, owners and members are its only relation, and people choose namespaces by name; [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "Every hosted repository belongs to one person's namespace", the deletion of `namespace_member`, and "a grant has no target": a namespace has owners and members, and a browser grant names exactly one namespace; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a checkpoint commit also follows a quiet period; [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "every `.json` file merges key by key" for `.epicenter.json`: a schema is never merged; [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at `field.optional` and the code column: optionality is the schema's `required` list; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`; [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at the command set and "`sync --to` is Connect": the v1 commands are listed below; [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at installing, forking, and the `app-` prefix on data folder names: in v1 Epicenter installs, forks, and names no app; [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) and [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at the data folder as the unit an app opens, `?folder=<id>`, `listFolders()`, and "A folder's directory name is its hosted repository's name, on every device": an app opens one namespace, and a clone may live in any directory; [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) at `template/` and "An author ships a change to their app's data as code": nothing is copied, and an app never changes an existing schema.
- **Relates:** [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md) describe the desktop host, which v1 defers and does not delete; [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) stands as the rule for what stays on one replica; [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) stands until the open question on origin-as-client is answered.
- **Unbuilt:** almost all of it: the `/<namespace id>.git` route and the deletion of the repository registry; namespace members, invites excepted; consent that lists namespaces and takes a suggested name; exact `ns:<id>` browser grants and tab-scoped tokens; `<table>/.epicenter.json` discovery and the deletion of the root `epicenter.json`; `ns.table(name, schema)`; per-table read-only opening; the `settings` table convention; quiet-period checkpoint commits; incremental capture; shallow tab fetch; the CLI's `namespaces`, `login`, `logout`, and `whoami`; and every deletion and blocker below.

## Context

Today a data folder is a directory whose root `epicenter.json` describes its
tables ([ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)).
Its author may keep `epicenter.ts`, built from `defineFolder`, `defineTable`,
and field builders such as `field.string()` and `field.optional()`, and run
`epicenter generate` to write the JSON
([ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md)).
An app opens a folder with the definition compiled into its code; when the
folder is named after the app, `open-at-root.ts` takes the app's definition as
the truth (`if (target.own) prepared = target.definition;`) and
`publishDefinition` in `packages/folder/src/publish-definition.ts` writes it
back. A hosted folder lives at `https://git.epicenter.so/<namespace>/<name>.git`
([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)),
in a namespace only one person reaches
([ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md)).
On the desktop, Epicenter installs each app as the person's fork, builds it,
and serves it at its own origin
([ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md));
a new folder copies its app's `template/` once
([ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md)).
A commit happens at Sync or when a person saves a version
([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)).

The owner chose a smaller first release on 2026-10-18: no desktop host, every
app a website, and the person's data a typed Git repository that the CLI and
any site read the same way. Three review rounds walked that shape against the
code at `7a05d60556`. They found that "every Markdown or JSON file beneath a
table is a row" turns the Vault's 134 page-local payloads into invalid rows;
that `capture()` in `packages/folder/src/git/history.ts` reads every portable
file's bytes, ignored ones included, before filtering, so a commit on every
save does not scale; that an app publishing its definition overwrites a schema
an agent wrote; and that the auth path shares one token per client across tabs
(`tokenKey` in `packages/auth/src/browser-oauth.ts`).

## Decision

The owner's words:

> Your data is Git repositories of Markdown with types. Epicenter is three
> things: a Git service that stores them, a CLI that types, checks, and
> queries them, and a library that lets any website open one.

```txt
                    git.epicenter.so/<namespace id>.git
                    THE GIT SERVICE: stores namespaces
                    owners and members, one token per grant
                       ▲                          ▲
             git fetch / push              isomorphic-git, shallow
                       │                          │
   THE CLI: types, checks, queries      THE LIBRARY: lets a website open one
   epicenter clone · check · query      @epicenter/folder in any site
   sync · namespaces · login            ns.table(name, schema)
   on your Mac, beside your agent       kanban.alice.dev, Whispering, your own
```

A namespace on disk, wherever it is cloned:

```txt
~/data/                          a clone of git.epicenter.so/<namespace id>.git
├── .gitignore                   what stays on one replica, e.g. recordings/*/audio.webm
├── cards/                       table "cards"
│   ├── .epicenter.json          its schema, literal JSON Schema
│   ├── abc.md                   row id "abc": frontmatter fields and a body
│   └── abc/                     row abc's own files, tracked or ignored
├── recordings/                  table "recordings"
│   ├── .epicenter.json
│   ├── r1.md                    row id "r1"
│   └── r1/audio.webm            ignored, so it stays on the replica that recorded it
├── settings/                    table "settings", open schema
│   ├── .epicenter.json
│   └── kanban.md                one row per app
└── attachments/                 no .epicenter.json: plain files, never rows
```

On the person's Mac, with an agent:

```bash
epicenter login
epicenter namespaces                      # id, name, owner or member
epicenter clone braden ~/data             # a name resolves among your namespaces
epicenter check ~/data                    # names every file that does not conform
epicenter query ~/data "select id, title from cards where column = 'doing'"
# the agent edits cards/abc.md, or writes cards/.epicenter.json
epicenter sync ~/data                     # checkpoint commit, merge, push
epicenter whoami
```

In a website:

```ts
import { openNamespace } from '@epicenter/folder';

// Signs in; the consent screen picks the namespace, suggesting "kanban".
const ns = await openNamespace({ suggest: 'kanban' });

// Get-or-create: makes cards/.epicenter.json if absent, never overwrites it.
const cards = await ns.table('cards', {
	type: 'object',
	properties: { title: { type: 'string' }, column: { type: 'string' } },
	required: ['title', 'column'],
});
if (cards.readOnly) showWhy(cards.problems); // the namespace's schema differs
cards.set('abc', { title: 'Ship v1', column: 'doing' });

// Settings that follow the person: one row in the open `settings` table,
// checked against this app's own schema. Keys and window state stay in the
// site's own storage.
const settings = await ns.table('settings', { type: 'object' });
settings.set('kanban', { wipLimit: 3 }, KanbanSettings);
```

The consent screen, at `api.epicenter.so`:

```txt
https://kanban.alice.dev wants to read and change everything in one namespace.
It suggests: kanban

  ( ) Braden                     owner
  (•) kanban                     owner      the only namespace named "kanban": preselected
  ( ) Create a namespace named "kanban"

                                         [Cancel]  [Allow]
```

When no namespace has the suggested name, the offer to create one is
preselected; when several do, nothing is preselected and the person chooses.

**A namespace is one Git repository at `https://git.epicenter.so/<namespace id>.git`.**
The id is opaque and never changes; the name is a free, non-unique label.
Deleted: repository names below a namespace, the `/<ns12>/<name>.git` route
grammar in `packages/server/src/routes/git.ts`, the repository registry in
`packages/server/src/repositories.ts` with its unused rename, move, and alias
code, `epicenter repos`, Connect, and `sync --to`. Cost: the permission unit
is the whole namespace, and every origin that opens one downloads its whole
current tree.

**A table is a top-level directory holding `.epicenter.json`, and a row is
`<table>/<id>.md` directly inside it.** `<table>/<id>/` holds that row's own
files. A name starting with `.` is never a row, and a `.json` file is a file,
never a row. A table name matches `^[a-z][a-z0-9_]*$` and does not start with
`sqlite_`; the row column is `id`, reserved. Tables are top level only.
Deleted: the root `epicenter.json`, its `app` and `title`, nested tables,
JSON rows, and ids containing `/`. Cost: rows have no folder hierarchy, so a
category is a field, and renaming or deleting a row must carry its `<id>/`.

**A schema is literal JSON Schema in `.epicenter.json`; TypeBox infers types
from it and validates rows against it.** Deleted: the field builders
(`field.string()`, `field.optional()`, and the rest), `epicenter.ts`,
`epicenter generate`, and `packages/folder/src/generate-declaration.ts`.
Cost: a person writing a schema by hand loses shared TypeBox constants; the
Vault's own 300-line `epicenter.ts` is the counter-case, and restoring it is
on the Deferred list.

**`ns.table(name, schema)` is get-or-create, and apps never change an
existing schema.** It creates the directory and `.epicenter.json` when absent
and never overwrites one. When the namespace's schema does not accept the
app's, that table opens read-only and the app says why; other tables are
unaffected. Fields a row holds that the schema does not declare are kept and
reported as warnings, never errors. People and agents change schemas. Deleted:
`publishDefinition`, `own` and `through`, `DefinitionMismatch` for a whole
folder, and app templates. Cost: every app needs a read-only state for each
table, and an app whose new version adds a field waits for an agent to add it.

**An app is a website, and Epicenter knows nothing about it.** No app
identity, no install, and no fork exist in v1. A setting that should follow
the person is the row `settings/<app>.md` in an open `settings` table,
checked by the app's own settings schema; device-local state stays in the
site's own storage. Deleted from v1: the declared app address, `epicenter.app.json`,
`epicenter app`, and the `app-` prefix rule. Cost: `<app>` in
`settings/<app>.md` is a name an app picks, not one Epicenter checks.

**A namespace has owners and members, many to many, and no role beyond
owner.** There is no nesting, no personal or group kind, and no "main"
namespace. Signup creates a first namespace. Consent lists the person's
namespaces, and an app may suggest a name: exactly one match is preselected,
none offers to create one, several make the person choose. The CLI resolves a
name among the person's namespaces and refuses an ambiguous one. Deleted: a
handle registry and the role table. Cost: every member can change everything,
and invites come later.

**A browser grant names exactly one namespace, `ns:<id>`, and its token
belongs to one tab.** The token's (server, account, namespace) binding never
changes after issue, and the authorization response returns the namespace to
the session. Deleted for browsers: `*` grants. Cost: a site that works with two
namespaces signs in twice.

**A save lands at once and is not a commit; a checkpoint commit happens at
Sync and after a quiet period.** Git history is the recovery. Cost: edits
between checkpoints are files, not history, so the finest point to recover is
the last checkpoint.

**The CLI is `clone`, `check`, `query`, `sync`, `namespaces`, `login`,
`logout`, and `whoami`, and it never edits or infers types or values.**
Deleted from v1: `init`, `generate`, `repos`, `sync --to`, and the `app`
group. Cost: an agent writes every schema itself.

**v1 is the CLI, the Git service, and browser apps.** The desktop host is
deferred, not deleted, and hosted AI is deferred as another scope on the same
token. The owner accepts first-party apps on subdomains, each with its own
storage; one shared origin stays an open question.

The principles of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
that change read:

- **Principle 2.** A namespace is one Git repository a person or several people own, cloned
  into any directory, with no second local name.
- **Principle 3.** A table's `.epicenter.json` governs only whether an app may write that
  table; nothing reads it to rewrite data.
- **Principle 5.** A table starts when someone first writes its schema; nothing is copied
  from an app.
- **Principle 9.** Machine state belongs to the site that holds it, or to the CLI.
- **Principle 10.** Epicenter offers no app hosting; its Git service accepts any Git content
  pushed to a namespace, and only that namespace's owners and members reach it.

### Refused

- The CLI editing or inferring a type or a value.
- An app changing a schema that exists.
- Nested tables, JSON rows, and row ids containing `/`.
- App identity anywhere in a namespace.
- Epicenter hosting apps.
- Any permission finer than a namespace.
- Running a namespace's TypeScript implicitly.
- Squashing history as a product feature.

### Deferred

- The desktop host (Tauri, native recording, local models, the Trash).
- Hosted AI.
- `epicenter.ts` authoring, restored beside the literal schema.
- Invites and a team interface.
- Links across namespaces.
- Partial clone.
- Syncing large audio files.
- WebKit and phone support.
- History cleanup by agents.
- A commit on every save.

### Limits v1 states

- Each origin downloads the whole namespace.
- One file another replica could not write back blocks Sync until it is fixed.
- When two writers change one field, the writer who syncs wins it.
- A rename plus an edit to the same row is not followed; the edit can be lost.
- Nothing repairs a reference when its target moves.
- Ignored files live only on the replica that wrote them.
- Revoking a member or a grant does not recall copies already cloned.
- "Apps never change schemas" and the `settings/<app>.md` convention are
  etiquette: a token reaches the whole namespace, so nothing enforces them.

### Correctness blockers, fixed before anything else ships

1. **Consent staging is not bound to the request.** `consentKey(session.id,
   clientId)` in `packages/server/src/auth/grant-target.ts` keys a staged
   choice by session and client, so one authorization request can consume
   another's choice. Bind it to the request.
2. **Renewal can switch namespace.** Silent renewal (`prompt: 'none'` in
   `packages/auth/src/browser-oauth.ts`) accepts whatever grant comes back.
   Pin it to the expected namespace and refuse any other.
3. **Browser grants target `*`.** `apps/api/worker/oauth-registrations.ts`
   gives first-party browser clients `*`. Every browser grant names exactly
   `ns:<id>`.
4. **Tabs share one token.** `tokenKey` is per client and server, so two tabs
   on two namespaces overwrite each other's token. Tokens become tab-scoped.
5. **Route grammar.** The Git route takes `<ns12>/<name>.git`; it becomes
   `<namespace id>.git`, and the repository registry goes.
6. **The publisher overwrites schemas.** `publishDefinition` writes the app's
   definition over the folder's; it becomes create-if-absent.
7. **Concurrent schema creation merges into a schema nobody wrote.**
   `packages/folder/src/merge-file.ts` merges an add/add `.json` key by key.
   Sync never merges `.epicenter.json`: the remote's copy stays, and the app
   whose schema lost sees that table read-only and says so.
8. **Capture reads ignored files.** `capture()` reads every portable file's
   bytes and filters by `.gitignore` afterward. Capture becomes incremental
   and never reads an ignored path.

### Open questions

- Benchmark results for capture and listing at 50,000 rows on a mid-range
  phone, and for isomorphic-git's `depth: 1` fetch, merge, and push.
- Existing hosted data: a production audit decides between a fresh start and
  a migration.
- Origin as client against client ID metadata documents (ADR-0606).
- Whether a push records the authenticated app origin, as an `App-Origin`
  trailer or a server log, since a commit's author is whatever the client
  claims.
- First-party apps on one origin sharing a clone, or on subdomains each with
  its own.

## Consequences

- A person's data is one repository per namespace. An agent works on it with
  Git and the CLI, and a website with the library, and both read the same
  files the same way.
- The Vault becomes a namespace by a fresh import: its tables already use
  plain names, and its `pages/<slug>/` payloads are row files under the flat
  row rule. Its 8.42 GiB history stays in the old repository.
- A table someone deletes comes back empty the next time an app that uses it
  opens, because get-or-create cannot tell absent from deleted. A table an
  agent renames splits the same way.
- Two apps that pick one table name share it. When their schemas agree, their
  rows mix; when they differ, one app opens it read-only. Choosing between
  sharing and a prefixed name has no home in v1, since app identity is refused.
- Settings follow the person only through `settings/<app>.md`; anything in
  site storage is re-entered on each device and left out of a clone.
- The desktop records stay accepted and unbuilt for v1, and none of v1's
  code depends on them.

## Considered alternatives

- **Every Markdown or JSON file under a table is a row, with its relative
  path as id.** It makes the Vault's 134 page payloads and each
  `.epicenter.json` into rows, collides `a.md` with `a.json`, and needs link
  repair when a directory moves.
- **A commit on every save.** `capture()` reads every file per commit, so one
  Whispering save would read all its audio; checkpoints at Sync and after
  quiet periods carry the recovery at a fraction of the reads.
- **An app may widen a schema it finds.** It finishes a customizer's update
  without an agent, but it makes the app a schema author, and the owner chose
  that apps never change schemas.
- **Keep `epicenter.ts` as the authored source.** It keeps `generate`, the
  only TypeScript the CLI runs, and a second file that can disagree with the
  JSON; it is deferred, not refused.
- **One repository per app inside a namespace (`<namespace>/<repo>.git`).**
  Every app then names a repository, which is app identity under another name,
  and sharing a table across apps needs a link across repositories.
- **Personal-only namespaces (ADR-0594).** A team then has no place to keep
  shared data without moving repositories between people.

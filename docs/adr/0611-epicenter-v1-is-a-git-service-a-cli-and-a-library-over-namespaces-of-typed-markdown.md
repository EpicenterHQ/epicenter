# 0611. Epicenter v1 is a Git service, a CLI, and a library over namespaces of typed Markdown

- **Status:** Proposed
- **Date:** 2026-10-18
- **Supersedes:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) (a data folder keeps `epicenter.ts`, and `epicenter generate <dir>` writes the `epicenter.json` it declares): a table's schema is the literal JSON Schema in its `.epicenter.json`, and nothing generates it.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at the root `epicenter.json`, its `app` and `title`, "never reads the folder's `epicenter.json`", and "A data folder is every real, non-dot directory directly in the Epicenter folder": each table carries `<table>/.epicenter.json`, an app reads it, and the unit a person owns is a namespace; [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principles 2, 3, 5, 9, and 10: principles 6 to 8 stand for the deferred desktop host and the rest read as restated below; [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `https://git.epicenter.so/<namespace>/<name>.git`, Connect, and the proposed name: the remote is `https://git.epicenter.so/<namespace id>.git` and nothing proposes a name; [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "A repository belongs to exactly one namespace", the role table, personal and group kinds, and "People never see the word namespace": a namespace is one repository, owners and members are its only relation, and people choose namespaces by name; [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "Every hosted repository belongs to one person's namespace", the deletion of `namespace_member`, and "a grant has no target": a namespace has owners and members, and a browser grant targets exactly one namespace; [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) at the client ID metadata document and the `cimd` plugin: a browser app's client id is its origin, and its first sign-in creates its client row; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a checkpoint commit also follows a quiet period; [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "every `.json` file merges key by key" for `.epicenter.json`: a schema merges as indivisible bytes; [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) at `field.optional` and the code column: optionality is the schema's `required` list; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at "A row is addressed by its stem, never by an id": the address is unchanged and its name is `id`; [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at the command set and "`sync --to` is Connect": the v1 commands are listed below; [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at installing, forking, and the `app-` prefix on data folder names: in v1 Epicenter installs, forks, and names no app; [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) and [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at the data folder as the unit an app opens, `?folder=<id>`, `listFolders()`, and "A folder's directory name is its hosted repository's name, on every device": an app opens one namespace, and a clone may live in any directory; [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) at `template/` and "An author ships a change to their app's data as code": nothing is copied, and an app never changes an existing schema.
- **Relates:** [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md) describe the desktop host, which v1 defers and does not delete; [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) stands as the rule for what stays on one replica and as the list of what sync refuses.
- **Unbuilt:** almost all of it: the five engine fixes; `<table>/.epicenter.json` discovery and the deletion of the root `epicenter.json`; the reader that describes and never refuses; the `/<namespace id>.git` route and the deletion of the repository registry; namespace members, invites excepted; origin-as-client registration and (account, origin, namespace) grants; consent that lists namespaces and takes a suggested name; `@epicenter/data` and its `open()`; quiet-period checkpoint commits; server-side gc; the CLI's `sync [namespace] [dir]`, `login`, `logout`, and `whoami`; and every deletion and blocker below.

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
A third-party browser app signs in with a client ID metadata document on its
origin ([ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md)).
On the desktop, Epicenter installs each app as the person's fork, builds it,
and serves it at its own origin
([ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md));
a new folder copies its app's `template/` once
([ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md)).
A commit happens at Sync or when a person saves a version
([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)).

The owner chose a smaller first release on 2026-10-18: no desktop host, every
app a website, and the person's data a typed Git repository that the CLI and
any site read the same way. Review rounds walked that shape against the code
at `7a05d60556`. They found that "every Markdown or JSON file beneath a table
is a row" turns the Vault's 134 page-local payloads into invalid rows; that
`capture()` in `packages/folder/src/git/history.ts` reads every portable
file's bytes, ignored ones included, before filtering; that an app publishing
its definition overwrites a schema an agent wrote; that a schema refusing
writes stops an app whose schema is one field behind the namespace's; and that
the auth path shares one token per client across tabs (`tokenKey` in
`packages/auth/src/browser-oauth.ts`). A benchmark measured the Git engine at
10,000 rows: a native sync took 47 s and a browser clone 110 s.

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
             git fetch / push               isomorphic-git
                       │                          │
   THE CLI: types, checks, queries      THE LIBRARY: lets a website open one
   epicenter sync · check · query       @epicenter/data in any site
   login · logout · whoami              open({ tables })
   on your Mac, beside your agent       kanban.alice.dev, Whispering, your own
```

A namespace on disk, wherever it is cloned:

```txt
~/Epicenter/studio/              a clone of git.epicenter.so/<namespace id>.git
├── .gitignore                   what stays on one replica, e.g. recordings/*/audio.webm
├── cards/                       table "cards"
│   ├── .epicenter.json          its schema, literal JSON Schema
│   ├── abc.md                   row id "abc": frontmatter fields and a body
│   └── abc/                     row abc's own files, tracked or ignored
├── recordings/                  table "recordings"
│   ├── .epicenter.json
│   ├── r1.md                    row id "r1"
│   └── r1/audio.webm            ignored, so it stays on the replica that recorded it
├── kanban_settings/             an outside app's settings table, prefixed
│   ├── .epicenter.json
│   └── default.md
└── attachments/                 no .epicenter.json: plain files, never rows
```

On the person's Mac, with an agent:

```bash
epicenter login
epicenter whoami                          # the account and its namespaces
epicenter sync studio                     # clones into ~/Epicenter/studio/ if absent
epicenter check ~/Epicenter/studio        # reports every value that does not fit
epicenter query ~/Epicenter/studio "select id, title from cards where column = 'doing'"
# the agent edits cards/abc.md, or edits cards/.epicenter.json
cd ~/Epicenter && epicenter sync          # every namespace under ~/Epicenter
```

In a website:

```ts
import { open, type Namespace } from '@epicenter/data';

const CardSchema = {
	type: 'object',
	properties: { title: { type: 'string' }, column: { type: 'string' } },
	required: ['title', 'column'],
} as const;

// Signs in; the consent screen picks the namespace, suggesting "studio".
// Creates cards/ and cards/.epicenter.json if absent; never overwrites one.
const ns: Namespace = await open({ namespace: 'studio', tables: { cards: CardSchema } });

for (const row of await ns.tables.cards.list()) {
	if (row.ok) render(row.value); // typed from CardSchema
	else showRaw(row.raw, row.reason); // the file's data, and why it does not fit
}
await ns.tables.cards.set('abc', { title: 'Ship v1', column: 'doing' });
await ns.tables.cards.files('abc').write('cover.png', bytes);
ns.namespace; // { id, name }
ns.status; // the sync badge, read only
```

```svelte
<Epicenter namespace="studio" tables={{ cards: CardSchema }} />
```

The consent screen, at `api.epicenter.so`:

```txt
https://kanban.alice.dev wants to read and change everything in one namespace.
It suggests: studio

  ( ) Braden                     owner
  (•) studio                     member     the only namespace named "studio": preselected
  ( ) Create a namespace named "studio"

                                         [Cancel]  [Allow]
```

When no namespace has the suggested name, the offer to create one is
preselected; when several do, or the suggestion is ambiguous, nothing is
preselected and the person chooses.

**A namespace is one Git repository at `https://git.epicenter.so/<namespace id>.git`.**
The id is its identity and never changes; the name is a free, non-unique
label, and no handle registry exists. Deleted: repository names below a
namespace, the `/<ns12>/<name>.git` route grammar in
`packages/server/src/routes/git.ts`, the repository registry in
`packages/server/src/repositories.ts` with its unused rename, move, and alias
code, `epicenter repos`, Connect, and `sync --to`. Cost: the permission unit
is the whole namespace, and every origin that opens one downloads its whole
current tree.

**A namespace has owners and members, many to many, and no role beyond
owner.** There is no nesting, no personal or org kind, and no "main"
namespace. Signup creates a first namespace; invites come later. Deleted: the
role table. Cost: every member can change everything.

**A table is a top-level directory holding `.epicenter.json`, and a row is a
`.md` file directly inside it whose name does not start with `.`.** The row's
id is its file name without `.md`, and `<table>/<id>/` holds the row's own
files. Renaming a row changes its id and breaks links to it; no stable id
exists. One row predicate, beside `rowStemOf` in `packages/folder/src/paths.ts`,
decides rowhood for the library, `check`, `query`, and sync. The SQL row
column `stem` is renamed `id`. Deleted: the root `epicenter.json`, its `app`
and `title`, nested tables, JSON rows, and ids containing `/`. Cost: rows have
no folder hierarchy, so a category is a field.

**A schema is literal JSON Schema in `.epicenter.json`; TypeBox infers types
from it and validates rows against it.** Deleted: the field builders
(`field.string()`, `field.optional()`, and the rest), `epicenter.ts`,
`epicenter generate`, and `packages/folder/src/generate-declaration.ts`.
Cost: a person writing a schema by hand loses shared TypeBox constants; the
Vault's own 300-line `epicenter.ts` is the counter-case, and restoring it is
on the Deferred list.

**The schema describes and never refuses.** Every write is accepted.
`epicenter check` reports what does not fit, with undeclared fields and type
mismatches as warnings. `epicenter query` types the columns a schema declares
and shows every row, with `NULL` for a value that does not fit its column. Each
reader validates against its own schema, and a row that does not fit reaches
it as raw data with the reason. Refused, as before, is only what Git cannot
represent, the list in
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md).
Deleted: table-level read-only opening, exact-match and add-only schema
comparison, `replaces`, schema containment, and validation on write. Cost:
nothing stops a malformed row from landing; it shows up in `check` and as a
raw row in every reader.

**A table is get-or-create, and an app never changes an existing schema.**
`open({ tables })` creates an absent table's directory and `.epicenter.json`
and never overwrites one that exists. Changing a schema is an edit a person or
an agent makes. `.epicenter.json` merges as indivisible bytes: when two
replicas change it, the remote's copy wins. Deleted: `publishDefinition`,
`own` and `through`, `DefinitionMismatch`, and app templates. Cost: a table
someone deletes comes back empty the next time an app that names it opens.

**The library knows tables, rows, and row files, and nothing else.** It has
no settings concept and no namespace-wide file API. Settings are a
convention: a family of first-party apps may share a plain `settings` table
with one row per app, and an outside app prefixes its table
(`kanban_settings`). Device-local state lives in the site's own storage.

**`open()` is the whole app API.** Its shape:

```txt
open({ namespace?: string, tables: { <name>: <literal JSON Schema> } }): Promise<Namespace>
  const-generic, so ns.tables is typed from the literal schemas
  a schema with additionalProperties: false is refused, so unknown fields stay warnings
ns.tables.<t>.list()              rows: { ok: true, id, value } | { ok: false, id, raw, reason }
ns.tables.<t>.get(id)             one row of the same shape, or undefined
ns.tables.<t>.set(id, fields)     upsert; fields it does not name are kept
ns.tables.<t>.delete(id)
ns.tables.<t>.files(id).write(name, bytes)
ns.namespace                      { id, name }
ns.status                         the sync badge, read only
<Epicenter namespace tables>      the Svelte component over open()
```

There is no `ns.table()`, and apps have no `sync()`. A row with a `<id>/`
directory cannot be renamed or deleted through the library in v1. Cost: an
app that needs either sends the person to an agent or the CLI.

**An app is its origin, and its origin is its OAuth `client_id`; no developer
registers anything.** The first sign-in from an origin creates its client row:
a public client, PKCE `S256`, the fixed callback `${origin}/auth/callback`,
matched exactly on origin, a `localhost` port included. CORS is chosen by
route, as [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md)
states it. Deleted for v1: client ID metadata documents and the `cimd` plugin.

**A grant is (account, origin, namespace).** It carries fixed operation scopes
and names the namespace as its target, `referenceId = ns:<id>`, never as an
OAuth scope. A browser never gets `*`, no browser client has `skipConsent`,
one grant exists per tuple, and revoking a grant retires its tokens. Consent
takes an optional `namespace:` suggestion and resolves it as drawn above;
creating from consent is idempotent. The choice is bound to the server's
authorization transaction, and membership is checked again when it is used.
The browser keys its token by the grant (server, account, origin, namespace),
and renewal is pinned to the same namespace. When a token expires, local
editing continues and the app offers Reconnect without navigating the page.
Cost: a site that works in two namespaces holds two grants.

**A save lands at once and is not a commit; a checkpoint commit happens at
sync and after a quiet period.** Sync is invisible to apps, and Git history is
the recovery. Cost: edits between checkpoints are files, not history, so the
finest point to recover is the last checkpoint.

**Git stays in the browser, and the namespace is the unit of size.** An app's
namespace is small enough for a tab; a large archive such as the owner's
Vault is its own namespace, used CLI-first. The engine needs five fixes,
from a benchmark at 10,000 rows:

1. One shared Git object cache: native sync 47 s to 3.1 s, browser clone
   110 s to 43 s.
2. Fetch negotiation that sends the remote-tracking ref as a `have`.
3. Pushes that stop at what the server already has.
4. Incremental capture that never reads an ignored path.
5. `git gc` on the server.

As shipped, a tab is comfortable to about 500 rows; after fixes 1 and 2, to
3,000 to 5,000. The CLI is comfortable to 20,000 to 25,000 rows with fix 1.
Partial clone needs a client other than isomorphic-git and is deferred.

**The CLI is `sync [namespace] [dir]`, `check`, `query`, `login`, `logout`,
and `whoami`, and it never edits or infers types or values.** `sync` clones
when the directory does not exist; with no argument inside `~/Epicenter` it
syncs every namespace under it. The default mirror is
`~/Epicenter/<namespace name>/`, with a short id suffix when two namespaces
share a name. The directory listing is the only local registry, and a clone
anywhere else still works. `whoami` lists the account's namespaces. Deleted
from v1: `init`, `generate`, `clone`, `namespaces`, `repos`, `sync --to`, and
the `app` group. Cost: an agent writes every schema itself.

**v1 is the CLI, the Git service, and browser apps.** The desktop host is
deferred, not deleted. Hosted AI is deferred, to arrive as another grant
scope.

The principles of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
that change read:

- **Principle 2.** A namespace is one Git repository a person or several
  people own, cloned into any directory, with no second local name.
- **Principle 3.** A table's `.epicenter.json` describes its rows; nothing
  reads it to refuse a write or to rewrite data.
- **Principle 5.** A table starts when someone first writes its schema;
  nothing is copied from an app.
- **Principle 9.** Machine state belongs to the site that holds it, or to the
  CLI.
- **Principle 10.** Epicenter offers no app hosting; its Git service accepts
  any Git content pushed to a namespace, and only that namespace's owners and
  members reach it.

### Refused

- A schema refusing a write; sync refuses only what Git cannot represent.
- The CLI editing or inferring a type or a value.
- An app changing a schema that exists.
- Nested tables, JSON rows, and row ids containing `/`.
- A settings concept or a namespace-wide file API in the library.
- Developer registration of an app.
- `*` grants and `skipConsent` for browser clients.
- Epicenter hosting apps.
- Any permission finer than a namespace.
- Running a namespace's TypeScript implicitly.
- Squashing history as a product feature.

### Deferred

- The desktop host (Tauri, native recording, local models, the Trash).
- Hosted AI, as another grant scope.
- `epicenter.ts` authoring, restored beside the literal schema.
- Invites and a team interface.
- Renaming or deleting a row with a `<id>/` directory through the library.
- Links across namespaces.
- Partial clone.
- Syncing large audio files.
- WebKit and phone support.
- History cleanup by agents.
- A commit on every save.

### Limits v1 states

- Each origin downloads the whole namespace.
- A tab is comfortable to about 500 rows as shipped and 3,000 to 5,000 after
  engine fixes 1 and 2; the CLI to 20,000 to 25,000 with fix 1.
- One file another replica could not write back blocks sync until it is fixed.
- When two writers change one field, the writer who syncs wins it.
- When two replicas change one `.epicenter.json`, the remote's copy wins whole.
- A rename plus an edit to the same row is not followed; the edit can be lost.
- Renaming a row breaks every link to it, and nothing repairs them.
- Ignored files live only on the replica that wrote them.
- Revoking a member or a grant does not recall copies already cloned.
- "Apps never change schemas" and the settings prefix are etiquette: a token
  reaches the whole namespace, so nothing enforces them.

### Correctness blockers, fixed before anything else ships

1. **Consent staging is not bound to the request.** `consentKey(session.id,
   clientId)` in `packages/server/src/auth/grant-target.ts` keys a staged
   choice by session and client, so one authorization request can consume
   another's choice. Bind it to the server's authorization transaction.
2. **Renewal can switch namespace.** Silent renewal (`prompt: 'none'` in
   `packages/auth/src/browser-oauth.ts`) accepts whatever grant comes back.
   Pin it to the expected namespace and refuse any other.
3. **Browser grants target `*`.** `apps/api/worker/oauth-registrations.ts`
   gives first-party browser clients `*`. Every browser grant names exactly
   `ns:<id>`.
4. **Tabs share one token.** `tokenKey` is per client and server, so two tabs
   on two namespaces overwrite each other's token. The token is keyed by its
   grant.
5. **Route grammar.** The Git route takes `<ns12>/<name>.git`; it becomes
   `<namespace id>.git`, and the repository registry goes.
6. **The publisher overwrites schemas.** `publishDefinition` writes the app's
   definition over the folder's; it becomes create-if-absent.
7. **Schema merges produce a schema nobody wrote.**
   `packages/folder/src/merge-file.ts` merges an add/add `.json` key by key.
   `.epicenter.json` merges as indivisible bytes, and the remote wins.
8. **Capture reads ignored files.** `capture()` reads every portable file's
   bytes and filters by `.gitignore` afterward. Capture becomes incremental
   and never reads an ignored path.
9. **Revoking consent does not retire tokens.** Revoking a grant retires
   every token issued under it.
10. **Row files are left behind.** Renaming or deleting a row leaves its
    `<id>/` directory behind. The library refuses both for a row that has
    one, and a person or agent moves or removes the directory with the row.

### Build order

1. The five engine fixes.
2. The data model in `packages/folder`: table discovery, the one row
   predicate, the `id` column, and the reader that describes and never
   refuses.
3. The server: a namespace is one repository, owners and members, and gc.
4. Auth: origin as client, and (account, origin, namespace) grants.
5. The `@epicenter/data` library.
6. The CLI.
7. Todos ported first, then the other apps.
8. The Vault as its own namespace.

### Open questions

- Existing hosted data: a production audit decides between a fresh start and
  a migration.
- First-party apps on subdomains, each with its own clone, or on one origin
  sharing one.

## Consequences

- A person's data is one repository per namespace. An agent works on it with
  Git and the CLI, and a website with the library, and both read the same
  files with the same row predicate.
- A row that does not fit never disappears: `query` shows it with `NULL`s,
  `check` names it, and the library hands it back raw with its reason. An app
  whose schema lags the namespace's keeps working on the rows that fit.
- The Vault becomes a namespace by a fresh import: its tables already use
  plain names, and its `pages/<slug>/` payloads are row files under the flat
  row rule. Its 8.42 GiB history stays in the old repository, and at its size
  it is used through the CLI.
- A table someone deletes comes back empty the next time an app that names it
  opens, because get-or-create cannot tell absent from deleted. A table an
  agent renames splits the same way.
- Two apps that pick one table name share it and each validates it against
  its own schema. An outside app avoids that by prefixing.
- Settings follow the person only through a settings row; anything in site
  storage is re-entered on each device and left out of a clone.
- An origin becomes a client the first time someone signs in from it, so the
  client table grows by one row per origin, every `localhost` port included.
- The desktop records stay accepted and unbuilt for v1, and none of v1's code
  depends on them.

## Considered alternatives

- **Every Markdown or JSON file under a table is a row, with its relative
  path as id.** It makes the Vault's 134 page payloads and each
  `.epicenter.json` into rows, collides `a.md` with `a.json`, and needs link
  repair when a directory moves.
- **A schema that refuses writes, with a table opening read-only on a
  mismatch.** Every app then needs a read-only state per table, and an app one
  field behind the namespace's schema stops writing until an agent catches up.
- **A stable row id beside the file name.** It keeps links across renames but
  puts a second identity in every file, which a person editing by hand can
  break.
- **A commit on every save.** `capture()` reads every file per commit, so one
  Whispering save would read all its audio; checkpoints at sync and after
  quiet periods carry the recovery at a fraction of the reads.
- **An app may widen a schema it finds.** It finishes a customizer's update
  without an agent, but it makes the app a schema author, and the owner chose
  that apps never change schemas.
- **Keep `epicenter.ts` as the authored source.** It keeps `generate`, the
  only TypeScript the CLI runs, and a second file that can disagree with the
  JSON; it is deferred, not refused.
- **Client ID metadata documents (ADR-0606).** Each app then hosts a JSON
  document restating what its origin already says.
- **The namespace as an OAuth scope.** Scopes are fixed per operation, and a
  namespace chosen at consent is a target, which `referenceId` carries.
- **One repository per app inside a namespace (`<namespace>/<repo>.git`).**
  Every app then names a repository, which is app identity under another name,
  and sharing a table across apps needs a link across repositories.
- **A desktop host or a non-Git browser store for large data.** Each adds a
  second runtime; a large archive in its own CLI-first namespace keeps every
  app namespace at a size a tab can sync.
- **Personal-only namespaces (ADR-0594).** A team then has no place to keep
  shared data without moving repositories between people.

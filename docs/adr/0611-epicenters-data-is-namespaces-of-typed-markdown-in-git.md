# 0611. Epicenter's data is namespaces of typed Markdown in Git

- **Status:** Proposed
- **Date:** 2026-10-18
- **Amends:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a checkpoint commit also follows a quiet period; [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at the command set and "`sync --to` is Connect": the v1 commands are listed below; [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principle 9: principles 6 to 8 stand for the desktop host that follows v1, and principle 9 reads as restated below; [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at installing, forking, and the `app-` prefix on data folder names: in v1 Epicenter installs, forks, and names no app; [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at `?folder=<id>` and a data folder as the unit an app opens: an app opens one namespace with `open()`; [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at `listFolders()` and "A folder's directory name is its hosted repository's name, on every device": a clone may live in any directory, and the default mirror is `~/Epicenter/<namespace name>/`.
- **Relates:** [0612](0612-a-namespace-is-one-git-repository-shared-by-its-members.md) (the namespace), [0613](0613-a-tables-schema-describes-its-rows-without-refusing-writes.md) (tables, rows, and the library's surface), and [0614](0614-a-browser-app-is-identified-by-its-origin.md) (sign-in and grants) carry the rest of the v1 model; [ADR-0586](0586-you-open-a-folder-never-an-app.md), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md), [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md), [ADR-0602](0602-folderapp-names-its-app-by-the-last-segment-of-its-address.md), and [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md) describe the desktop host, which follows v1 and is not deleted; [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) stands as the rule for what stays on one replica and as the list of what sync refuses.
- **Unbuilt:** almost all of it: the five engine fixes; quiet-period checkpoint commits; the `@epicenter/data` package; the CLI's `sync [namespace] [dir]`, `login`, `logout`, and `whoami`; the `~/Epicenter/<namespace name>/` mirror; and every blocker below.

## Context

On the desktop, Epicenter installs each app as the person's fork, builds it,
and serves it at its own origin
([ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md)).
An app opens a data folder named by `?folder=<id>`
([ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md)),
and a folder's directory name is its hosted repository's name
([ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md)).
A commit happens at Sync or when a person saves a version
([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)).
The CLI in `packages/cli/src/commands.ts` carries `generate`, `clone`,
`repos`, `sync --to`, the `app` group, and the `auth` group
([ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md)).

The owner chose an order for the first release on 2026-10-18: the data layer,
the CLI, and browser apps first, the desktop host after them, every v1 app a
website, and the person's data a typed Git repository that the CLI and
any site read the same way. Review rounds walked that shape against the code
at `7a05d60556`. They found that `capture()` in
`packages/folder/src/git/history.ts` reads every portable file's bytes,
ignored ones included, before filtering, so a commit on every save does not
scale. A benchmark measured the Git engine at 10,000 rows: a native sync took
47 s and a browser clone 110 s.

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

A namespace on disk, wherever it is cloned
([0612](0612-a-namespace-is-one-git-repository-shared-by-its-members.md),
[0613](0613-a-tables-schema-describes-its-rows-without-refusing-writes.md)):

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

**v1 builds the Git service, the CLI, and browser apps first; the desktop
host follows.** The desktop host arrives progressively after v1, on the same
namespaces. Hosted AI arrives later as another grant scope. First-party apps
live on subdomains, each origin with its own clone. An app opens one namespace through `open()` from `@epicenter/data`,
whose surface [0613](0613-a-tables-schema-describes-its-rows-without-refusing-writes.md)
pins. Withdrawn before it was built: `?folder=<id>` and `listFolders()`.
Deleted from v1: Epicenter installing, forking, or naming an app, and the
`app-` prefix rule.

**A save lands at once and is not a commit; a checkpoint commit happens at
sync and after a quiet period.** Sync is invisible to apps: they have no
`sync()`, only the read-only `ns.status`. Git history is the recovery. Cost:
edits between checkpoints are files, not history, so the finest point to
recover is the last checkpoint.

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
anywhere else still works. `whoami` lists the account's namespaces.
`auth login`, `auth logout`, and `auth status` become `login`, `logout`, and
`whoami`. Deleted from v1: `generate`, `clone`, `repos`, `sync --to`, and the
`app` group. Cost: an agent writes every schema itself.

Principle 9 of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
reads: machine state belongs to the site that holds it, or to the CLI.

### Continuity

The shape on disk stays familiar: `~/Epicenter/<namespace>/<table>/<row>.md`,
where it was `~/Epicenter/<folder>/<table>/<row>.md`. What changes is that
many apps share one namespace, each table carries its own schema, the schema
describes and never refuses, and apps have no identity in the data.

### Refused

- A schema refusing a write; sync refuses only what Git cannot represent.
- A schema with `additionalProperties: false` passed to `open()`.
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

- The desktop host (Tauri, native recording, local models, the Trash), built
  progressively after v1.
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
5. **Route grammar.** The Git route in `packages/server/src/routes/git.ts`
   takes `<namespace>/<name>.git`; it becomes `<namespace id>.git`, and the
   repository registry goes.
6. **The publisher overwrites schemas.** `publishDefinition` writes the app's
   definition over the folder's. It is deleted; `open()` writes a schema only
   when the table is absent.
7. **Schema merges produce a schema nobody wrote.** `merge` in
   `packages/folder/src/merge-file.ts` merges a `.json` that both replicas
   changed from a common base key by key (`jsonWins`). `.epicenter.json`
   merges as indivisible bytes, and the remote wins.
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
2. The data model in `packages/folder`:
   - 2a. Per-table `.epicenter.json` discovery, the one row predicate, and
     `stem` renamed `id`.
   - 2b. The reader that describes and never refuses; containment
     (`mismatches`) and publishing (`publishDefinition`) deleted.
   - 2c. Literal JSON Schema; the field builders deleted across the apps.
3. The server: a namespace is one repository, owners and members, and gc.
4. Auth: origin as client, and (account, origin, namespace) grants.
5. The `@epicenter/data` library, with a fetch before any table is created so
   get-or-create never creates over an unfetched remote, browser storage
   (OPFS) keyed by namespace id. No package is published to npm.
6. The CLI.
7. Todos ported first, then the other apps.
8. The Vault as its own namespace.

### Open questions

- Existing hosted data: a production audit decides between a fresh start and
  a migration.

## Consequences

- A person's data is one repository per namespace. An agent works on it with
  Git and the CLI, and a website with the library, and both read the same
  files with the same row predicate.
- The Vault becomes a namespace by a fresh import: its tables already use
  plain names, and its `pages/<slug>/` payloads are row files under the flat
  row rule. Its 8.42 GiB history stays in the old repository, and at its size
  it is used through the CLI.
- Settings follow the person only through a settings row; anything in site
  storage is re-entered on each device and left out of a clone.
- The desktop records stay accepted and unbuilt through v1, and none of v1's
  code depends on them; the desktop host builds on v1's namespaces.

## Considered alternatives

- **A commit on every save.** `capture()` reads every file per commit, so one
  Whispering save would read all its audio; checkpoints at sync and after
  quiet periods carry the recovery at a fraction of the reads.
- **A non-Git browser store for large data.** It adds a second storage
  runtime; a large archive in its own CLI-first namespace keeps every app
  namespace at a size a tab can sync.
- **The desktop host first.** It puts the native shell ahead of the data
  model every host shares, so the browser apps and the CLI wait on it.
- **One record for the whole v1 model.** Its three independent decisions
  would be accepted or revised together, so the namespace, the table, and the
  sign-in each have their own record.

# Epicenter architecture

Epicenter keeps a person's data in data folders: directories of Markdown and
JSON files with Git history beside them. Apps read and write those files, a
person or an agent can edit them with any tool, and a folder travels between
machines only when someone syncs it over Git.

This page is the five-minute map. Durable decisions live in
[`docs/adr`](adr/README.md). Shared vocabulary lives in
[`docs/CONTEXT.md`](CONTEXT.md). Package-owned behavior belongs in package
READMEs and code; start with [`apps/README.md`](../apps/README.md) and the
[folder package](../packages/folder/README.md).

## Data folders are the only data model

A data folder is the one way an app keeps and syncs data
([ADR-0534](adr/0534-data-folders-are-the-only-data-model.md)). The Yjs store,
its sync Durable Objects, and the apps built only on it are deleted.

```txt
~/Epicenter/so.epicenter.todos/
  epicenter.json        the folder's declaration: its tables and settings
  kv.json               settings
  todos/<id>.md         one row per file: YAML frontmatter fields, Markdown body
  recordings/...        ordinary files, including blobs
  .git/                 history, and the remote in remote.origin.url
```

- **The files are the data.** No cache, event, or window state is
  authoritative
  ([ADR-0548](adr/0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md)).
- **A folder is the directory its ID names.** In a browser that is
  `<OPFS root>/<id>/`; on the desktop it is `~/Epicenter/<id>/`. No account,
  scope, or marker is part of the address, so signing in or out opens the same
  folder
  ([ADR-0532](adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).
- **A folder declares its shape and names no app.** An app opens any folder
  whose `epicenter.json` contains the tables and fields it reads. The app that
  creates a folder publishes its declaration; every other app opens it with a
  lens and never rewrites it
  ([ADR-0535](adr/0535-an-existing-folder-opens-with-its-own-declaration.md),
  [ADR-0538](adr/0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md)).
- **One write path.** `table.save` merges by field, and the body by line, when
  the file changed since it was read, and reports what it replaced. Sync uses
  the same merge and asks the person only about overlapping edits.
- **Transfers happen only when a person syncs**
  ([ADR-0489](adr/0489-folder-transfers-happen-only-when-a-person-syncs.md)).
  Nothing syncs in real time. An incoming update that stops partway leaves
  ordinary changed files, and the next Sync finishes it
  ([ADR-0545](adr/0545-an-interrupted-incoming-update-is-ordinary-changed-files-and-the-next-sync-finishes-it.md)).

## One folder engine, three hosts

`@epicenter/folder` is the engine: tables, `kv`, files, history, merge, and
Sync. Every host returns the same `Folder` handle
([ADR-0533](adr/0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md)).

| Host | Entry | Storage | History |
| --- | --- | --- | --- |
| Browser tab | `@epicenter/folder` | the origin's private file system | isomorphic-git over a private `.git` |
| Desktop page | `@epicenter/folder` | `~/Epicenter/<id>/`, through the shell | the system `git`, run by the shell |
| Bun process (tests, scripts) | `@epicenter/folder/bun` | the directory it is given | the system `git`, run itself |

`openFolder` picks the browser or desktop adapter with `isTauri()` when it is
called. A desktop page that cannot open its folder gets that refusal, never
browser storage. Declarations come from `@epicenter/definition`.

## The shell grants the directory and checks every write

On the desktop the page runs the engine; the Tauri shell owns the disk
([ADR-0531](adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
`tauri-plugin-epicenter-folder` grants each window the folders it may edit and
then makes every read and every change itself:

- One path rule, shared by the engine (`pathProblem`) and the shell
  (`path_problem`), refuses `.git`, `HEAD`, and any name that does not mean
  only itself on every disk.
- A change must be a data path, checked on disk with no link on the way. A
  publish carries what the page expects at the path (nothing, a file, or a
  SHA-256), and Rust checks it under one lock per root, so a save another
  window overtook is a `Conflict` rather than a lost write.
- Rust runs no `git`. A page's history (status, the log, Save version, and
  Sync) runs in the `epicenter` CLI, one child per operation over a root the
  window was granted, with hooks and fsmonitor off and a remote that must be
  a network URL
  ([ADR-0559](adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).
  A reload or a closed window ends that window's children.
- One file watcher per granted root emits `epicenter-folder://changed` to the
  windows that hold the folder, so an edit in one window reaches the others.

Quitting is immediate. Every save is an atomic rename and long-running work
writes into its folder from the start, so no window is asked before the app
exits ([ADR-0542](adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md),
[ADR-0543](adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).

## Epicenter opens to your folders

The Epicenter desktop app (`apps/epicenter`) opens to its Folders window
([ADR-0537](adr/0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md)).
It lists every folder under `~/Epicenter` that holds an `epicenter.json`,
opens one with its own declaration, edits its rows, and offers every installed
app as "Open in"; an app refuses a folder its lens does not fit. Settings (the
`home` window) keeps Chat and model administration.

Epicenter's own folder is `~/Epicenter/so.epicenter`. What a person or agent
edits lives in folders; what only Epicenter writes, such as `approvals.json`,
lives in app data; built bundles live in Caches
([ADR-0539](adr/0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md)).

## Built-in and installed apps

Epicenter compiles in only its Folders window, served below `/apps/<id>/`.
Todos, Capture, Whispering, and Honeycrisp are installed apps
([ADR-0552](adr/0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)).
The Git lab ships its own desktop shell over the same engine. Vocab runs in
the browser.

An installed app is a folder holding `epicenter.app.json` in a Git
repository, the repository's root unless installing names another folder.
Epicenter clones the repository into `~/Epicenter/Apps/<app-id>/`, builds the
app, and runs a
commit fetched from elsewhere only after a person approves it. Approval trusts
the app's code fully; it never makes a synced folder trusted
([ADR-0540](adr/0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)).
The first-party apps install from their folders in Epicenter's own
repository, such as `apps/todos`.

## Sync is Git

A folder syncs over plain Git to the remote in its own Git configuration
([ADR-0521](adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)).
On the desktop that can be any Git remote. Epicenter's hosted Git keeps
repositories in Cloudflare Artifacts: today `POST /api/git/connect` in
`packages/server/src/routes/git.ts` finds or creates a folder's repository
and answers a short-lived write token for it.

Unbuilt, decided:

- Hosted remotes at `https://git.epicenter.so/<namespace>/<name>.git`, where
  Connect sets the remote and the first push creates the repository
  ([ADR-0546](adr/0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)).
- One owner namespace per repository, with a person as a namespace of one
  ([ADR-0547](adr/0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md)).
- Blobs as files in the folder, with `.gitattributes` choosing LFS and
  Epicenter's blob storage serving as the LFS server
  ([ADR-0544](adr/0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md)).

## Auth and the hosted API

`apps/api` is the hosted Cloudflare Worker, built on the shared Hono package
`packages/server`: auth, hosted Git, AI, blobs, and billing. Billing is
hosted-only and lives in `apps/api/worker/billing/`. The same app runs on Bun
against Postgres (`apps/api/server.ts`), which is how someone self-hosts. Today every hosted
request carries a Better Auth session, issued per client through
`sessionHandoff`.

Unbuilt, decided: every Epicenter resource accepts only opaque access tokens
from one OAuth 2.1 authorization server, with device login behind
`epicenter login` and `epicenter git-credential`
([ADR-0549](adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)),
and an MCP server at `https://mcp.epicenter.so/mcp` reaches hosted folders
through grants that target namespaces
([ADR-0550](adr/0550-epicenters-mcp-server-reaches-hosted-folders-through-grants-that-target-namespaces.md)).

## Implementation status

ADRs describe decisions, not a build report. Each recent ADR lists what is
built and unbuilt in its header; check those lines and the affected code
before treating a decision as shipped.

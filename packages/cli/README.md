# @epicenter/cli

`check` and `format` read or rewrite a folder against its contract, its own
`epicenter.json` (ADR-0805), or an app's named by `--contract` as a URL or a
file path. See [shared vocabulary](../../docs/CONTEXT.md).

The `epicenter` command. Each command is a thin wrapper over a function in a
shared package; the CLI parses, prints, and picks the exit code, and holds no
logic a page or the browser also needs (ADR-0556). The
implemented command surface retains ADR-0558's `auth` group; its `app` group
is deleted. ADR-0611 describes the planned reduction.

```sh
bun run epicenter check path/to/folder   # from the repository root
```

The command line is the platform without windows (ADR-0817): every
operation on folders is a function in `@epicenter/folder/platform`, which
the Epicenter app composes too, and a command here. A command takes a
folder by its path, or a folder on the server by its id; a person by the
email they sign in with. `sync`, `clone`, `log`, `diff`, and `restore` keep
a folder in sync with its folder on the server, with no Git on this
computer
([ADR-0804](../../docs/adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)):

```sh
epicenter status                      # the Epicenter folder: each folder's state
epicenter sync ~/Epicenter/notes      # 0 synced, 1 run again or it asks, 2 could not sync
epicenter share ~/Epicenter/notes jess@example.com
epicenter accept                      # the shares waiting for you
```

The CLI is its own program, with its own sign-in (ADR-0793). The Epicenter
app neither runs nor carries it: its
[Folders window](../../apps/epicenter/README.md#the-folders-window) composes
`@epicenter/folder/platform` itself. `bun run --cwd packages/cli compile`
builds the binary (`scripts/compile.ts`); an installer of its own is not
built yet.

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check [<dir>] [--contract <url or path>]` | built | `checkFiles` in `@epicenter/folder/node`, against `<dir>/epicenter.json` unless `--contract` names one |
| `epicenter format [<dir>] [--contract <url or path>]` | built | `formatNotes` in `@epicenter/folder/node`, the same way |
| `epicenter status` | built | `listHome` in `@epicenter/folder/platform`, through `src/folder-commands.ts` |
| `epicenter init [<path>] [--title <title>] [--dry-run]` | built | `initFolder`, through `src/folder-commands.ts` |
| `epicenter sync [<folder>] [--join <id> \| --create] [--push-deletions \| --restore-deletions] [--all]` | built | `syncFolder` and `syncEvery`, through `src/sync/commands.ts` |
| `epicenter clone [<folder> [<name>]]` | built | `listFolders` and `cloneIntoHome`, through `src/sync/commands.ts` |
| `epicenter log [<dir>] [--path <path>] [--at <moment>] [--limit <n>]` | built | `src/sync/history.ts` |
| `epicenter history <path> [--at <moment>] [--limit <n>]` | built | `src/sync/history.ts` |
| `epicenter show <path> [--at <moment>]` | built | `src/sync/history.ts` |
| `epicenter at <moment> [<dir>]` | built | `src/sync/history.ts` |
| `epicenter mark [<name> [<dir>]] [--move]` | built | `src/sync/history.ts` |
| `epicenter diff [<dir>] [--since <moment>]` | built | `src/sync/history.ts` |
| `epicenter restore <moment> [<dir>] [--path <path>]` | built | `src/sync/history.ts` |
| `epicenter export [<dir>] --git <repository>` | built | `src/git/export.ts` |
| `epicenter import --git <path or URL> [--branch <name>] [--name <name>] [--replace-original]` | built | `src/git/import.ts` |
| `epicenter share <folder> [<email>] [--role member\|reader]` | built | `shareFolder` and `getFolder`, through `src/folder-commands.ts` |
| `epicenter unshare <folder> <email>` | built | `unshareFolder` |
| `epicenter accept [<folder>]` | built | `listFolders` and `acceptIntoHome` |
| `epicenter attach <folder> <app>`, `detach` | built | `attachFolder` |
| `epicenter auth login` | built | `src/auth.ts` |
| `epicenter auth logout` | built | `src/auth.ts` |
| `epicenter auth status` | built | `src/auth.ts` |
| `epicenter auth token [--resource <url>]` | built | `src/auth.ts` |
| `epicenter messages` | built, hidden | Local Beeper operations on stdin; token in the device keychain |

`messages` is left out of `--help`: another program runs it, not a person.

The decided commands that are not built: `query`, `set`, `edit`, and `delete`
over a folder's collections, `normalize`, and `mcp` and `mcp --all`, which
serves each contract as typed MCP tools
([ADR-0790](../../docs/adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md),
[ADR-0797](../../docs/adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md),
[ADR-0799](../../docs/adr/0799-a-folders-contract-is-also-an-mcp-server.md)),
with `epicenter init --yes` for agents
([ADR-0811](../../docs/adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md)).
`format` goes with the whole-note formatter (ADR-0796). The Epicenter app
composes the same package functions and never runs a command
([ADR-0817](../../docs/adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md)),
though the desktop shell still runs this binary for sign-in and Messages for
Beeper, which ADR-0817's "no program calls the CLI" does not yet describe.

## Folders

A folder (ADR-0811) is synced and shared: the server mints its id at its
first sync, its members are people, equal and none its owner, and its title
is the `title` of its `epicenter.json`. Every real directory directly inside
the Epicenter folder (`~/Epicenter`, or `~/Epicenter Dev` in development) is
a folder; a link there is a folder outside it, never synced (ADR-0825).

- `status` lists every folder there with its title and state (on this
  computer only, with the folders it could be; synced; shared, with who
  holds it; kept by Git, or a link outside the Epicenter folder, neither of
  which Epicenter syncs), then the shares waiting for you and the folders
  you hold that are not on this computer, a refusal when the Epicenter
  folder is inside a file-sync service, and a note when it is itself a Git
  repository.
  Signed out or offline, it lists what this computer holds.
- `init [<path>]` writes the folder's `epicenter.json`: its title (the
  directory's name, or `--title`), and the collections its files suggest,
  `{name}` the item's file name (ADR-0818). `--dry-run` prints the proposal.
- `share <folder> <email>` invites the email as a `member`, or with
  `--role reader` a reader (ADR-0820); the folder is theirs once whoever
  signs in with that email, verified, accepts it, whether they have an
  account now or sign up later, and the answer never says which. Without
  `<email>`, it lists who holds the folder and who is invited. Every member
  shares; a reader does not. `unshare <folder> <email>` takes someone out
  or cancels their invitation, refusing their next sync without recalling
  their files; with your own email you leave the folder or decline its
  invitation, and the last to leave deletes it.
- `accept [<folder>]` accepts a share (by id or title) and brings the
  folder into the Epicenter folder, named for its title; without one, it
  lists the shares waiting.
- `attach <folder> <app>` lets an app, by the client id it signs in as,
  reach the folder; `detach` stops it. An app reaches only the folders
  attached to it.
- A sync the server refuses this account (a reader writing, or someone
  unshared) stops with exit 2, naming the refusal.

`src/sync/sync.postgres.test.ts` runs these between two people, each on a
machine of their own, against the real server.

## Sync

`sync` and `clone` live in `src/sync/commands.ts`, and the history commands in
`src/sync/history.ts`. What
this computer synced is recorded at the Epicenter folder's root, one record
per folder at `.epicenter/synced/<folder-id>.json`: the folder's id, the
name and identity (inode and birth time) of the directory that agreed it,
the cursor of the folder's log both sides last agreed at, and each file's
version there, the SHA-256 of its bytes (ADR-0822, ADR-0824). A folder holds only its files. The CLI signs every
request to the deployment with the grant's Git-audience token
(`src/sync/account.ts`), sent over `https`, or over `http` only to this
computer.

- `sync [<folder>]` syncs a folder in the Epicenter folder, by its path or
  name (this directory by default); a directory anywhere else is refused.
  Which directory is which folder is proven across the whole Epicenter
  folder (`identify` in `@epicenter/folder/platform`): the same inode and
  birth time as a record, or, for a record no directory has, the same name
  and exactly the same files in a folder only you hold. A folder not proven
  asks which folder it is before it sends anything, exiting 1: the folders
  you hold that are not synced here, matched by name or title, with who
  holds each, one selected when it held exactly the files it had here.
  `--join <id>` answers with one, `--create` with a new folder (which never
  joins one). With nothing it could be it becomes a new folder, and with one
  match you hold alone it joins that one. A join starts from first contact,
  which never deletes. A sync that would delete 20 or more files on the
  server, or 5 or more that are half the folder, sends nothing and exits 1
  until `--push-deletions` deletes them there or `--restore-deletions`
  brings them back. `--all` syncs every folder in the Epicenter folder that
  moved on either side, from one request for where every folder is
  (ADR-0819), and a folder an app made as if you had named it. A folder Git
  keeps (`.git` at its root) and a link are never synced, and an Epicenter
  folder inside a file-sync service is refused.
 A sync copies what changed on one side to the other, and merges a
  note both sides changed: front matter by key, this computer's change
  winning a key both changed, and the body by line with one conflict block
  per clash. An edit beats a delete, and a file both sides replaced keeps
  this computer's, the other staying in the folder's history. A path
  the server refuses (one differing only in case from a path it holds)
  stays here and is named. `--json` prints one `{"sync": {...}}` or
  `{"question": {...}}` line. Exit codes: 0 synced, 1 run again, a file
  refused, a question, or deletions waiting, 2 could not sync.
- `clone` lists the folders you hold, by id, title, and who holds them;
  `clone <folder> [<name>]` brings one (by id, or by a title one folder
  has) into a new directory in the Epicenter folder, named `<name>` or for
  its title, and syncs it.

History is the folder's log on the server (ADR-0824). A moment is a
change's number, a mark's name, or a time.

- `log [<dir>]` lists the folder's changes, newest first, with their marks,
  noting the one this folder last agreed at; `--path` lists one file's.
- `history <path>` lists one file's versions, who wrote each, and when;
  `show <path> [--at <moment>]` writes the file as it is or was.
- `at <moment> [<dir>]` lists the folder's files as they were then.
- `mark <name> [<dir>]` names the folder's last change (ADR-0826); a name
  marking another change moves only with `--move`.
- `diff [<dir>]` lists the files the folder changed since its last sync,
  from the folder alone; `--since <moment>` lists the files the server
  changed since then.
- `restore <moment> [<dir>]` makes one change on the server giving the
  folder's files (or the one at `--path`) back the versions they held then,
  removing files made since; it names versions the server keeps, so no bytes
  travel, and the next sync brings it here.
- `export [<dir>] --git <repository>` writes the folder's history into a Git
  repository (`src/git/export.ts`, projection v1): a commit per change, notes
  as files and every other file as a Git LFS pointer with its object in
  `.git/lfs/objects`, marks as tags. It is deterministic and incremental.
- `import --git <path or URL>` makes a folder of a Git repository's
  first-parent history, never writing the source (`src/git/import.ts`); with
  `--replace-original`, a clean local repository moves aside, its `.git`
  within it, and a link at its path points to the new folder.

`git` is needed on this computer only for `export` and `import`, and Git
LFS only to import a repository that uses it.

Without `Bun.secrets` in the binary, every keychain command fails and says
so. `EPICENTER_TEST_SECRETS` replaces the keychain with in-memory stores,
the sign-in's seeded from its `$auth` member and every other one empty, so
tests never touch the real one.

## Signing in

`auth` is ADR-0558's, against ADR-0549's authorization server at the
deployment's API origin: `EPICENTER_API_URL`, or `https://api.epicenter.so`
(`resolveOAuthAudiences` in `@epicenter/definition/site` names its API and
Git audiences). The CLI signs in as its own client, `so.epicenter.cli`,
with its own refresh-token family; the Epicenter app signs in as
`so.epicenter` through its shell, and neither touches the other's.
`auth login` is device authorization (RFC 8628): it prints the link and
code, or `{"device": {...}}` with `--json`, and polls until the person
approves on the server's page. The grant is one keychain entry under
`so.epicenter.auth` named `device <origin>`, holding the refresh token and
the access tokens cached for each audience.

It asks for `openid offline_access profile ai folders:read folders:write
folders:all` and both audiences: `folders:all` reaches every folder the
person holds, where an app's grant reaches the folders attached to it. Each refresh names one audience, and the server narrows
that access token to the audience's scopes while the grant keeps all of
them. `auth login` then caches an API token and reads who approved the grant
from the server's userinfo, which `auth status` reports without a network
request. Each sign-in records a random generation; token refresh keeps it
unchanged. `sync`, `clone`,
`log`, `diff`, and `restore` send the grant's Git-audience token on each
request.

`auth token [--resource <url>]` prints an access token for the API or the
Git audience. A cached token is reused until five minutes before it
expires; otherwise one refresh runs under `<data dir>/auth/device.lock`, an
exclusive SQLite transaction the system releases if the process dies
(`holdingFileLock` in `src/file-lock.ts`), and rereads the entry inside it, so concurrent callers
share one refresh. A refresh whose answer was lost is sent again, which the
server's 60-second reuse interval answers with the same tokens; one answered
`invalid_grant` is retried once with what the entry then holds, and a second
`invalid_grant` means the sign-in has ended. `auth logout` revokes the
grant's refresh token, which ends every token the grant issued, and deletes
its entry even when the server cannot be reached.

Every built resource accepts only these tokens (ADR-0549): a token reaches
only the deployment paths of the audience it names.

## Directories

The CLI works in the Epicenter folder the Epicenter app shows, `~/Epicenter`
or `~/Epicenter Dev`, and keeps its sign-in's lock in `<data dir>/auth`
(`src/app-paths.ts`). A command uses the environment its build embedded;
`EPICENTER_ENVIRONMENT` overrides it, and `EPICENTER_DATA_DIR` moves the
lock's directory. The app sets neither: it never runs the CLI.

## Output and exit codes

Every command takes `--json`, and only `--json` switches the output: one JSON
value on one line of stdout, or, for `sync`, `clone`, and `auth login`,
NDJSON progress lines ending in one result line. Without it,
stdout is the answer and stderr is for people. A command that cannot do its
work prints `{"error": "..."}` on stdout with `--json`, and the message on
stderr without it.

Exit codes are ADR-0520's: 0 done, 1 a finding a person acts on (a file that
does not conform, a sync that stopped), 2
input the command cannot use (a folder that is not one, an unknown option).

Options are matched exactly. A token shaped like an option the command does
not take is refused. After `--`, every token is a positional. The CLI never calls
`process.exit`, so stdout drains before the process ends, except when a
stop signal ends it (`src/stop.ts`), whose output nobody reads then. A running
command holds a timer, since Bun 1.3.14 can otherwise end the process while
`crypto.subtle` work started after a child process exited is still pending.

## Layout

| Path | What it is |
| --- | --- |
| `src/bin.ts` | The command run from source. |
| `src/cli.ts` | `runCli`: help, version, and dispatch to the built commands. |
| `src/commands.ts` | Every command, with its usage. |
| `src/parse.ts` | The hand-written parser. |
| `src/contract-commands.ts` | `check` and `format` against an app's contract, over `@epicenter/folder/node`. |
| `src/sync/` | `sync`, `clone`, `log`, `diff`, and `restore`, over `@epicenter/folder/platform` and `@epicenter/folder/sync`, and the sign-in as the account a folder is reached through. |
| `src/stop.ts` | The one stop-signal handler: wait for an unfinished refresh, then exit. |
| `src/folder-commands.ts` | `status`, `init`, `share`, `unshare`, `accept`, `attach`, and `detach`, over `@epicenter/folder/platform`. |
| `src/app-paths.ts` | Where the Epicenter folder and the sign-in's lock are. |
| `src/auth.ts` | The device sign-in, the one refresh, status, and sign-out. |
| `src/auth-commands.ts` | `auth login`, `logout`, `status`, and `token`, printing what `src/auth.ts` returns. |
| `src/secrets.ts` | The keychain through `Bun.secrets`, by service, or the test stores. |
| `src/output.ts` | Stdout, stderr, `{"error"}`, and the exit codes. |

## Tests

```sh
bun test                       # from source
EPICENTER_BIN=../../apps/epicenter/src-tauri/binaries/epicenter-cli-<triple> bun test src/epicenter.test.ts
bun run typecheck
```

`src/epicenter.test.ts` runs every command in a fresh process against real
directories, so it can run against the compiled binary too.
`src/sync/sync.postgres.test.ts` runs the sync commands against the real
server (it needs `initdb` and `pg_ctl` on `PATH`).
`src/auth.postgres.test.ts` signs in against `@epicenter/server`'s
authorization server in process, on a disposable Postgres cluster (it needs
`initdb` and `pg_ctl` on `PATH`), approving as the server's own checks do.

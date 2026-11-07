# @epicenter/cli

`check` and `format` read or rewrite a folder against its contract, its own
`epicenter.json` (ADR-0805), or an app's named by `--contract` as a URL or a
file path. See [shared vocabulary](../../docs/CONTEXT.md).

The `epicenter` command. Each platform operation is a function in a shared
package and one description in `src/operations.ts` (ADR-0827): its name, its
positionals and options, its summary, and a JSON Schema (TypeBox) for its
input and its output. The CLI renders each description as a command
(`src/cli.ts`, `src/operation.ts`), and `epicenter mcp` renders the same
descriptions as MCP tools (`src/mcp.ts`); neither is written by hand. An
operation's code (`run`) turns its input into its output and prints
nothing; `print` is how a person reads it, and `--json` prints the output
as it is, the same value an agent gets as structured content. The CLI's
own commands, `mcp`, `auth` (ADR-0558), and `messages`, are not platform
operations, so not tools.

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
builds the binary (`packages/cli/scripts/compile.ts`); an installer of its own
is not built yet.

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check [<dir>] [--contract <url or path>]` | built | `checkFiles` in `@epicenter/folder/node`, against `<dir>/epicenter.json` unless `--contract` names one |
| `epicenter format [<dir>] [--contract <url or path>]` | built | `formatNotes` in `@epicenter/folder/node`, the same way |
| `epicenter status` | built | `listHome` in `@epicenter/folder/platform`, through `src/folder-commands.ts` |
| `epicenter init [<path>] [--title <title>] [--dry-run]` | built | `initFolder`, through `src/folder-commands.ts` |
| `epicenter sync [<folder>] [--join <id> \| --create] [--push-deletions \| --restore-deletions] [--all]` | built | `syncFolder` and `syncEvery`, through `src/sync/commands.ts` |
| `epicenter clone [<folder> [<name>]]` | built | `listFolders` and `cloneIntoHome`, through `src/sync/commands.ts` |
| `epicenter log [<dir>] [--path <path>] [--at <moment>] [--limit <n>]` | built | `folderLog` in `@epicenter/folder/platform`, through `src/sync/history.ts` |
| `epicenter history <path> [--at <moment>] [--limit <n>]` | built | `fileHistory` |
| `epicenter show <path> [--at <moment>]` | built | `fileAt` |
| `epicenter at <moment> [<dir>]` | built | `folderAt` |
| `epicenter mark [<name> [<dir>]] [--move]` | built | `markFolder` and `folderMarks` |
| `epicenter diff [<dir>] [--since <moment>]` | built | `folderDiff` |
| `epicenter restore <moment> [<dir>] [--path <path>]` | built | `restoreFolder` |
| `epicenter export [<dir>] --git <repository>` | built | `exportGit` in `@epicenter/folder/node`, through `src/git/commands.ts` |
| `epicenter import --git <path or URL> [--branch <name>] [--name <name>] [--replace-original] [--resume]`, `epicenter import --abandon <folder>` | built | `importGit` in `@epicenter/folder/platform` over `gitHost`, and `abandonImport`, from `@epicenter/folder/node` |
| `epicenter share <folder> [<email>] [--role member\|reader]` | built | `shareFolder` and `getFolder`, through `src/folder-commands.ts` |
| `epicenter unshare <folder> <email>` | built | `unshareFolder` |
| `epicenter accept [<folder>]` | built | `listFolders` and `acceptIntoHome` |
| `epicenter attach <folder> <app>`, `detach` | built | `attachFolder` |
| `epicenter mcp [<dir> ...] [--all]` | built | `src/mcp.ts`: every operation, and each folder's collections, as MCP tools |
| `epicenter auth login` | built | `src/auth.ts` |
| `epicenter auth logout` | built | `src/auth.ts` |
| `epicenter auth status` | built | `src/auth.ts` |
| `epicenter auth token [--resource <url>]` | built | `src/auth.ts` |
| `epicenter messages` | built, hidden | Local Beeper operations on stdin; token in the device keychain |

`messages` is left out of `--help`: another program runs it, not a person.

The decided commands that are not built: `epicenter git land`, which turns a
Git branch into one change
([ADR-0831](../../docs/adr/0831-a-git-branch-lands-in-a-folder-as-one-change-through-the-cli.md));
`query`, `set`, `edit`, and `delete`
over a folder's collections on the command line, and `normalize`
([ADR-0790](../../docs/adr/0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md),
[ADR-0797](../../docs/adr/0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md)),
with `epicenter init --yes` for agents
([ADR-0811](../../docs/adr/0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md)).
An agent has the collections as tools through `epicenter mcp`.
`format` goes with the whole-note formatter (ADR-0796). The Epicenter app
composes the same package functions and never runs a command
([ADR-0817](../../docs/adr/0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md)),
though the desktop shell still runs this binary for sign-in and Messages for
Beeper, which ADR-0817's "no program calls the CLI" does not yet describe.

## Agents

`epicenter mcp [<dir> ...] [--all]` serves Epicenter to an agent over the
Model Context Protocol on stdin and stdout, with the official TypeScript
SDK (`@modelcontextprotocol/sdk`). An agent's MCP configuration runs
`epicenter mcp --all` (ADR-0800, ADR-0816). Its tools:

- every operation in `src/operations.ts`, named as its command, with the
  same input and output schemas, run by the same code;
- for each folder it reaches (those named, or every folder in the
  Epicenter folder with `--all`), the collections its `epicenter.json`
  declares: `<folder>_<collection>_query` (`{ where?, limit? }`: the items
  whose fields equal `where`, without bodies), and for a note collection
  `_get` (one note, fields and body), `_set` (`fields`, `remove?`: fields
  set, the rest kept), and `_write` (`body`, `fields?`). Each writes
  through the folder (`openFolder`), as an app does, and a field that does
  not fit the contract is refused before anything is written (ADR-0799).
  The tools are read again from each `epicenter.json` at every listing.

It keeps the folders it writes in sync (ADR-0819, ADR-0822):
`keepEverySynced` limited to them, after a burst of its writes, every few
seconds while it runs (3, where ADR-0830 decides 30), and once more as it ends. A folder not synced here
stays local, as it does for any program. Signed out, it writes and says on
stderr that it does not sync. Stdout is the protocol's alone.

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
`src/sync/history.ts`, over the history functions of
`@epicenter/folder/platform` the Epicenter app's History view calls too. What
this computer synced is recorded at the Epicenter folder's root, one record
per folder at `.epicenter/synced/<folder-id>.json`: the folder's id, the
name and identity (inode and birth time) of the directory that agreed it,
the cursor of the folder's log both sides last agreed at, and each file's
version there, the SHA-256 of its bytes (ADR-0822, ADR-0824). A folder holds only its files. The CLI signs every
request to the deployment with the grant's folders-audience token
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
  stays here and is named. `--json` prints `{"sync": {...}}` or
  `{"question": {...}}`, and with `--all` `{"every": [...], "warnings"}`.
  Exit codes: 0 synced, 1 run again, a file refused, a question, or
  deletions waiting, 2 could not sync.
- `clone` lists the folders you hold, by id, title, and who holds them;
  `clone <folder> [<name>]` brings one (by id, or by a title one folder
  has) into a new directory in the Epicenter folder, named `<name>` or for
  its title, and syncs it.

History is the folder's ledger on the server (ADR-0824). A moment is a
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
  travel, and the next sync brings it here, deleting on this computer the files
  it removed (ADR-0829 decides that a restore never deletes on a device; that is
  not built).
- `export [<dir>] --git <repository>` writes the folder's history into a Git
  repository (`exportGit`, projection v2): a commit per change, notes
  and `epicenter.json` as plain files and every other file as a Git LFS
  pointer with its object in `.git/lfs/objects`, marks as tags. It is
  deterministic and incremental, and never continues an export in another
  projection.
- `import --git <path or URL>` makes a folder of a Git repository's
  first-parent history, never writing the source (`importGit`); with
  `--replace-original`, a clean local repository moves aside, its `.git`
  within it, and a link at its path points to the new folder. An import that
  stops midway lands the changes it finished and is remembered at
  `~/Epicenter/.epicenter/imports/<folder-id>.json` until it is done;
  `--resume` continues it from the change after the server's last, and
  `--abandon <folder>` deletes its folder on the server, which the server
  does only while the folder still imports, and the directory it was
  writing here.

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
folders audiences). The CLI signs in as its own client, `so.epicenter.cli`,
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
`log`, `diff`, and `restore` send the grant's folders-audience token on each
request.

`auth token [--resource <url>]` prints an access token for the API or the
folders audience. A cached token is reused until five minutes before it
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
value on one line of stdout, the operation's output as its schema describes
it, or, for `auth login`, NDJSON progress lines ending in one result line.
`--help --json` describes each command, an operation with its input and
output schemas. Without it,

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
| `src/commands.ts` | Every command: the operations first, then `mcp`, `auth`, and `messages`. |
| `src/parse.ts` | The hand-written parser. |
| `src/contract-commands.ts` | `check` and `format` against an app's contract, over `@epicenter/folder/node`. |
| `src/operations.ts`, `src/operation.ts` | The operation table (`OPERATIONS`, `defineOperation`): each platform operation as one description with TypeBox input and output schemas. |
| `src/mcp.ts` | `epicenter mcp`: every operation, and each folder's collections, as MCP tools. |
| `src/sync/` | `sync`, `clone`, and the history commands (`history.ts`: `log`, `history`, `show`, `at`, `mark`, `diff`, `restore`), over `@epicenter/folder/platform` and `@epicenter/folder/sync`, and the sign-in as the account a folder is reached through (`account.ts`). |
| `src/git/commands.ts` | `export --git` and `import --git`, over `exportGit`, `importGit`, and `gitHost`. |
| `src/messages.ts`, `src/messages-protocol.ts` | The hidden `messages` command. |
| `src/file-lock.ts` | The exclusive lock the sign-in's refresh holds. |
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

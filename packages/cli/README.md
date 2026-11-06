# @epicenter/cli

`check` and `format` take an app's contract, as a URL or a file path, and
read or rewrite a folder against it; a folder holds no `epicenter.json` for
them. See [shared vocabulary](../../docs/CONTEXT.md).

The `epicenter` command. Each command is a thin wrapper over a function in a
shared package; the CLI parses, prints, and picks the exit code, and holds no
logic a page or the browser also needs (ADR-0556). The
implemented command surface retains ADR-0558's `auth` group; its `app` group
is deleted. ADR-0611 describes the planned reduction.

```sh
bun run epicenter check path/to/contract.json path/to/folder   # from the repository root
```

`sync`, `clone`, `log`, `diff`, and `restore` keep a folder in sync with
its repository on the server, with no Git on this computer
([ADR-0804](../../docs/adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)):
each runs `sync({ local, remote, manifest })` from `@epicenter/folder/sync`,
the function every surface runs, over the folder's directory and its
repository, reached by the folder's id:

```sh
~/.epicenter/bin/epicenter sync ~/Epicenter/notes          # 0 synced, 1 run again, 2 could not sync
~/.epicenter/bin/epicenter clone <folder id> ~/Epicenter/notes
```

The app links its bundled CLI at `~/.epicenter/bin/epicenter`; development links it at `~/.epicenter-dev/bin/epicenter`.

The desktop app compiles `src/bin.ts` into the one binary it ships (`bun run
--cwd apps/epicenter build:sidecar`); see
[the epicenter binary](../../apps/epicenter/README.md#the-epicenter-binary).
Its [Folders window](../../apps/epicenter/README.md#the-folders-window) still
runs the retired Git commands (`status`, `init`, `connect`, `forget`, and
`sync --watch`); it moves onto these with the library.

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check [<dir> \| <contract> [<dir>]]` | built | Reads `contract` from `<dir>/AGENTS.md` unless a contract is supplied; runs `checkFiles` in `@epicenter/folder/node` |
| `epicenter format <contract> [<dir>]` | built | `formatNotes` in `@epicenter/folder/node` |
| `epicenter sync [<dir>]` | built | `src/sync/commands.ts` over `sync` in `@epicenter/folder/sync` |
| `epicenter clone <folder> [<dir>]` | built | `src/sync/commands.ts` |
| `epicenter log [<dir>] [--limit <n>]` | built | `src/sync/commands.ts` |
| `epicenter diff [<dir>] [--since <commit>]` | built | `src/sync/commands.ts` |
| `epicenter restore <commit> [<dir>] [--path <path>]` | built | `src/sync/commands.ts` |
| `epicenter repos` | built | `src/repository-commands.ts` |
| `epicenter share <owner>/<name> \| <dir> [<handle>] [--read \| --write]` | built | `src/repository-commands.ts` |
| `epicenter unshare <owner>/<name> \| <dir> <handle>` | built | `src/repository-commands.ts` |
| `epicenter auth login` | built | `src/auth.ts` |
| `epicenter auth logout` | built | `src/auth.ts` |
| `epicenter auth status` | built | `src/auth.ts` |
| `epicenter auth token [--resource <url>]` | built | `src/auth.ts` |
| `epicenter messages` | built, hidden | Local Beeper operations on stdin; token in the device keychain |

`messages` and `--desktop` are left out of `--help`: the desktop app runs them.

## Hosted repositories

A folder's repository is on its deployment's server, reached by the folder's
id at `<git origin>/folders/<folder>` (ADR-0810). Plain Git clones the same
repository at `<git origin>/<namespace>/<name>.git` (ADR-0546), where the git
origin is `https://git.epicenter.so` for the hosted cloud and `<origin>/git`
for any other deployment, and `<namespace>` is the owner's 12-character id
(`epicenter repos` lists them, with each folder id).

- `epicenter repos` lists the repositories of every namespace the sign-in may
  reach, the personal one first, each with its folder id. With `--json`:
  `{"namespaces": [{"id", "title", "personal", "role", "repositories":
  [{"id", "name", "url"}]}]}`. Your personal namespace's id is your handle.
- `epicenter share <repository> <handle> --read|--write` lets the person
  whose handle that is read, or also sync changes to, one of your
  repositories; they clone it by its folder id. Only the owner rewrites
  `main` or shares it on. Without `<handle>` it lists the grants;
  `epicenter unshare <repository> <handle>` revokes one, refusing their next
  sync without recalling their files. `<repository>` is `<owner>/<name>`,
  `'~/<name>'`, or a folder that syncs with one of your repositories.
- A sync the server refuses this account (a read-only grant writing, or a
  revoked one) stops with exit 2, naming the refusal.

`src/sync/sync.postgres.test.ts` runs sync, clone, diff, log, restore, and
sharing between two people, each on a machine of their own, against the real
server.

## Sync

`sync`, `clone`, `log`, `diff`, and `restore` live in `src/sync/`. The
manifest at `.epicenter/synced.json` names the folder's repository (its
`folder` id), the commit both sides last agreed at, and each file's Git blob
id there (ADR-0808). The CLI signs every request to the deployment with the
grant's Git-audience token (`src/sync/account.ts`), sent over `https`, or
over `http` only to this computer.

- `sync [<dir>]` syncs the folder (this directory by default). Its first
  sync makes the folder's repository in the person's namespace and records
  its id. A sync copies what changed on one side to the other, and merges a
  note both sides changed: front matter by key, this computer's change
  winning a key both changed, and the body by line with one conflict block
  per clash. An edit beats a delete, and a file both sides replaced keeps
  this computer's, the other staying in the repository's history. A path
  the repository refuses (one differing only in case from a path it holds)
  stays here and is named. `--json` prints one `{"sync": {...}}` line. Exit
  codes: 0 synced, 1 run again or a file refused, 2 could not sync.
- `clone <folder> [<dir>]` records the repository `<folder>` names (a folder
  id, `<namespace>/<name>`, or `'~/<name>'`) in `<dir>`, a new directory
  named for it by default, and syncs; a directory that holds files keeps
  them, merged on top.
- `log [<dir>]` lists the repository's history, newest first, marking the
  commit the folder last agreed at.
- `diff [<dir>]` lists the files the folder changed since its last sync,
  from the folder alone; `--since <commit>` lists the files the repository
  changed between that commit and its head.
- `restore <commit> [<dir>]` writes the folder's files as they were at
  `<commit>` (or the one at `--path`), removing files made since; the next
  sync records it as a new change.

`git` is not needed on this computer for any of these.
Every command also accepts the hidden `--desktop`, which Rust passes to select
the desktop grant (ADR-0558); `auth token` and `auth logout` act on that
grant only with it.

Without `Bun.secrets` in the binary, every keychain command fails and says
so. `EPICENTER_TEST_SECRETS` replaces the keychain with in-memory stores,
the sign-ins' seeded from its `$auth` member and every other one empty, so
tests never touch the real one.

The shell runs its bundled sidecar in place and links it at `AppPaths.engine`
for terminal use.

## Signing in

`auth` is ADR-0558's, against ADR-0549's authorization server at the
deployment's API origin: `EPICENTER_API_URL`, or `https://api.epicenter.so`
(`resolveOAuthAudiences` in `@epicenter/definition/site` names its API and
Git audiences; Rust passes the shell's configured origin). The CLI holds two
grants, each one keychain entry under `so.epicenter.auth` named
`<grant> <origin>`, holding the refresh token and the access tokens cached
for each audience:

| Grant | Client | Flow | Used by |
| --- | --- | --- | --- |
| `device` | `so.epicenter.cli` | `auth login`: device authorization (RFC 8628). It prints the link and code, or `{"device": {...}}` with `--json`, and polls until the person approves on the server's page. | Every command run without `--desktop`: a terminal or an agent. |
| `desktop` | `so.epicenter` | `auth login --desktop`: authorization code with S256 PKCE, received once on `http://127.0.0.1:<random port>/callback`. It opens the browser, or prints `{"open": "<url>"}` with `--json` for Rust to open. | Only commands Rust runs with `--desktop`. |

Both ask for `openid offline_access profile ai folders:read folders:write`
and both audiences. Each refresh names one audience, and the server narrows
that access token to the audience's scopes while the grant keeps all of
them. `auth login` then caches an API token and reads who approved the grant
from the server's userinfo, which `auth status` reports without a network
request. Each sign-in records a random generation; token refresh keeps it
unchanged. `sync`, `clone`,
`log`, `diff`, and `restore` send the grant's Git-audience token on each
request.

`auth token [--resource <url>]` prints an access token for the API or the
Git audience. A cached token is reused until five minutes before it
expires; otherwise one refresh runs under `<data dir>/auth/<grant>.lock`, an
exclusive SQLite transaction the system releases if the process dies
(`holdingFileLock` in `src/file-lock.ts`), and rereads the entry inside it, so concurrent callers
share one refresh. A refresh whose answer was lost is sent again, which the
server's 60-second reuse interval answers with the same tokens; one answered
`invalid_grant` is retried once with what the entry then holds, and a second
`invalid_grant` means the sign-in has ended. `auth logout` revokes the
grant's refresh token, which ends every token the grant issued, and deletes
its entry even when the server cannot be reached. Without `--desktop` it
signs out the device grant.

Every built resource accepts only these tokens (ADR-0549): a token reaches
only the deployment paths of the audience it names.

## Directories

The CLI reads and writes where the desktop shell does
(`src/app-paths.ts`). The shell sets `EPICENTER_DATA_DIR` for sign-in locks
and `EPICENTER_ENVIRONMENT` for the library root when it runs the CLI.
A terminal command uses the environment embedded at build time;
`EPICENTER_ENVIRONMENT` overrides it. The library root is fixed at `~/Epicenter` or
`~/Epicenter Dev`.

## Output and exit codes

Every command takes `--json`, and only `--json` switches the output: one JSON
value on one line of stdout, or, for `sync`, `clone`, and `auth login`,
NDJSON progress lines ending in one result line. Without it,
stdout is the answer and stderr is for people. A command that cannot do its
work prints `{"error": "..."}` on stdout with `--json`, and the message on
stderr without it.

Exit codes are ADR-0520's: 0 done, 1 a finding a person acts on (a file that
does not conform, a sync that stopped), 2
input the command cannot use (a folder that is not one, an unknown option,
no `git`).

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
| `src/sync/` | `sync`, `clone`, `log`, `diff`, and `restore`, over `@epicenter/folder/sync`, and the sign-in as the account a repository is reached through. |
| `src/stop.ts` | The one stop-signal handler: wait for an unfinished refresh, then exit. |
| `src/repository-commands.ts` | `repos`, `share`, and `unshare`. |
| `src/app-paths.ts` | Where the Epicenter folder, the sign-in locks, and the engine live, by the shell's rule. |
| `src/auth.ts` | The two grants: device and desktop sign-in, the one refresh, status, and sign-out. |
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

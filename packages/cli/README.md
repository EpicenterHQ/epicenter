# @epicenter/cli

`check` and `format` take an app's contract, as a URL or a file path, and
read or rewrite a folder against it; a folder holds no `epicenter.json` for
them. See [shared vocabulary](../../docs/CONTEXT.md).

The `epicenter` command. Each command is a thin wrapper over a function in a
shared package; the CLI parses, prints, and picks the exit code, and holds no
logic a page or the browser also needs (ADR-0556). Desktop-only work, such as
`install-command`, lives in the CLI's own modules. The
implemented command surface retains ADR-0558's `auth` group; its `app` group
is deleted. ADR-0611 describes the planned reduction.

```sh
bun run epicenter check path/to/contract.json path/to/folder   # from the repository root
```

`init`, `clone`, `sync`, `status`, and `forget` keep a data folder's history
with stock `git` and `git-lfs`
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)):

```sh
epicenter clone <namespace>/recorder-demo ~/Epicenter/recorder-demo
epicenter sync ~/Epicenter/recorder-demo   # 0 synced, 1 run again, 2 stopped
```

The desktop app compiles `src/bin.ts` into the one binary it ships (`bun run
--cwd apps/epicenter build:sidecar`); see
[the epicenter binary](../../apps/epicenter/README.md#the-epicenter-binary).
Its [Folders window](../../apps/epicenter/README.md#the-folders-window) is a
front end over `status`, `init`, `clone`, `sync`, `forget`, `share`, and
`unshare`, and the app runs `sync --watch` for as long as it runs.

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check <contract> [<dir>]` | built | `checkFiles` in `@epicenter/folder/node` |
| `epicenter format <contract> [<dir>]` | built | `formatNotes` in `@epicenter/folder/node` |
| `epicenter init [<dir>] [--enclosing-ok]` | built | `src/sync/setup.ts` |
| `epicenter sync [<dir>] [--watch]` | built | `src/sync/sync.ts` |
| `epicenter status [<dir>]` | built | `src/sync/status.ts` |
| `epicenter clone <namespace>/<name> \| <url> \| <path> [<dir>]` | built | `src/sync/clone.ts` |
| `epicenter forget [<dir>]` | built | `src/sync/setup.ts` |
| `epicenter merge-driver <base> <ours> <theirs> [<path>]` | built, hidden | `src/sync/merge-driver.ts` over `settle` in `@epicenter/definition/merge` |
| `epicenter repos` | built | `src/repository-commands.ts` |
| `epicenter share <owner>/<name> \| <dir> [<handle>] [--read \| --write]` | built | `src/repository-commands.ts` |
| `epicenter unshare <owner>/<name> \| <dir> <handle>` | built | `src/repository-commands.ts` |
| `epicenter auth login` | built | `src/auth.ts` |
| `epicenter auth logout` | built | `src/auth.ts` |
| `epicenter auth status` | built | `src/auth.ts` |
| `epicenter auth token [--resource <url>]` | built | `src/auth.ts` |
| `epicenter auth git-credential get \| store \| erase` | built | `src/auth.ts` |
| `epicenter auth key set \| remove \| state <id>` | built | `saveKey`, `removeKey`, `keyState` in `@epicenter/ai/send` |
| `epicenter send` | built, hidden | `sendRequest` and `responseEvents` in `@epicenter/ai/send` |
| `epicenter messages` | built, hidden | Local Beeper operations on stdin; token in the device keychain |
| `epicenter install-command` | built, hidden | `src/install-command.ts` |

`messages`, `send`, `install-command`,
`merge-driver`, `sync --interval`, and `--desktop` are left out of `--help`:
the desktop app or Git runs them.

## Hosted repositories

A hosted folder's remote is `<git origin>/<namespace>/<name>.git`
(ADR-0546), where the git origin is `https://git.epicenter.so` for the hosted
cloud and `<origin>/git` for any other deployment, and `<namespace>` is the
owner's 12-character id (`epicenter repos` lists them).

- A folder connects with plain `git remote add origin <url>`.
  The server answers a name nobody holds as an empty repository, so the
  first sync's fetch finds nothing to take, and its push creates the
  repository. Any `git` the CLI runs against one of the deployment's hosted
  repositories carries the grant's token as a header (an `https` remote
  only; an `http` one, as a local server, uses the helper).
- `epicenter clone <namespace>/<name> [<dir>]` clones into `<dir>`, by default
  `~/Epicenter/<name>`, then runs `init` there. A URL or a local path is
  cloned as given.
- `epicenter repos` lists the repositories of every namespace the sign-in may
  reach, the personal one first. With `--json`:
  `{"namespaces": [{"id", "title", "personal", "role", "repositories":
  [{"id", "name", "url"}]}]}`. Your personal namespace's id is your handle.
- `epicenter share <repository> <handle> --read|--write` lets the person
  whose handle that is read, or also push forward and write from the web, one
  of your repositories; they clone it as `<your handle>/<name>`. Only the
  owner rewrites `main` or shares it on. Without `<handle>` it lists the
  grants; `epicenter unshare <repository> <handle>` revokes one, refusing
  their next fetch and push without recalling their clone. `<repository>` is
  `<owner>/<name>`, `'~/<name>'`, or a folder cloned from it.
- A fetch or push the server refuses this account (HTTP 403: a read-only
  grant pushing, or a revoked one) stops `sync` with exit 2 rather than
  asking for another run.

`grants.postgres.test.ts` runs sharing between two people, each on a machine
of their own, with a web client (`openRemote`) beside each.
`hosted-git.postgres.test.ts` runs these against the real server, and a
plain `git` signing in through `epicenter auth git-credential`; it seeds the processes'
in-memory keychain with a signed-in grant through `EPICENTER_TEST_SECRETS`'s
`$auth` member.

## Sync

`init`, `sync`, `clone`, `forget`, `status`, and the hidden `merge-driver`
live in `src/sync/` and run the system `git` through `runGit` in
`@epicenter/folder/bun`, which runs no hooks. `epicenter sync` is the only
desktop committer: apps write files, and sync commits them
with real `git add`, so Git LFS's filters run.

- `init [<dir>]` sets up or repairs a data folder and says what it changed:
  `git init` when needed; Epicenter's blocks in the folder's committed
  `.gitattributes` and `.gitignore` (`src/sync/managed-block.ts`). The
  attributes block is `REPOSITORY_ATTRIBUTES` from
  `@epicenter/definition/contract`, which the server writes in a
  repository's first commit: `.md` notes (in any case) merge with
  `merge=epicenter`, every other file is LFS, and dotfiles and dot
  directories are exempt. The ignore block is `REPOSITORY_IGNORE`:
  `.DS_Store` and `.epicenter/` (a device's outbox) are never committed.
  Then `merge.epicenter.driver`, the command link (`~/.local/bin/
  epicenter merge-driver %O %A %B %P`, the link `install-command` keeps);
  `git lfs install --local`;
  `git lfs pull` for files checked out as pointers; the deployment's
  credential helper per clone; and the folder in the global, multi-valued
  `epicenter.folder`. A folder inside another repository is refused unless
  `--enclosing-ok` is passed, and the adopted repository is recorded as
  `epicenter.root` in its local configuration.
- `sync [<dir>]` runs one round per folder, or for every registered folder
  without `<dir>`. Rounds of one repository take turns on
  `<git dir>/epicenter-sync.lock` (`holdingFileLock`). A round refuses a
  repository `init` did not adopt, an unfinished merge or rebase, unmerged
  entries, or a clone without the driver and LFS filters; stages and commits
  only the folder's own paths; fetches `origin`; stops if the remote `main`
  no longer contains `refs/epicenter/last-seen` (an owner rewrote `main`);
  stops with `retry` if another program holds `index.lock`; fetches the
  LFS bytes of `origin/main`; then merges `origin/main`
  (unrelated histories only on first contact), keeps the edited side of an
  edit/delete, lands a binary both sides replaced as
  `<stem> (conflict <hash7>)<ext>` beside the remote's, and commits; runs
  `git lfs push`, then pushes, fetching and merging again when the push is
  rejected, up to five times. `--json` prints one `{"sync": {"folder",
  "status", "head", "notes", "message"}}` line per folder per round. Exit
  codes: 0 synced, 1 run again, 2 stopped for a person or agent.
  `--watch` runs a round after each change under the folders and every 30
  seconds (`--interval`) until a stop signal. With `--desktop` it also
  stops, as on `SIGHUP` (exit 129), when stdin closes: the desktop app holds
  stdin open while it lives, so the watch cannot outlive it.
- `status [<dir>]` reads `git status --porcelain` for the folder and the
  ahead and behind counts against the last fetched `origin/main`, and fetches
  and writes nothing. Without `<dir>` it reads every registered folder, like
  `sync`; with `--json` it prints one `{"status": {...}}` line per folder, in
  registration order. A registered folder it cannot read is
  `{"status": {"folder", "problem"}}`, where `problem` is `not on disk` or
  `not in a Git repository`, and the rest are still read. With no folder
  registered it prints nothing (and says so on stderr without `--json`) and
  exits 0. The desktop app's Folders window lists its folders from this.
- `forget [<dir>]` unregisters the folder and unsets `epicenter.root` unless
  another registered folder shares the repository.
- `merge-driver` runs `settle` on a note: the later arrival at the server
  wins a front matter key (`%A` under a merge, `%B` under a rebase), and the
  body merges by line, then by word; two changes at the same spot give one
  conflict block of whole lines.

`src/sync/sync.e2e.test.ts` runs spike 7's cases against a bare remote and
a small LFS server in a sandbox (its own `HOME`, `GIT_CONFIG_GLOBAL`, and
`GIT_CEILING_DIRECTORIES`).

`git` is found without macOS's xcrun shim (`locateGit` in
`@epicenter/folder/bun`; `EPICENTER_GIT` names one outright). Without one,
each Git command fails with `GitMissingError`.
Every command also accepts the hidden `--desktop`, which Rust passes to select
the desktop grant (ADR-0558); `auth token`, `auth logout`,
`auth git-credential`, and `send` act on that grant only with it.

`auth key` and `send` are ADR-0557's. An AI connection is named by an id;
its endpoint and key live in this computer's keychain under that id, through `Bun.secrets` (service
`so.epicenter.connections`). `auth key set <id>` reads `{"endpoint", "key"}`
as JSON on stdin, never from the command line, and `state` prints the
endpoint and whether a key is saved, never the key. `send` reads one JSON
line, `{"target", "request"}`, then the request body's raw bytes on stdin;
it sends an Epicenter connection to the deployment's `/v1` with an access
token from `auth` (the desktop grant's under `--desktop`, otherwise the
device grant's). An account target, `{"kind": "account", "audience": "api"
| "git"}`, names one of the deployment's resources by role (ADR-0549). A
desktop-grant target also carries the nonsecret `generation` from `auth status`;
without it, the CLI refuses before reading a token. The terminal's separate
device grant keeps the two-field target. `send` permits `/api/*`, API-resource
`/v1/*`, and API-resource `GET /auth/oauth2/userinfo`, and refuses other
paths before asking for a token. It refuses a local connection, a missing key or
sign-in, and a request prepared for another endpoint than the keychain
holds, and otherwise prints the response as NDJSON: a `head`, the
body in base64 `chunk` lines of at most 64 KiB, and `end`, or an `error`.
It exits 0 when a response arrived, whatever its status, and 2 otherwise.
Without `Bun.secrets` in the binary, every keychain command fails and says
so. `EPICENTER_TEST_SECRETS` replaces the keychain with in-memory stores,
the AI connections' seeded from its JSON and the sign-ins' empty, so tests
never touch the real one.

`install-command` is ADR-0558's hidden command. It keeps one link
(ADR-0566, ADR-0567), and never needs `sudo`:

```txt
~/.local/bin/epicenter   -> the compiled binary
```

The one Git configuration the CLI writes, the credential helper, names that
link by its absolute path (`AppPaths.commandLink`), whether the CLI runs from
the bundle, the link, or source, so moving the app does not break it past its
next launch and a development run
never writes a checkout into the global configuration. A release build runs
`install-command --json` at every launch. A binary under macOS's App
Translocation (`/private/var/folders/.../AppTranslocation/`) leaves the link
as it is and says so, and a regular file at the link's path is refused. Run
from source under `bun`, it refuses, since it would link `bun` itself. A
terminal finds `epicenter` once `~/.local/bin` is on `PATH`: add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile once.

## Signing in

`auth` is ADR-0558's, against ADR-0549's authorization server at the
deployment's API origin: `EPICENTER_API_URL`, or `https://api.epicenter.so`
(`resolveOAuthAudiences` in `@epicenter/constants/apps` names its API and
Git audiences; Rust passes the shell's configured origin). The CLI holds two
grants, each one keychain entry under `so.epicenter.auth` named
`<grant> <origin>`, holding the refresh token and the access tokens cached
for each audience:

| Grant | Client | Flow | Used by |
| --- | --- | --- | --- |
| `device` | `so.epicenter.cli` | `auth login`: device authorization (RFC 8628). It prints the link and code, or `{"device": {...}}` with `--json`, and polls until the person approves on the server's page. | Every command run without `--desktop`: a terminal, an agent, Git. |
| `desktop` | `so.epicenter` | `auth login --desktop`: authorization code with S256 PKCE, received once on `http://127.0.0.1:<random port>/callback`. It opens the browser, or prints `{"open": "<url>"}` with `--json` for Rust to open. | Only commands Rust runs with `--desktop`. |

Both ask for `openid offline_access profile ai folders:read folders:write`
and both audiences. Each refresh names one audience, and the server narrows
that access token to the audience's scopes while the grant keeps all of
them. `auth login` then caches an API token and reads who approved the grant
from the server's userinfo, which `auth status` reports without a network
request. Each sign-in records a random generation; token refresh keeps it
unchanged. The device
login also sets, in Git's global configuration, an empty
`credential.<git audience>.helper` and then `!'<home>/.local/bin/epicenter'
auth git-credential`, so no broader helper is asked to store the token. Only
`auth login` writes it.

`auth token [--resource <url>]` prints an access token for the API or the
Git audience. A cached token is reused until five minutes before it
expires; otherwise one refresh runs under `<data dir>/auth/<grant>.lock`, an
exclusive SQLite transaction the system releases if the process dies
(`holdingFileLock` in `src/file-lock.ts`), and rereads the entry inside it, so concurrent callers
share one refresh. A refresh whose answer was lost is sent again, which the
server's 60-second reuse interval answers with the same tokens; one answered
`invalid_grant` is retried once with what the entry then holds, and a second
`invalid_grant` means the sign-in has ended. `auth git-credential get`
answers Git for the deployment's Git origin with `username=epicenter`, the
Git token as `password`, and `password_expiry_utc`, and answers any other
host with nothing; `store` and `erase` do nothing. `auth logout` revokes the
grant's refresh token, which ends every token the grant issued, and deletes
its entry even when the server cannot be reached. Without `--desktop` it
signs out the device grant.

Every built resource accepts only these tokens (ADR-0549): an Epicenter
connection's `send` reaches `/v1` with an API token, and an account target
reaches its permitted deployment paths with a token for the audience it names.

## Directories

The CLI reads and writes where the desktop shell does
(`src/app-paths.ts`): `EPICENTER_DATA_DIR` for the sign-in locks and
`EPICENTER_FOLDER_DIR` for the Epicenter folder, which the shell sets when it
runs the CLI, or the release app's directories when they are unset.

## Merging with plain Git

Plain `git merge` and `git pull` run the same note merge, because
`.gitattributes` names `merge=epicenter` and `init` defines the driver in
each clone. `git pull --rebase` swaps Git's sides; the driver detects the
rebase and still lets the later arrival win.

## Output and exit codes

Every command but `auth git-credential` takes `--json`, and only `--json` switches the output: one JSON
value on one line of stdout, or, for `sync`, `clone`, and `auth login`,
NDJSON progress lines ending in one result line. Without it,
stdout is the answer and stderr is for people. A command that cannot do its
work prints `{"error": "..."}` on stdout with `--json`, and the message on
stderr without it.

Exit codes are ADR-0520's: 0 done, 1 a finding a person acts on (a file that
does not conform, a sync that stopped), 2
input the command cannot use (a folder that is not one, a refused statement,
an unknown option, no `git`).

Options are matched exactly, so a SQL statement that starts with `--` stays a
statement. A token shaped like an option the command does not take is
refused. After `--`, every token is a positional. The CLI never calls
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
| `src/sync/` | `init`, `sync`, `status`, `clone`, `forget`, and the merge driver, over the system `git`. |
| `src/install-command.ts` | `install-command`: the one link Git's configuration runs. |
| `src/stop.ts` | The one stop-signal handler: cleanups at once, then unfinished refreshes, then exit. |
| `src/repository-commands.ts` | `repos`, and the token `sync` and `clone` send to the deployment's Git. |
| `src/app-paths.ts` | Where the Epicenter folder, the sign-in locks, and the command link live, by the shell's rule. |
| `src/ai-commands.ts` | `auth key` and `send`, printing what `@epicenter/ai/send` returns. |
| `src/auth.ts` | The two grants: device and desktop sign-in, the one refresh, status, sign-out, and Git's credential helper. |
| `src/auth-commands.ts` | `auth login`, `logout`, `status`, `token`, and `git-credential`, printing what `src/auth.ts` returns. |
| `src/secrets.ts` | The keychain through `Bun.secrets`, by service, or the test stores. |
| `src/output.ts` | Stdout, stderr, `{"error"}`, and the exit codes. |

## Tests

```sh
bun test                       # from source
EPICENTER_BIN=../../apps/epicenter/src-tauri/binaries/epicenter-cli-<triple> bun test src/epicenter.test.ts
bun run typecheck
```

`src/epicenter.test.ts` runs every command in a fresh process against real
directories, and `src/ai-commands.test.ts` runs `send` and `auth key`
against a local fake OpenAI-compatible server, so both can run against the
compiled binary too.
`src/auth.postgres.test.ts` signs in against `@epicenter/server`'s
authorization server in process, on a disposable Postgres cluster (it needs
`initdb` and `pg_ctl` on `PATH`), approving as the server's own checks do.

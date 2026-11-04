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

`init`, `connect`, `clone`, `sync`, `status`, and `forget` keep a data folder's history
in Git
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
`init`, `connect`, `clone`, `sync`, and `forget` run in the sync core,
`@epicenter/core`
([ADR-0751](../../docs/adr/0751-every-native-app-carries-one-sync-core.md)),
with no `git` or `git-lfs` program; only `status` still runs the system
`git`:

```sh
~/.epicenter/bin/epicenter clone <namespace>/recorder-demo ~/Epicenter/recorder-demo
~/.epicenter/bin/epicenter sync ~/Epicenter/recorder-demo   # 0 synced, 1 run again, 2 stopped
```

The app links its bundled CLI at `~/.epicenter/bin/epicenter`; development links it at `~/.epicenter-dev/bin/epicenter`.

The desktop app compiles `src/bin.ts` into the one binary it ships (`bun run
--cwd apps/epicenter build:sidecar`); see
[the epicenter binary](../../apps/epicenter/README.md#the-epicenter-binary).
Its [Folders window](../../apps/epicenter/README.md#the-folders-window) is a
front end over `status`, `init`, `connect`, `clone`, `sync`, `forget`, `share`, and
`unshare`, and the app runs `sync --watch` for as long as it runs.

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check [<dir> \| <contract> [<dir>]]` | built | Reads `contract` from `<dir>/AGENTS.md` unless a contract is supplied; runs `checkFiles` in `@epicenter/folder/node` |
| `epicenter format <contract> [<dir>]` | built | `formatNotes` in `@epicenter/folder/node` |
| `epicenter init [<dir>] [--name <name>]` | built | `src/sync/setup.ts` |
| `epicenter connect <dir> <namespace>/<name> \| '~/<name>' \| <url>` | built | `src/sync/connect.ts` |
| `epicenter sync [<dir>] [--watch]` | built | `src/sync/sync.ts` |
| `epicenter status [<dir>]` | built | `src/sync/status.ts` |
| `epicenter clone <namespace>/<name> \| <url> \| <path> [<dir>] [--name <name>]` | built | `src/sync/clone.ts` |
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
| `epicenter messages` | built, hidden | Local Beeper operations on stdin; token in the device keychain |

`messages`, `merge-driver`, `sync --interval`, and `--desktop` are left out of `--help`:
the desktop app or a person's own Git runs them.

## Hosted repositories

A hosted folder's remote is `<git origin>/<namespace>/<name>.git`
(ADR-0546), where the git origin is `https://git.epicenter.so` for the hosted
cloud and `<origin>/git` for any other deployment, and `<namespace>` is the
owner's 12-character id (`epicenter repos` lists them).

- `epicenter connect <dir> <namespace>/<name>` attaches an origin to an
  initialized folder. Use `'~/<name>'` for your own namespace, or a Git URL;
  `file://` works for a local repository. Plain `git remote add origin <url>`
  remains possible. Connecting does not run a sync round. The desktop's
  background service may start one as soon as it sees the new origin.
  The server answers a name nobody holds as an empty repository, so the
  first sync's fetch finds nothing to take, and its push creates the
  repository. A sync round's fetch, push, and LFS transfers to one of the
  deployment's hosted repositories carry the grant's token as one
  `Authorization: Bearer` header, which the sync core sends on each request
  to the remote's origin and never stores. A token travels over `https`, or
  over `http` only to this computer (a development API). Any other remote
  gets no credential: the core asks no credential helper.
  `credentials.e2e.test.ts` holds this to a stand-in on `127.0.0.1` that
  refuses any request without the token.
- `epicenter clone <namespace>/<name> [<dir>]` first restores the repository
  into a temporary folder with one round, its LFS bytes included. Without
  `<dir>`, it reads the restored `AGENTS.md` contract URL and
  derives a path under `~/Epicenter` from the app's site. Without a contract,
  a host-shaped repository name produces an owner folder; another name is
  used directly. Cloning onto an occupied folder enrolls it with that remote
  and syncs immediately. If this folder has no shared history with the remote, its files land in one
  `Added from <computer name>` commit on the remote head.
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

`init`, `connect`, `sync`, `clone`, `forget`, `status`, and the hidden `merge-driver`
live in `src/sync/`. All but `status` and `merge-driver` run in the sync
core: `@epicenter/core` loads the Rust core (`packages/epicenter-core`)
through Node-API, embedded in the compiled binary, and supplies `settle` from
`@epicenter/definition/merge` as its note merge. Apps write files, and a
round commits them, cleaning every LFS file itself. `status` runs the system
`git` through `runGit` in `@epicenter/folder/bun`, which runs no hooks, for
the queries the core has no read-only form of.

- `init [<dir>] [--name <name>]` sets up or repairs a data folder and says what it changed.
  It first refuses a folder inside a `.git` or `.epicenter` directory, by
  any segment of its canonical path in any case, the folder core's
  admission rule (`src/sync/admission.ts`, held to the folder plugin's
  `fixtures/reserved-directories.json`); `~/.notes` is a folder. Then the
  core's `open`: a repository on `main` with no commit when there is none,
  and the local Git LFS filter values it lacks, with no hooks or saved merge
  driver; Epicenter's blocks in the folder's
  `.gitattributes` and `.gitignore` (`src/sync/managed-block.ts`). The
  attributes block is `REPOSITORY_ATTRIBUTES` from
  `@epicenter/definition/contract`, which the server writes in a
  repository's first commit: `.md` notes (in any case) merge with
  `merge=epicenter`, every other file is LFS, and dotfiles and dot
  directories are exempt. The ignore block is `REPOSITORY_IGNORE`, in
  `managed-block.ts`: `.DS_Store` and `.epicenter/` (a device's unfinished
  writes) are never committed, and sync leaves `.epicenter/` out itself
  even when `.gitignore` does not name it. Init makes no commit, and the
  next sync gives files checked out as LFS pointers their bytes. A folder
  inside another repository is refused. Its own repository records `epicenter.synced = true`
  in local configuration. A folder outside the library needs `--name` for
  its library link; a folder deeper than the scan does too. A name that could
  be an app or owner host is refused, regardless of case. For example,
  `--name "Obsidian Vault"` works, while `--name notes` does not. A taken
  name is refused with both paths before the folder changes. Init refuses an unfinished Git
  operation, unmerged entries, or a branch other than `main` before changing
  anything, naming the command that resolves it.
- `connect <dir> <repository>` adds Git `origin` to an enrolled folder. It
  leaves an existing matching origin alone and refuses a different one, or
  one that pushes elsewhere; a new origin forgets the last remote `main`
  seen.
  The first sync fetches remote `main` before pushing; without an origin, sync
  still commits local changes.
- `sync [<dir>]` runs one round per folder, or for every synced folder found in the library
  without `<dir>`. The CLI refuses a folder that is gone, a repository
  without `epicenter.synced = true`, and a subfolder of another repository,
  then hands the folder to the core (`src/sync/sync.ts`). The core holds
  `<git dir>/epicenter-sync.lock` for the whole round, so every program's
  rounds on one repository take turns (ADR-0750). It refuses, naming the
  command that resolves it (ADR-0741), an unfinished merge, rebase,
  cherry-pick, or revert, unmerged entries, a branch other than `main`, an
  `origin` that pushes elsewhere, a remote `main` that no longer contains
  `refs/epicenter/last-seen` (an owner rewrote `main`), and a history
  Epicenter did not make that is unrelated to `origin/main` (with a rebase
  command); another program's `index.lock` ends the round `retry`. A round
  writes the Git LFS filter settings a clone lacks, commits only the
  folder's own paths, never `.epicenter` (whatever `.gitignore` says), and
  fetches `origin`. On first contact, or when the folder's history is only
  rounds made before it had an origin, it places the local files in one
  `Added from <computer name>` commit on remote `main`. Later rounds merge
  `origin/main`: `settle` for a note both sides changed, the edited side of
  an edit/delete, and a binary both sides replaced lands as
  `<stem> (conflict <hash7>)<ext>` beside the remote's. It uploads LFS
  objects, then pushes, fetching and merging again when the push is
  rejected, up to five times; a push to a local repository moves its `main`
  only if it still holds what the round merged. A file checked out as its
  LFS pointer gets its bytes. `--json` prints one `{"sync": {"folder",
  "status", "head", "notes", "message"}}` line per folder per round. Exit
  codes: 0 synced, 1 run again, 2 stopped for a person or agent.
  `--watch` runs a round after each change under the folders, except a
  change under a hidden path (`isHiddenPath`: `.git`, `.epicenter`), and
  every 30 seconds (`--interval`) until a stop signal. With `--desktop` it also
  stops, as on `SIGHUP` (exit 129), when stdin closes: the desktop app holds
  stdin open while it lives, so the watch outlives it by at most one round.
  A stop lets the round under way finish, for at most a minute
  (`ROUND_GRACE_MS` in `src/stop.ts`), and begins no other, so a merge is
  never cut off.
- `status [<dir>]` finds the repository, its consent, and its origin
  through the core, then reads the branch, the commit, `git status
  --porcelain` for the folder, and the ahead and behind counts against the
  last fetched `origin/main` with the system `git`: the core's only view of
  the working tree is the round's snapshot, which stores what it reads. It
  fetches and writes nothing. Without `<dir>` it scans the environment's library root and one owner level, like
  `sync`; with `--json` it prints one `{"status": {...}}` line per candidate,
  in path order. Dead links, unreadable folders, repositories Git cannot
  read, carry `{"folder", "problem"}`. Sync without a
  path skips these candidates with one note each. With no candidate found it prints nothing
  (and says so on stderr without `--json`) and exits 0. The desktop app's Folders window lists its folders from this.
- `forget [<dir>]` unsets local `epicenter.synced`.
- `merge-driver` runs `settle` on a note for a person's own `git` that
  names it as `merge.epicenter.driver` (Epicenter's rounds merge in the core
  and never call it): the later arrival at the server wins a front matter
  key (`%A` under a merge, `%B` under a rebase), and the body merges by line,
  then by word; two changes at the same spot give one conflict block of
  whole lines.

`src/sync/sync.e2e.test.ts` runs spike 7's cases against a bare remote and
a small LFS server in a sandbox (its own `HOME`, `GIT_CONFIG_GLOBAL`, and
`GIT_CEILING_DIRECTORIES`). The CLI's `test` script builds the addon first,
and `bun run --cwd packages/cli compile` builds it and compiles the binary
with it embedded.

`git` is found without macOS's xcrun shim (`locateGit` in
`@epicenter/folder/bun`; `EPICENTER_GIT` names one outright). Without one,
each Git command fails with `GitMissingError`.
Every command also accepts the hidden `--desktop`, which Rust passes to select
the desktop grant (ADR-0558); `auth token`, `auth logout`, and
`auth git-credential` act on that grant only with it.

Without `Bun.secrets` in the binary, every keychain command fails and says
so. `EPICENTER_TEST_SECRETS` replaces the keychain with in-memory stores,
the sign-ins' seeded from its `$auth` member and every other one empty, so
tests never touch the real one.

The shell runs its bundled sidecar in place and links it at `AppPaths.engine`
for terminal use. Git configuration stores no path to the CLI.

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
| `device` | `so.epicenter.cli` | `auth login`: device authorization (RFC 8628). It prints the link and code, or `{"device": {...}}` with `--json`, and polls until the person approves on the server's page. | Every command run without `--desktop`: a terminal, an agent, Git. |
| `desktop` | `so.epicenter` | `auth login --desktop`: authorization code with S256 PKCE, received once on `http://127.0.0.1:<random port>/callback`. It opens the browser, or prints `{"open": "<url>"}` with `--json` for Rust to open. | Only commands Rust runs with `--desktop`. |

Both ask for `openid offline_access profile ai folders:read folders:write`
and both audiences. Each refresh names one audience, and the server narrows
that access token to the audience's scopes while the grant keeps all of
them. `auth login` then caches an API token and reads who approved the grant
from the server's userinfo, which `auth status` reports without a network
request. Each sign-in records a random generation; token refresh keeps it
unchanged. The device
login leaves Git configuration alone. `sync` and `clone` supply the grant's
token to the core for a hosted remote's rounds. The hidden
`auth git-credential` command can still answer an explicit Git credential
request.

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

Every built resource accepts only these tokens (ADR-0549): a token reaches
only the deployment paths of the audience it names.

## Directories

The CLI reads and writes where the desktop shell does
(`src/app-paths.ts`). The shell sets `EPICENTER_DATA_DIR` for sign-in locks
and `EPICENTER_ENVIRONMENT` for the library root when it runs the CLI.
A terminal command uses the environment embedded at build time;
`EPICENTER_ENVIRONMENT` overrides it. The library root is fixed at `~/Epicenter` or
`~/Epicenter Dev`.

## Merging with plain Git

The committed `.gitattributes` names `merge=epicenter`. Sync merges notes
with `settle` inside the core and saves no merge driver in the repository.
A plain `git merge` or `git pull` uses Git's line merge for a note unless
the person configures `merge.epicenter.driver` to run
`epicenter merge-driver %O %A %B %P` themselves
([ADR-0733](../../docs/adr/0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)).

## Output and exit codes

Every command but `auth git-credential` takes `--json`, and only `--json` switches the output: one JSON
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
| `src/sync/` | `init`, `connect`, `sync`, `status`, `clone`, `forget`, and the merge driver, over the sync core; `status` and the merge driver over the system `git`. |
| `src/stop.ts` | The one stop-signal handler: wait for an unfinished refresh or round, then exit. |
| `src/repository-commands.ts` | `repos`, and the token `sync` and `clone` send to the deployment's Git. |
| `src/app-paths.ts` | Where the Epicenter folder, the sign-in locks, and the engine live, by the shell's rule. |
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
directories, so it can run against the compiled binary too.
`src/auth.postgres.test.ts` signs in against `@epicenter/server`'s
authorization server in process, on a disposable Postgres cluster (it needs
`initdb` and `pg_ctl` on `PATH`), approving as the server's own checks do.

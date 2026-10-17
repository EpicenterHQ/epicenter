# @epicenter/cli

The `epicenter` command. Each command is a thin wrapper over a function in a
shared package; the CLI parses, prints, and picks the exit code, and holds no
logic a page or the browser also needs (ADR-0556). Desktop-only work, such as
installing apps and `install-command`, lives in the CLI's own modules. The
command surface is ADR-0558's.

```sh
bun run epicenter check path/to/folder          # from the repository root
bun packages/cli/src/bin.ts query path/to/folder 'SELECT stem FROM posts'
```

The desktop app compiles `src/bin.ts` into the one binary it ships (`bun run
--cwd apps/epicenter build:sidecar`). That binary also runs as `bun` with
`BUN_BE_BUN=1`; see
[the epicenter binary](../../apps/epicenter/README.md#the-epicenter-binary).

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check <dir>` | built | `checkFolder` in `@epicenter/folder/bun` |
| `epicenter query <dir> [<sql>]` | built | `checkFolder`, `queryFolder`, `describeTables` |
| `epicenter generate <dir>` | built | `generateDefinition` |
| `epicenter status <dir>` | built | `runHistory` in `@epicenter/folder/bun` |
| `epicenter history <dir> [--depth <n>]` | built, hidden | `runHistory` |
| `epicenter save-version <dir> [-m <text>]` | built, hidden | `runHistory` |
| `epicenter sync <dir> [--to <namespace>/<name>]` | built | `runHistory`, `src/repository-commands.ts` |
| `epicenter clone <namespace>/<name> \| <url> [<dir>]` | built | `src/repository-commands.ts` |
| `epicenter repos` | built | `src/repository-commands.ts` |
| `epicenter app list [--repository <url>]` | built | `src/installed-apps.ts` |
| `epicenter app install <url> [--folder <path>] [--approve]` | built | `src/installed-apps.ts` |
| `epicenter app update <id> [--approve]` | built | `src/installed-apps.ts` |
| `epicenter app remove <id>` | built | `src/installed-apps.ts` |
| `epicenter auth login` | built | `src/auth.ts` |
| `epicenter auth logout` | built | `src/auth.ts` |
| `epicenter auth status` | built | `src/auth.ts` |
| `epicenter auth token [--resource <url>]` | built | `src/auth.ts` |
| `epicenter auth git-credential get \| store \| erase` | built | `src/auth.ts` |
| `epicenter auth key set \| remove \| state <id>` | built | `saveKey`, `removeKey`, `keyState` in `@epicenter/ai/send` |
| `epicenter send` | built, hidden | `sendRequest` and `responseEvents` in `@epicenter/ai/send` |
| `epicenter install-command` | built, hidden | `src/install-command.ts` |
| `epicenter declare-epicenter-folder` | built, hidden | `src/epicenter-folder.ts` |

`send`, `history`, `save-version`, `install-command`,
`declare-epicenter-folder`, `app update --commit`, `sync --allow-unrelated`,
and `--desktop` are left out of `--help`: the desktop app runs them.

## Hosted repositories

A hosted folder's remote is `<git origin>/<namespace>/<name>.git`
(ADR-0546), where the git origin is `https://git.epicenter.so` for the hosted
cloud and `<origin>/git` for any other deployment, and `<namespace>` is the
owner's 12-character id (`epicenter repos` lists them).

- `epicenter sync <dir> --to <namespace>/<name>` sets `remote.origin.url`
  and syncs. The server answers a name nobody holds
  as an empty repository, so the sync's fetch finds nothing to take, and its
  push creates the repository. `--to` also takes any remote's URL, as the
  desktop app passes it. Any sync whose remote is one of the deployment's
  hosted repositories carries the grant's token to `git` as a header (an
  `https` remote only; an `http` one, as a local server, uses the helper).
  Neither `sync` nor `clone` writes Git's global configuration.
- `epicenter clone <namespace>/<name> [<dir>]` clones into `<dir>`, by default
  `~/Epicenter/<name>`. A URL is cloned as given.
- `epicenter repos` lists the repositories of every namespace the sign-in may
  reach, the personal one first. With `--json`:
  `{"namespaces": [{"id", "title", "personal", "role", "repositories":
  [{"id", "name", "url"}]}]}`.

`hosted-git.postgres.test.ts` runs these against the real server, and a
plain `git` signing in through `epicenter auth git-credential`; it seeds the processes'
in-memory keychain with a signed-in grant through `EPICENTER_TEST_SECRETS`'s
`$auth` member.

## Folder history

`status`, `history`, `save-version`, and `sync` run a folder's history over
the system `git` (ADR-0559), each a thin wrapper over `runHistory` in
`@epicenter/folder/bun`, the engine a desktop page's history runs in. The
desktop shell runs them for a page, one child per operation, with `--json`;
the one reply line is `history-wire.ts`'s encoding, which the page decodes.
Git's own configuration names the author, and otherwise it is
`Epicenter <epicenter@localhost>`; history is recorded on `main`. A folder
directly under the Epicenter folder root named `so.epicenter` or an
installed app's id is that app's own folder (`isApplicationFolder`), which
may get a repository inside another repository's working tree; any other
folder may not. When the shell ends the child (a page reloaded, or its
window closed), the child ends every `git` it started, with their helpers
(`src/stop.ts`).

- `status` reads only, and takes no lock.
- `save-version` records the folder's edits as one commit, with `-m` as its
  message when given, under the folder's history lock.
- `sync` records the edits, fetches, and merges both heads into one commit
  by each file's kind (ADR-0576), pushed before the folder's files change,
  under the same lock. `--to <url>` connects first, to a network URL only.
  This folder's version of a unit both sides changed wins, and each lost
  unit is an `Overrode:` trailer on the merge. A sync asks nothing.

The history lock is an exclusive SQLite transaction on
`.<name>.epicenter-history-lock` beside the folder, the mechanism of the
save lock (ADR-0562): Bun has no `flock`, and SQLite's `fcntl` or
`LockFileEx` lock is released by the system when its process ends, however
it ends. It is apart from the save lock, so a page's saves never wait on a
sync. Each waits up to 60 seconds.

`git` is found without macOS's xcrun shim (`locateGit` in
`@epicenter/folder/bun`; `EPICENTER_GIT` names one outright). Without one,
each history command exits 2 with `{"error": "GitMissing", "install": ...}`
under `--json`.
Every command also accepts the hidden `--desktop`, which Rust passes to select
the desktop grant (ADR-0558); `auth token`, `auth logout`,
`auth git-credential`, and `send` act on that grant only with it.

`auth key` and `send` are ADR-0557's. An AI connection is a row of
`so.epicenter/connections`; its endpoint and key live in this computer's
keychain under the row's id, through `Bun.secrets` (service
`so.epicenter.connections`). `auth key set <id>` reads `{"endpoint", "key"}`
as JSON on stdin, never from the command line, and `state` prints the
endpoint and whether a key is saved, never the key. `send` reads one JSON
line, `{"target", "request"}`, then the request body's raw bytes on stdin;
it sends an Epicenter connection to the deployment's `/v1` with an access
token from `auth` (the desktop grant's under `--desktop`, otherwise the
device grant's). An account target, `{"kind": "account", "audience": "api"
| "git"}`, names one of the deployment's resources by role (ADR-0549): `send`
sends a path below the deployment's `/api/` with that grant's token for the
resource's audience and refuses any other path, such as `/auth/*`, before
asking for a token. It refuses a local connection, a missing key or
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

`declare-epicenter-folder` publishes `so.epicenter`'s declaration
(`src/epicenter-folder.ts`), which the desktop app runs at every launch so an
installed app reading its `connections` table through its definition finds
the table before any app opens.

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
request. The device login also sets, in Git's global configuration, an empty
`credential.<git audience>.helper` and then `!'<home>/.local/bin/epicenter'
auth git-credential`, so no broader helper is asked to store the token. Only
`auth login` writes it.

`auth token [--resource <url>]` prints an access token for the API or the
Git audience. A cached token is reused until five minutes before it
expires; otherwise one refresh runs under `<data dir>/auth/<grant>.lock`, an
exclusive SQLite transaction the system releases if the process dies
(`holdingFileLock` in `@epicenter/folder/bun`), and rereads the entry inside it, so concurrent callers
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
reaches `/api/*` with a token for the audience it names.

## Installing apps

`app` installs, updates, lists, and removes apps on this machine (ADR-0540,
ADR-0552, ADR-0560), in the directories the desktop shell uses: its
`EPICENTER_DATA_DIR`, `EPICENTER_FOLDER_DIR`, and `EPICENTER_CACHE_DIR`, which
the shell sets when it runs the CLI, or the release app's when they are unset
(`src/app-paths.ts`). `app install` clones a repository's default branch
bare into `apps/<app-id>/` in the data directory, reading the id from the
`epicenter.app.json` in `--folder` (only `id` and `title`, nothing else).
`app list --repository <url>` lists the apps a repository holds without
installing any.

The clone's detached `HEAD` is the approved commit (ADR-0597). A fresh
install's `HEAD` is symbolic and approves nothing; `app update` fetches,
which writes `refs/remotes/origin/<default>` and never `HEAD`. Without
`--approve`, `install` and `update` print the fetched commit waiting for
approval with its log and diff stat; `install` exits 1, since nothing is
approved yet. `--approve` approves it with `git update-ref --no-deref HEAD`,
and `app update --commit <sha> --approve` approves only the commit shown, so
approving never covers a commit nobody saw.

Until publishing builds apps (ADR-0589), the approved commit is built from
source: it is extracted with `git archive` into `sources/<app-id>/` in the
cache directory, `bun install --frozen-lockfile --ignore-scripts` runs at its
root and `bun run build:installed` in the app's folder, run by this binary as
`bun` (`BUN_BE_BUN=1`). The regular files of its `dist/` are written into the
clone as the tree `refs/epicenter/builds/<commit>`, which is extracted with
`git archive` into `builds/<app-id>/<commit>/`. `app update --commit <sha>`,
hidden, is what the shell runs before every open: it answers only for the
approved commit, builds it when it is not built, and checks its build
directory against that tree by path and blob hash. A damaged build stays in
place, since a window may be running it, and a fresh copy is extracted beside
it (`state: damaged`) for the shell to swap in. `app remove` deletes the
clone and leaves the builds for windows still running them.

Git runs through `@epicenter/folder`'s runner (`createGitRunner`), with no
hooks and the `ext` and `fd` transports refused. One install, update, or
build runs at a time (`<cache>/apps.lock`, `holdingFileLock`).

## Merging with plain Git

`epicenter sync` merges a folder's files by unit, with the merge every save
uses (ADR-0576, ADR-0591): Markdown frontmatter by field and its body by line,
JSON by key, other text by line. Plain `git merge` and `git pull` run on a
folder use Git's own merge and stop on Git's ordinary conflict markers;
nothing configures a merge driver for them.

## Output and exit codes

Every command but `auth git-credential` takes `--json`, and only `--json` switches the output: one JSON
value on one line of stdout, or, for `sync`, `clone`, `app install`, and
`app update`, `auth login`, NDJSON progress lines ending in one result line (for `app`,
`{"progress": "<sentence>"}` lines, then `{"app": {...}}`, exit 0 when built
and 1 while it waits for approval). Without it,
stdout is the answer and stderr is for people. A command that cannot do its
work prints `{"error": "..."}` on stdout with `--json`, and the message on
stderr without it.

Exit codes are ADR-0520's: 0 done, 1 a finding a person acts on (a file that
does not conform, an app waiting for approval, a sync that stopped), 2
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
| `src/folder-commands.ts` | `check`, `query`, and `generate`, printing what `@epicenter/folder/bun` returns. |
| `src/install-command.ts` | `install-command`: the one link Git's configuration runs. |
| `src/epicenter-folder.ts` | `so.epicenter`'s definition and `declare-epicenter-folder`. |
| `src/stop.ts` | The one stop-signal handler: cleanups at once, then unfinished refreshes, then exit. |
| `src/repository-commands.ts` | `clone`, `repos`, and the hosted side of `sync`: the remote `--to` names and the token for the deployment's Git. |
| `src/app-commands.ts` | `app list`, `install`, `update`, and `remove`, printing what `src/installed-apps.ts` returns. |
| `src/installed-apps.ts` | Installing apps: the manifest, approvals, clones, updates, and builds. |
| `src/app-paths.ts` | Where installed apps, approvals, builds, the sign-in locks, and the command link live, by the shell's rule. |
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
`src/installed-apps.test.ts` installs apps from repositories it makes, and
its last tests run `app` through the command. With `EPICENTER_MONOREPO` set
to a clone of this repository, it also installs and builds Todos, Capture,
Whispering, and Honeycrisp from their folders, which needs the network and a
few minutes:

```sh
EPICENTER_MONOREPO=/path/to/epicenter-clone bun test src/installed-apps.test.ts
```

# @epicenter/cli

This README describes implemented commands. `check` and `query` currently require
root `epicenter.json`, and `generate` produces it from `epicenter.ts`. The
chosen v1 direction keeps that root path for check and query, using a static
schema obtained from a registry or authored directly. The schema format still
needs migration; external-schema flags are deferred. Apps need no root schema
file and never publish it by opening or saving. The old generation
workflow is preserved in superseded
[ADR-0527](../../docs/adr/0527-a-data-folder-may-keep-its-declaration-as-typescript.md).
See [shared vocabulary](../../docs/CONTEXT.md) and
[ADR-0632](../../docs/adr/0632-a-lens-belongs-to-its-reader.md).

The `epicenter` command. Each command is a thin wrapper over a function in a
shared package; the CLI parses, prints, and picks the exit code, and holds no
logic a page or the browser also needs (ADR-0556). Desktop-only work, such as
`install-command`, lives in the CLI's own modules. The
implemented command surface retains ADR-0558's `auth` group; its `app` group
is deleted. ADR-0611 describes the planned reduction.

```sh
bun run epicenter check path/to/folder          # from the repository root
bun packages/cli/src/bin.ts query path/to/folder 'SELECT stem FROM posts'
```

The desktop app compiles `src/bin.ts` into the one binary it ships (`bun run
--cwd apps/epicenter build:sidecar`); see
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
| `epicenter auth login` | built | `src/auth.ts` |
| `epicenter auth logout` | built | `src/auth.ts` |
| `epicenter auth status` | built | `src/auth.ts` |
| `epicenter auth token [--resource <url>]` | built | `src/auth.ts` |
| `epicenter auth git-credential get \| store \| erase` | built | `src/auth.ts` |
| `epicenter auth key set \| remove \| state <id>` | built | `saveKey`, `removeKey`, `keyState` in `@epicenter/ai/send` |
| `epicenter send` | built, hidden | `sendRequest` and `responseEvents` in `@epicenter/ai/send` |
| `epicenter install-command` | built, hidden | `src/install-command.ts` |

`send`, `history`, `save-version`, `install-command`, `sync --allow-unrelated`,
and `--desktop` are left out of `--help`: the desktop app runs them.

The source installer, the `app` group, is deleted, with no alias: Epicenter
bundles its apps. Clones an earlier build installed under `apps/` in the data
directory, and builds under `builds/` in the cache directory, are left on
disk, never read and never removed.

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
`Epicenter <epicenter@localhost>`; history is recorded on `main`. Epicenter's
own folder, `so.epicenter` directly under the Epicenter folder root
(`isApplicationFolder`), may get a repository inside another repository's
working tree; any other folder may not. That includes a folder named by the
id of an app an earlier build installed, such as `so.epicenter.todos`: it is
a data folder now, so its first commit is refused while it sits inside
another repository's working tree. Its files read and open as before. When the shell ends the child (a page reloaded, or its
window closed), the child ends every `git` it started, with their helpers
(`src/stop.ts`).

- `status` and `history` read only, and take no lock.
- `save-version` and `sync` commit only a folder that has declared what
  stays on this computer: the `local` list of its root `epicenter.json`. They
  read nothing else of the file, so tables an app cannot read do not stop
  them, and a file that lists no `local` keeps nothing local. With no
  `epicenter.json`, or one whose `local` cannot be used (not JSON, an unknown
  top-level key such as `Local`, a pattern that is not one ignoring
  `.gitignore` line, or one that matches `epicenter.json` itself), they
  refuse before any repository, commit, or push and
  say so; opening a folder never writes one. A Whispering folder needs at
  least this `epicenter.json` before its recordings can be exchanged without
  their audio:

  ```json
  {"local": ["audio/"]}
  ```
- `save-version` records the folder's edits as one commit, with `-m` as its
  message when given, under the folder's history lock.
- `sync` records the edits, fetches, and merges both heads into one commit
  by each file's kind (ADR-0576), pushed before the folder's files change,
  under the same lock. `--to <url>` connects first, to a network URL only.
  This folder's version of a unit both sides changed wins, and each lost
  unit is an `Overrode:` trailer on the merge. A sync asks nothing.
  Before pushing, it stops when the remote's `epicenter.json`
  drops a `local` rule this folder's still lists (remove it here too to
  share those files), when a merge would drop a rule the remote's newly
  lists (add it here), when the remote removed `epicenter.json` (restore it
  there), or when a commit the remote does not have adds or changes a path a
  rule keeps local, which it names; it never rewrites history. A rule saved
  here while it syncs is kept in the file it publishes, or publication stops
  with the local files unchanged. That late check may run after a merge was
  pushed; the next sync resumes from the recorded state.

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

## Directories

The CLI reads and writes where the desktop shell does
(`src/app-paths.ts`): `EPICENTER_DATA_DIR` for the sign-in locks and
`EPICENTER_FOLDER_DIR` for the Epicenter folder, which the shell sets when it
runs the CLI, or the release app's directories when they are unset.

## Merging with plain Git

`epicenter sync` merges a folder's files by unit, with the merge every save
uses (ADR-0576, ADR-0591): Markdown frontmatter by field and its body by line,
JSON by key, other text by line. Plain `git merge` and `git pull` run on a
folder use Git's own merge and stop on Git's ordinary conflict markers;
nothing configures a merge driver for them.

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
| `src/folder-commands.ts` | `check`, `query`, and `generate`, printing what `@epicenter/folder/bun` returns. |
| `src/install-command.ts` | `install-command`: the one link Git's configuration runs. |
| `src/stop.ts` | The one stop-signal handler: cleanups at once, then unfinished refreshes, then exit. |
| `src/repository-commands.ts` | `clone`, `repos`, and the hosted side of `sync`: the remote `--to` names and the token for the deployment's Git. |
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

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

The desktop app compiles the same `runCli` into the one binary it ships
(`apps/epicenter/src/epicenter-binary.ts`, built by `bun run --cwd
apps/epicenter build:sidecar`). That binary also has the Bun host as a hidden
`__host` mode and runs as `bun` with `BUN_BE_BUN=1`; see
[the epicenter binary](../../apps/epicenter/README.md#the-epicenter-binary).

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check <dir>` | built | `checkFolder` in `@epicenter/folder/bun` |
| `epicenter query <dir> [<sql>]` | built | `checkFolder`, `queryFolder`, `describeTables` |
| `epicenter generate <dir>` | built | `generateDeclaration` |
| `epicenter status <dir>` | built | `runHistory` in `@epicenter/folder/bun` |
| `epicenter history <dir> [--depth <n>]` | built, hidden | `runHistory` |
| `epicenter save-version <dir> [-m <text>]` | built, hidden | `runHistory` |
| `epicenter sync <dir> [--to <namespace>/<name>] [--resolve <choices.json>]` | built but `--to` | `runHistory` |
| `epicenter clone <namespace>/<name> \| <url> [<dir>]` | not built | |
| `epicenter repos` | not built | |
| `epicenter open <dir> [--app <id>]` | not built | |
| `epicenter app list [--repository <url>]` | built | `src/installed-apps.ts` |
| `epicenter app install <url> [--folder <path>] [--approve]` | built | `src/installed-apps.ts` |
| `epicenter app update <id> [--approve]` | built | `src/installed-apps.ts` |
| `epicenter app remove <id>` | built | `src/installed-apps.ts` |
| `epicenter auth login [--loopback]` | not built | |
| `epicenter auth logout` | not built | |
| `epicenter auth status` | not built | |
| `epicenter auth token [--resource <url>]` | not built | |
| `epicenter auth git-credential get \| store \| erase` | not built | |
| `epicenter auth key set \| remove \| state <id>` | built | `saveKey`, `removeKey`, `keyState` in `@epicenter/ai/send` |
| `epicenter send` | built, hidden | `sendRequest` and `responseEvents` in `@epicenter/ai/send` |
| `epicenter install-command [--dry-run]` | built, hidden | `src/install-command.ts` |

A command not built yet parses its arguments, shows in `--help` marked
"not built yet", and exits 2 naming its ADR. `send`, `history`,
`save-version`, `install-command`, `auth login --loopback`,
`app update --commit`, and `sync`'s `--remote`, `--allow-unrelated`, and
`--credential-stdin` are left out of `--help`: the desktop app runs them.

## Folder history

`status`, `history`, `save-version`, and `sync` run a folder's history over
the system `git` (ADR-0559), each a thin wrapper over `runHistory` in
`@epicenter/folder/bun`, the engine a desktop page's history runs in. The
desktop shell runs them for a page, one child per operation, with `--json`;
the one reply line is `history-wire.ts`'s encoding, which the page decodes.
The shell sets `EPICENTER_AUTHOR_NAME`, `EPICENTER_AUTHOR_EMAIL`,
`EPICENTER_BRANCH`, and `EPICENTER_FOLDER_KIND` from the folder's
registration; a terminal leaves them unset, and Git's own configuration
names the author. When the shell ends the child (a page reloaded, or its
window closed), the child ends every `git` it started, with their helpers.

- `status` reads only, and takes no lock.
- `save-version` records the folder's edits as one commit, with `-m` as its
  message when given, under the folder's history lock.
- `sync` records the edits, fetches, merges by each file's kind (ADR-0551),
  and pushes, under the same lock. `--remote <url>` connects first, to a
  network URL only. Changes both sides made to one unit exit 1 with the
  conflicts and record the attempt as `.git/epicenter/sync-attempt.json`:
  its ID and the commits it merged. `--resolve <file>`, or `-` for standard
  input, settles it with `{"attempt": "<id>", "choices": {...}}`; the
  conflicts are merged again from the recorded commits. A later sync
  retires the attempt. `--credential-stdin` reads
  `{"credential": {"url", "username", "password"}}` from standard input,
  sent by Git only to that exact `https` URL. `--to` is not built.

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
the desktop grant (ADR-0558); no command uses a grant yet, so it changes
nothing.

`auth key` and `send` are ADR-0557's. An AI connection is a row of
`so.epicenter/connections`; its endpoint and key live in this computer's
keychain under the row's id, through `Bun.secrets` (service
`so.epicenter.connections`). `auth key set <id>` reads `{"endpoint", "key"}`
as JSON on stdin, never from the command line, and `state` prints the
endpoint and whether a key is saved, never the key. `send` reads one JSON
line, `{"target", "request"}`, then the request body's raw bytes on stdin;
it refuses an Epicenter connection (signing in is not built), a local one,
a missing key, and a request prepared for another endpoint than the
keychain holds, and otherwise prints the response as NDJSON: a `head`, the
body in base64 `chunk` lines of at most 64 KiB, and `end`, or an `error`.
It exits 0 when a response arrived, whatever its status, and 2 otherwise.
Without `Bun.secrets` in the binary, every keychain command fails and says
so. `EPICENTER_TEST_SECRETS` replaces the keychain with an in-memory store
seeded from its JSON, so tests never touch the real one.

`install-command` is ADR-0558's hidden command. It links the compiled binary
onto `PATH` as `/usr/local/bin/epicenter` (ADR-0556's "Install the epicenter
command"):
it makes or replaces a symbolic link and refuses a regular file. When the
directory is missing or not writable, it asks a person at a terminal before
running `sudo`; with `--json` or without a terminal it exits 1 and names the
`sudo` command. Run from source under `bun`, it refuses, since it would link
`bun` itself.

## Installing apps

`app` installs, updates, lists, and removes apps on this machine (ADR-0540,
ADR-0552, ADR-0560), in the directories the desktop shell uses: its
`EPICENTER_DATA_DIR`, `EPICENTER_FOLDER_DIR`, and `EPICENTER_CACHE_DIR`, which
the shell sets when it runs the CLI, or the release app's when they are unset
(`src/app-paths.ts`). `app install` clones a repository into
`Apps/<app-id>/`, reading the id from the `epicenter.app.json` in `--folder`
(only `id` and `title`, nothing else). `app list --repository <url>` lists
the apps a repository holds without installing any.

A commit fetched from elsewhere builds only once approved: without
`--approve`, `install` and `update` print it with its log and diff stat and
exit 1. A commit made on this machine builds without asking, and building it
records it as approved. The build is `bun install --frozen-lockfile
--ignore-scripts` at the repository's root, then `bun run build:installed` in
the app's folder, run by this binary as `bun` (`BUN_BE_BUN=1`), and its
`dist/` is copied to `builds/<app-id>/<commit>/`. `app update --commit <sha>`,
hidden, fetches nothing and acts only on that commit: the Folders window
passes the commit it showed, so approving never covers a commit nobody saw.
`app remove` refuses while the clone holds uncommitted changes or commits no
remote has.

Git runs through `@epicenter/folder`'s runner (`createGitRunner`), with no
hooks and the `ext` and `fd` transports refused. One install, update, or
build runs at a time (`<cache>/apps.lock`). The Folders window writes each
app's row in `so.epicenter`; the CLI does not.

## Output and exit codes

Every command takes `--json`, and only `--json` switches the output: one JSON
value on one line of stdout, or, for `sync`, `clone`, `app install`, and
`app update`, NDJSON progress lines ending in one result line (for `app`,
`{"progress": "<sentence>"}` lines, then `{"app": {...}}`, exit 0 when built
and 1 while it waits for approval). Without it,
stdout is the answer and stderr is for people. A command that cannot do its
work prints `{"error": "..."}` on stdout with `--json`, and the message on
stderr without it.

Exit codes are ADR-0520's: 0 done, 1 a finding a person acts on (a file that
does not conform, an app waiting for approval, a sync that needs choices), 2
input the command cannot use (a folder that is not one, a refused statement,
an unknown option, a command not built yet, no `git`).

Options are matched exactly, so a SQL statement that starts with `--` stays a
statement. A token shaped like an option the command does not take is
refused. After `--`, every token is a positional. The CLI never calls
`process.exit`, so stdout drains before the process ends, except when a
signal ends a history command, whose output nobody reads then. A running
command holds a timer, since Bun 1.3.14 can otherwise end the process while
`crypto.subtle` work started after a child process exited is still pending.

## Layout

| Path | What it is |
| --- | --- |
| `src/bin.ts` | The command run from source. |
| `src/cli.ts` | `runCli`: help, version, and dispatch to the built commands. |
| `src/commands.ts` | Every command ADR-0558 names, with its usage and ADR. |
| `src/parse.ts` | The hand-written parser. |
| `src/folder-commands.ts` | `check`, `query`, and `generate`, printing what `@epicenter/folder/bun` returns. |
| `src/install-command.ts` | `install-command`. |
| `src/app-commands.ts` | `app list`, `install`, `update`, and `remove`, printing what `src/installed-apps.ts` returns. |
| `src/installed-apps.ts` | Installing apps: the manifest, approvals, clones, updates, and builds. |
| `src/app-paths.ts` | Where installed apps, approvals, and builds live, by the shell's rule. |
| `src/ai-commands.ts` | `auth key` and `send`, printing what `@epicenter/ai/send` returns. |
| `src/secrets.ts` | The keychain through `Bun.secrets`, or the test store. |
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
`src/installed-apps.test.ts` installs apps from repositories it makes, and
its last tests run `app` through the command. With `EPICENTER_MONOREPO` set
to a clone of this repository, it also installs and builds Todos, Capture,
Whispering, and Honeycrisp from their folders, which needs the network and a
few minutes:

```sh
EPICENTER_MONOREPO=/path/to/epicenter-clone bun test src/installed-apps.test.ts
```

# 0558. The epicenter CLI groups only its app and auth commands

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) at "The CLI has no account or transfer commands": it has `auth`, `sync`, `clone`, and `repos`, every command that acts on a local folder still takes its path, and exit code 2 also covers a program a command needs that is missing.
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at the command names `epicenter login` and `epicenter git-credential`, which are `epicenter auth login` and `epicenter auth git-credential`.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the command names, which are `epicenter auth login` and `epicenter auth git-credential`, and at its refusal of "Loopback login for the CLI", narrowed so that `so.epicenter.cli` keeps only the device grant while `epicenter auth login --loopback` is the desktop client `so.epicenter` signing in from the bundled binary.
- **Amended by:** [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at the Git helper `epicenter auth login` writes: `credential.<the deployment's Git audience>.helper` is set to an empty value and then to `!'<absolute path to the CLI>' auth git-credential`, not `!epicenter auth git-credential`.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the CLI is Epicenter's only TypeScript outside a WebView, run by Rust with `--json`), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) (the Git commands Rust runs), [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) (AI keys), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge `sync` uses), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) (installing from a folder in a repository), [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) (the save lock).
- **Unbuilt:** every command but `check`, `query`, `generate`, `send`, `install-command`, and the `app` and `auth` groups (an unbuilt command in the parser exits 2 naming its record); `auth key` in the parser; the `-c` helper the CLI passes to the `git` it spawns; the `epicenter://open` deep link `open` uses; `install-command` on Windows.

## Context

<!-- doc-path-check: ignore-next-line -->
`scripts/epicenter.ts` (404 lines) has three commands, `check <dir>`,
`query <dir> [<sql>]`, and `generate <dir>`, each taking a folder's path
(ADR-0520), with exit codes 0, 1 for a finding, and 2 for input the tool
cannot use. ADR-0520 says the CLI has no account or transfer commands.

Since then ADR-0546 and ADR-0549 named `epicenter login` and
`epicenter git-credential`, and ADR-0556 makes the CLI the program that owns
the network, secrets, Git, auth, and installing apps, run by Rust for each.
Rust's fixed commands each need one CLI invocation: `send` (ADR-0556),
`status`, `history`, `save_version`, and `sync` (ADR-0559), and the AI key
commands (ADR-0557). Each new command needs a place, and an agent needs one
contract for all of them.

ADR-0549 gives the CLI and agents the device grant, approved every time with a
scope and target the person picks, and the desktop app its own loopback grant
with target `*`. ADR-0546 lets an agent that needs less get its own narrower
grant.

## Decision

**Folder verbs sit at the top level and take a path; only `app` and `auth` are
groups.**

```txt
epicenter check <dir>                              existing (ADR-0520)
epicenter query <dir> [<sql>]                      existing (ADR-0520)
epicenter generate <dir>                           existing (ADR-0527)
epicenter status <dir>                             changed files, ahead and behind, the remote
epicenter history <dir>                            hidden; the versions of the folder (ADR-0559)
epicenter save-version <dir>                       hidden; commit the folder's edits as a version (ADR-0559)
epicenter sync <dir> [--to <namespace>/<name>] [--resolve <choices.json>]
                                                   fetch, merge by file kind (ADR-0551), commit, push
epicenter clone <namespace>/<name> | <url> [<dir>] clone into <dir>, default ~/Epicenter/<name>
epicenter repos                                    GET /api/repos: the caller's repositories
epicenter open <dir> [--app <id>]                  open it in Epicenter through epicenter://open
epicenter send                                     hidden; one request for a page (ADR-0556)
epicenter install-command                          hidden; link this binary onto PATH as epicenter

epicenter app list
epicenter app install <url> [--folder <path>] [--approve]
epicenter app update <id> [--approve]
epicenter app remove <id>

epicenter auth login [--loopback]                  --loopback is hidden
epicenter auth logout
epicenter auth status
epicenter auth token [--resource <url>]
epicenter auth git-credential get | store | erase
epicenter auth key set <id> --endpoint <url>       the key on stdin (ADR-0557)
epicenter auth key remove <id>
epicenter auth key state <id> --endpoint <url>
```

A hidden command or option is left out of `--help` because Rust or Settings
runs it; it still parses for anyone. `auth key` sits under `auth` because a key
is a credential.

**The binary is `epicenter` on `PATH` and `epicenter-cli` in the bundle.**
Tauri's build refuses a sidecar named like the Cargo package, `epicenter`, so
the file `Epicenter.app` carries is `epicenter-cli`. `epicenter
install-command` links it onto `PATH` as `epicenter`
(`/usr/local/bin/epicenter` on macOS and Linux). Settings runs it with
`--json`; a person may run it by the bundled binary's full path.

**`sync --to` is Connect.** On a folder with no remote it sets
`remote.origin.url` to `https://git.epicenter.so/<namespace>/<name>.git` and
makes the first push, which creates the repository (ADR-0546). `--resolve`
names a JSON file of choices for the paths and keys the last `sync` left for a
person, which `sync` applies before it merges again.

**`approve` is part of `install` and `update`.** Without `--approve` they
fetch and build nothing that has not been approved, except a commit made on
this machine, which ADR-0540 approves by building it; otherwise they exit 1
with the commit and its `git diff --stat`. With `--approve` they record the
approval and build.

**No command takes a folder id for local work** (ADR-0520). `clone` and
`repos` name a repository, which is not local work.

**Every command but `auth git-credential` takes `--json`, and only `--json`
switches the output.** With it, a short command prints one JSON value on
stdout; a long one (`sync`, `clone`, `app install`, `app update`, `send`)
prints NDJSON lines on stdout and ends with one result line. Without it,
stdout is for the answer. `auth git-credential` speaks Git's credential
protocol on stdout and takes no `--json`. Stderr is for people in both modes.
Exit codes are ADR-0520's: 0 when the command did what it says, 1 for a
finding a person acts on (a file that does not conform, a merge left for
review, an app waiting for approval), and 2 when the command cannot do its
work with what it was given or found: input it cannot use, or a program it
needs that is missing, such as `git` (`GitMissing`, ADR-0559).

**`auth login` follows ADR-0549's two clients.** Without a flag it is the
device grant as `so.epicenter.cli`, for terminals and agents, as ADR-0546
says. With `--loopback` it is the desktop app's sign-in as `so.epicenter`:
authorization code with PKCE and `offline_access`, received on a one-shot
listener at `http://127.0.0.1:<port>/callback`. Settings' Sign in runs it; it
is the app's client living in the app's binary, not a second terminal flow.
Each grant's refresh token is its own keychain item. `auth token` and
`auth git-credential` refresh under one file lock in one implementation.

**The desktop grant and a terminal's grant stay apart.** Rust runs every
command with the hidden option `--desktop`, and only then does a command use
the desktop grant. Without it, `auth token`, `auth git-credential`, and every
other command use the device grant from `epicenter auth login`, so an agent's
narrower grant (ADR-0546, ADR-0549) is what that agent gets.

**`auth git-credential` is Git's helper for `git.epicenter.so`.** It answers
`get` with an access token for that audience and `password_expiry_utc`;
`store` and `erase` do nothing, since the token is minted, not stored. When
the CLI spawns `git`, it passes the helper on that one command as
`-c credential.https://git.epicenter.so.helper=!'<its own absolute path>' auth git-credential`,
with `--desktop` added when Rust started it, so it never depends on `PATH`.
For a terminal's own `git`, `epicenter auth login` sets
`credential.https://git.epicenter.so.helper=!epicenter auth git-credential` in
the person's global Git configuration.

**There is no daemon, and there is one binary.** Every command exits when its
work is done. The binary Epicenter bundles is the one on `PATH` (ADR-0556).

## Consequences

- An agent learns one shape: a verb and a path, `--json`, and three exit
  codes. `query <dir>` stays its first call in an unfamiliar repository.
- Folder verbs read as Git's do (`clone`, `status`, `sync`), so
  `epicenter sync .` works where `git pull` would.
- `app` and `auth` are grouped because they act on Epicenter on this machine,
  not on a folder.
- The CLI now writes folders and contacts the network, which ADR-0520's three
  commands never did; `check` and `query` still do neither.
- `sync` and an open app may write one folder at once; ADR-0562's save lock
  and ADR-0551's merges settle it.
- A person who signed in to the desktop app signs in again with
  `epicenter auth login` before a terminal's `git` reaches `git.epicenter.so`.
- `--desktop` keeps well-behaved agents on their own grant; it is not a
  boundary against a local process that passes it. Approval guards against
  remote code, not local processes (ADR-0540).
- On a machine with both grants, `auth logout` signs out the one `auth
  status` names; a person signs out of the other by naming it.

## Considered alternatives

- **Every command in a group** (`folder check`, `folder sync`). Longer for the
  commands an agent runs most, and a group of one noun says nothing.
- **An `ai` group for keys.** A third group for three commands Rust runs, and
  a key is a credential like the rest of `auth`.
- **A separate `connect` command.** It is the first `sync` to a new remote.
- **A separate `app approve`.** Approving without building leaves an approved
  commit nothing has built.
- **JSON whenever stdout is not a terminal.** A person piping to `less` or
  `grep` gets JSON they did not ask for, and an agent that forgets the flag
  cannot tell which mode it got.
- **A daemon the CLI talks to.** A second long-lived process (ADR-0556) for
  commands that each finish in seconds.
- **A separate `git-credential-epicenter` binary**, which Git finds by name.
  A second binary to ship and link onto `PATH`.
- **A Rust CLI.** The folder engine and ADR-0551's merge are TypeScript shared
  with pages and browsers; a Rust CLI would be a second implementation of
  both.
- **`auth login` always loopback.** ADR-0549 refuses loopback login for the
  CLI client: the device grant works on every machine, including over SSH.
- **The desktop app signs in with the device grant too.** One flow, but a
  person would copy a code inside their own desktop app, and ADR-0549
  registers the desktop client for loopback.
- **`auth token` and `auth git-credential` use the desktop grant when the
  machine holds it.** One sign-in per machine, but any local process would get
  a target-`*` token, and an agent's narrower grant would narrow nothing.

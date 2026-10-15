# 0558. The epicenter CLI groups only its app and auth commands

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) at "The CLI has no account or transfer commands": it has `auth`, `sync`, `clone`, and `repos`. Every command that acts on a local folder still takes its path, and exit codes stay 0520's.
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) and [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the command names `epicenter login` and `epicenter git-credential`, which are `epicenter auth login` and `epicenter auth git-credential`. Their grants and clients are unchanged.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at its refusal of "Loopback login for the CLI", narrowed to its scope: the CLI client `so.epicenter.cli` still has only the device grant. `epicenter auth login --loopback` is the desktop client `so.epicenter` signing in from the binary Epicenter bundles, which Settings runs; it is not a terminal flow.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the CLI is Epicenter's only TypeScript outside a WebView, run by Rust with `--json`), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge `sync` uses), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) (installing from a folder in a repository).
- **Unbuilt:** every command except `check`, `query`, and `generate` (`scripts/epicenter.ts`); `--json` on `generate`, which refuses it today (`scripts/epicenter.ts:392-396`); the `epicenter://open` deep link `open` uses.

## Context

`scripts/epicenter.ts` (404 lines) has three commands, `check <dir>`,
`query <dir> [<sql>]`, and `generate <dir>`, each taking a folder's path
(ADR-0520), with exit codes 0, 1 for a finding, and 2 for input the tool
cannot use. ADR-0520 says the CLI has no account or transfer commands.

Since then ADR-0546 and ADR-0549 named `epicenter login` and
`epicenter git-credential`, and ADR-0556 makes the CLI the program that owns
the network, secrets, Git, auth, and installing apps, run by Rust for each.
Each new command needs a place, and an agent needs one contract for all of
them.

## Decision

**Folder verbs sit at the top level and take a path; only `app` and `auth` are
groups.**

```txt
epicenter check <dir>                              existing (ADR-0520)
epicenter query <dir> [<sql>]                      existing (ADR-0520)
epicenter generate <dir>                           existing (ADR-0527)
epicenter status <dir>                             changed files, ahead and behind, the remote
epicenter sync <dir> [--to <namespace>/<name>] [--resolve <choices.json>]
                                                   fetch, merge by file kind (ADR-0551), commit, push
epicenter clone <namespace>/<name> | <url> [<dir>] clone into <dir>, default ~/Epicenter/<name>
epicenter repos                                    GET /api/repos: the caller's repositories
epicenter open <dir> [--app <id>]                  open it in Epicenter through epicenter://open

epicenter app list
epicenter app install <url> [--folder <path>] [--approve]
epicenter app update <id> [--approve]
epicenter app remove <id>

epicenter auth login [--loopback]
epicenter auth logout
epicenter auth status
epicenter auth token [--resource <url>]
epicenter auth git-credential get | store | erase
```

**`sync --to` is Connect.** On a folder with no remote it sets
`remote.origin.url` to `https://git.epicenter.so/<namespace>/<name>.git` and
makes the first push, which creates the repository (ADR-0546). `--resolve`
names a JSON file of choices for the paths and keys the last `sync` left for a
person, which `sync` applies before it merges again.

**`approve` is part of `install` and `update`.** Without `--approve` they fetch
and build nothing that has not been approved, and exit 1 with the commit and
its `git diff --stat`; with it they record the approval and build.

**`send` is internal.** Rust runs `epicenter send` for ADR-0556's `send`
command; `--help` does not list it.

**No command takes a folder id for local work** (ADR-0520). `clone` and
`repos` name a repository, which is not local work.

**Every command takes `--json`, and only `--json` switches the output.** With
it, a short command prints one JSON value on stdout; a long one (`sync`,
`clone`, `app install`, `app update`) prints NDJSON progress lines on stdout
and ends with one result line. Without it, stdout is for the answer. Stderr is
for people in both modes. Exit codes are ADR-0520's: 0 when the command did
what it says, 1 for a finding a person acts on (a file that does not conform,
a merge left for review, an app waiting for approval), and 2 for input the
tool cannot use.

**`auth login` follows ADR-0549's two clients.** Without a flag it is the
device grant as `so.epicenter.cli`, for terminals and agents, as ADR-0546
says. With `--loopback` it is the desktop app's sign-in as `so.epicenter`:
authorization code with PKCE and `offline_access`, received on a one-shot
listener at `http://127.0.0.1:<port>/callback`; Settings' Sign in runs it,
and `--help` does not list it, since it is the app's client living in the
app's binary, not a second terminal flow. Each grant's refresh token is its own
keychain item. `auth token` and `auth git-credential` refresh under one file
lock in one implementation, and use the desktop grant when this machine holds
both.

**`auth git-credential` is Git's helper for `git.epicenter.so`**, configured
as `credential.https://git.epicenter.so.helper=!epicenter auth git-credential`.
It answers `get` with an access token for that audience and
`password_expiry_utc`; `store` and `erase` do nothing, since the token is
minted, not stored.

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
- `sync` and an open app may write one folder at once; ADR-0556's save lock
  and ADR-0551's merges settle it.
- On a machine with both grants, `auth logout` signs out the one `auth
  status` names; a person signs out of the other by naming it.
- What `sync` does with edits not yet in a version is open (ADR-0556).

## Considered alternatives

- **Every command in a group** (`folder check`, `folder sync`). Longer for the
  commands an agent runs most, and a group of one noun says nothing.
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

# 0558. The epicenter CLI groups only its app and auth commands

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) at "The CLI has no account or transfer commands": it has `auth`, `sync`, `connect`, `clone`, and `repos`. Every command that acts on a local folder still takes its path, and exit codes stay 0520's.
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) and [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the command name `epicenter login`, which is `epicenter auth login`. Their grants, clients, and `epicenter git-credential` are unchanged.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the CLI is Epicenter's only TypeScript outside a WebView, run by Rust with `--json`), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge `sync` uses), [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) (installing from a folder in a repository).
- **Unbuilt:** every command except `check`, `query`, and `generate` (`scripts/epicenter.ts`); `--json` on `generate`, which refuses it today (`scripts/epicenter.ts:392-396`); the `epicenter://open` deep link `open` uses.

## Context

`scripts/epicenter.ts` (404 lines) has three commands, `check <dir>`,
`query <dir> [<sql>]`, and `generate <dir>`, each taking a folder's path
(ADR-0520), with exit codes 0, 1 for a finding, and 2 for input the tool
cannot use. ADR-0520 says the CLI has no account or transfer commands.

Since then ADR-0546 and ADR-0549 named `epicenter login` and
`epicenter git-credential`, and ADR-0556 makes the CLI the program Rust runs
for auth, installing apps, and background sync. Each new command needs a
place, and an agent needs one contract for all of them.

## Decision

**Folder verbs sit at the top level and take a path; only `app` and `auth` are
groups.**

```txt
epicenter check <dir>                              existing (ADR-0520)
epicenter query <dir> [<sql>]                      existing (ADR-0520)
epicenter generate <dir>                           existing (ADR-0527)
epicenter sync <dir>                               fetch, merge by file kind (ADR-0551), commit, push
epicenter connect <dir> [--name <name>]            set remote.origin.url and make the first push (ADR-0546)
epicenter clone <namespace>/<name> | <url> [<dir>] clone into <dir>, default ~/Epicenter/<name>
epicenter repos                                    GET /api/repos: the caller's repositories
epicenter open <dir> [--app <id>]                  open it in Epicenter through epicenter://open

epicenter app list
epicenter app install <url> [--folder <path>]      ADR-0552: a folder within the repository
epicenter app update <id>
epicenter app approve <id>
epicenter app remove <id>

epicenter auth login [--loopback]
epicenter auth logout
epicenter auth status
epicenter auth token [--resource <url>]

epicenter git-credential get | store | erase
```

**No command takes a folder id for local work** (ADR-0520). `clone` and
`repos` name a repository, which is not local work.

**Every command takes `--json`.** With it, a short command prints one JSON
value on stdout; a long one (`sync`, `clone`, `app install`, `app update`)
prints NDJSON progress lines on stdout and ends with one result line. Without
it, stdout is for the answer. Stderr is for people in both modes. Exit codes
are ADR-0520's: 0 when the command did what it says, 1 for a finding a person
acts on (a file that does not conform, a merge left for review, an app waiting
for approval), and 2 for input the tool cannot use.

**`auth login` follows ADR-0549's two clients.** Without a flag it is the
device grant as `so.epicenter.cli`, for terminals and agents, as ADR-0546
says. With `--loopback` it is the desktop app's sign-in as `so.epicenter`:
authorization code with PKCE and `offline_access`, received on a one-shot
listener at `http://127.0.0.1:<port>/callback`; Settings' Sign in runs it,
and `--help` does not list it, since it is the app's client living in the
app's binary, not a second terminal flow.
Each grant's refresh token is its own keychain item. `auth token` and
`git-credential` refresh under one file lock in one implementation, and use
the desktop grant when this machine holds both.

**`git-credential` is Git's helper for `git.epicenter.so`**, configured as
`credential.https://git.epicenter.so.helper=!epicenter git-credential`. It
answers `get` with an access token for that audience and `password_expiry_utc`;
`store` and `erase` do nothing, since the token is minted, not stored.

**There is no daemon, and there is one binary.** Every command exits when its
work is done. The binary Epicenter bundles is the one on `PATH` (ADR-0556).

## Consequences

- An agent learns one shape: a verb and a path, `--json`, and three exit
  codes. `query <dir>` stays its first call in an unfamiliar repository.
- Folder verbs read as Git's do (`clone`, `sync`), so `epicenter sync .`
  works where `git pull` would.
- `app` and `auth` are grouped because they act on Epicenter on this machine,
  not on a folder.
- The CLI now writes folders and contacts the network, which ADR-0520's three
  commands never did; `check` and `query` still do neither.
- `sync` and an open app may write one folder at once; ADR-0556's save lock
  and ADR-0551's merges settle it.
- On a machine with both grants, `auth logout` signs out the one `auth
  status` names; a person signs out of the other by naming it.

## Considered alternatives

- **Every command in a group** (`folder check`, `folder sync`). Longer for the
  commands an agent runs most, and a group of one noun says nothing.
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

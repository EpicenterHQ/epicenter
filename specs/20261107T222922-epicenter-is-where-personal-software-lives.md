# Epicenter is where personal software lives

**Date**: 2026-11-07
**Status**: In Progress
**Owner**: Braden
**Branch**: claude/phase-2-machine
**Supersedes**: the folder sync product of ADR-0802 to ADR-0839, as current work (see ADR-0840)

## One Sentence

Each app is a folder whose `epicenter.ts` defines its actions; the `epicenter`
CLI turns every action into a command for the person and a tool for their
agent, and hands it a folder, a cache, and secrets.

## Why the direction changed

This session designed, in records 0802 to 0839, a folder sync product for many
people: a server keeping every version, Git at the edges, web and phone apps,
sharing. Asked what they will use in the next six months, the author said: only
them, rarely two computers in a week, nothing shared, a Mail app first, apps over
the vault, and agents able to use everything. None of that needs the sync
product. A council of three reviewers then found that the previous Mail (22k
lines, deleted in `280bdf4d44`) died of coupling to a platform layer, not of
Gmail, and that the planned apps do not share one shape. So Epicenter becomes
the smallest thing that serves one person and their agents. ADR-0840 records the
direction; ADR-0841 the app contract.

## Current shape

- `packages/cli`: the `epicenter` CLI. `operation.ts` renders one description
  (name, TypeBox input and output, lazily loaded code) as a command and an MCP
  tool; `parse.ts`, `output.ts`, `mcp.ts`, and `secrets.ts` are the parser, the
  stdout and exit-code rules, the MCP server, and the Keychain. Its commands
  today are the folder sync product's: folders, sync, sign-in, Messages.
- The waiting product (ADR-0840) is most of the repository, and nearly
  everything imports it: Whispering, `apps/api`, `packages/account`, `ai`,
  `svelte`, `recorder`, and the CLI. ADR-0843 says how it leaves.
- The author's tools are scripts in `~/Code/vault/scripts/` (calendar, photos,
  todoist), run by Claude.

## Target shape

```
~/Epicenter/                    the home: a plain directory, nothing generated
  mail/                         each app folder is its own Git repo
    epicenter.ts                export default defineApp({ name: 'mail', … })
    package.json, bun.lock      the app's own dependencies
    lib.ts                      shared code: functions that take a `folder`
    queries/receipts.txt        a saved Gmail search
    batches/                    reviewed changes; .gitignored
  reading/
    epicenter.ts
    2026.csv
  vault -> ~/Code/vault         an app elsewhere joins by a symlink
~/Code/vault/epicenter.ts       the vault's scripts as actions (after its defineFolder file is renamed)
~/Library/Caches/so.epicenter.apps/<name>/   rebuildable: mailbox copies, browser profiles
                                            (a folder run by path: <name>-<hash>/)
Keychain: epicenter.<name>                  sign-ins, shared by every copy of the app on this computer
```

The contract is ADR-0841: `defineApp({ name, description, actions })`; an action
is `{ description, input: { …fields }, run(input, { folder, cache, secrets }),
readOnly?, destructive? }`, keyed by one or more words (`'calendar show'`), where
`folder` and `cache` are objects (`read`, `write`, `list`, `remove`, bytes forms,
and `path` only on a computer) supplied by whatever runs the action.

```
epicenter [--json]                              apps, actions, input schemas, problems
epicenter <app> [--json]                        one app: actions, folder, cache path, Keychain service
epicenter <app> <action words> [<positional>] [--flags] [--json]
epicenter <path> <action words> …               a folder by path, such as a worktree
epicenter new <name> | add <source> | sync | mcp [<app>…] | help
```

## Packages

| Package | Holds | Precedent |
| --- | --- | --- |
| `@epicenter/app` | `defineApp`, `field`, the types. No Node or Bun APIs, so a page can import its types | Convex's `convex/server` (`query`, `mutation`, `action` with `args: { x: v.string() }`), Trigger.dev's `task({ run })`, Drizzle's split of `drizzle-orm` (definitions) from `drizzle-kit` (CLI) |
| `@epicenter/cli` | the `epicenter` binary: discovery, commands, `mcp`, later `serve` and `open` | `drizzle-kit`, `vite` |
| `@epicenter/mail` | Mail's default app, re-exported by `~/Epicenter/mail/epicenter.ts` | |

The unscoped `epicenter` name on npm is not ours; everything is under the
`@epicenter` scope.

`@epicenter/app` holds what an app author touches: `defineApp`, `field`, the
`Folder`, `Cache`, and `Secrets` types, and `createMemoryContext` for tests,
which is plain JavaScript. What needs a computer is the runner's and lives in
`@epicenter/cli`: the folder on disk, the cache directory and its SQLite, the
Keychain, Git. A notes library, when an app needs one, is new code that copies
the front-matter rule; `packages/definition` is not adapted (ADR-0843).

## Onboarding

1. **Install.** `bun add -g @epicenter/cli` gives `epicenter`.
2. **First run.** `epicenter` with no `~/Epicenter` offers to create it. Nothing
   else is generated, and Epicenter writes no instructions for agents.
3. **A new app.** `epicenter new reading` writes `reading/epicenter.ts` (with its
   `name`) and `package.json` from a template, and runs `git init`. Usually the
   person asks Claude instead; the app works at once because Bun runs
   TypeScript.
4. **Someone else's app.** `epicenter add github:someone/apps/vocab` copies the
   files the source tracks at one commit into a new repository at
   `~/Epicenter/vocab`, keeps that copy as the `upstream` branch, records
   `{ from, sha }` in its `package.json`, and runs `bun install`. A later version
   of the source is merged with `git merge upstream`. Then, for Mail,
   `epicenter mail connect` signs in.
5. **The vault.** It lives at `~/Epicenter/vault` on your Epicenter, with an
   `epicenter.ts` that declares `name: 'vault'`; `~/Code/vault` is a clone the
   author edits (ADR-0849). `epicenter vault …` then works from anywhere,
   including MCP.
6. **Agents.** Claude Code runs `epicenter` in the shell. Permission rules allow
   reading actions by command prefix (`Bash(epicenter mail search *)`) and ask on
   destructive ones; never allow `Bash(epicenter *)`. Claude Desktop and other
   chat apps add `epicenter mcp` to their MCP settings, or
   `ssh <your Epicenter> epicenter mcp` on another computer (ADR-0849).
7. **A second computer.** Clone each app's repo into `~/Epicenter`, run
   `bun install` in each, recreate links, and `connect` again where an app needs
   a sign-in. Caches fill on first use.

## Sync

ADR-0842. **The repository is the sync, and an action is a commit.** When an
action returns, what it changed becomes one commit named for the action, never
including paths the person had already edited; when it throws, its changes to
paths that were clean are undone. Exit codes: 0 ran, 1 a finding, 2 did not run,
3 ran and threw. Actions on one app take turns. The person
commits their own edits. `epicenter sync` pulls and pushes every app repository
and never commits; it says which apps have uncommitted changes. Files that only
grow are `merge=union` in the app's `.gitattributes`; other conflicts are Git's,
left as markers. Caches and secrets never sync. A computer uses any Git remote;
anything without Git reaches an app only through Epicenter Cloud, later.

## Mail, the first real app

The author's first two jobs: find receipts to reimburse a friend, and get the
inbox under control. Gmail's web app stays where mail is read and written.

```sh
epicenter mail connect                                   # loopback OAuth; refresh token in the Keychain
epicenter mail search 'receipt after:2026/09/01'         # live Gmail search
epicenter mail show <id> --attachments ~/Code/vault/…    # read one; save its files
epicenter mail plan newsletters --q 'category:promotions older_than:14d' --do archive
epicenter mail apply newsletters                         # the person runs this
```

- **A batch** (`batches/<name>.md`, gitignored) lists exact message ids, one
  action per line (`archive <id>  # sender: subject`), grouped under a heading
  per sender. The person deletes lines to keep mail. `apply` checks each id
  still exists, sends one `batchModify` per 1,000 ids, and marks the batch
  applied. A batch never re-runs its search, so mail that arrives after review
  is never swept in.
- **Saved queries** are `queries/<name>.txt`, one Gmail search each, tracked in
  Git.
- **No mailbox copy at first.** Gmail's quota (6,000 units a minute per user,
  20 per message fetch) makes a whole-mailbox copy take hours. An Inbox-only
  copy in `cache`, for SQL triage, comes when a question needs it.
- **Permissions.** Claude Code allows `epicenter mail search`, `show`, and `plan`;
  it asks on `apply`.
- **Code.** Salvage `gmail-client.ts`, `oauth.ts`, and `token-manager.ts` from
  `280bdf4d44^:apps/local-mail/src/` (they import no Yjs). Mail imports nothing
  from folder or sync code.
- **Its Google client** (ADR-0847). `mail connect` uses the client in Mail's
  `secrets`; Mail ships no default yet. The author's is the vault calendar's
  personal Google project (`GOOGLE_CALENDAR_CLIENT_ID` in Infisical's personal
  `/vault`; its refresh exchange works as of 2026-11-08), with the Gmail API
  enabled and `gmail.modify` added. Google issues 7-day refresh tokens to
  clients in "Testing", so the project must be "In production". An expired
  sign-in prints "run `epicenter mail connect`".

## Refused for now

A sync engine; schedules (ADR-0849); shared providers such as Google sign-in in core (ADR-0847);
sandboxing; validating schemas for folders (collections describe, ADR-0845); a
runner on the phone or in a browser. `epicenter serve`, the hub, your
Epicenter, and the phone as a client are no longer refused: ADR-0849 orders
them below.

## Later, without changing an action

- **Forms for free.** `epicenter open <app>` serves a page drawing a form for each
  action from its fields.
- **A custom UI.** Static pages served by `epicenter serve`, importing the app's
  type (`import type`) and calling actions over HTTP through a typed client. A
  page never imports `run`, which needs Bun and secrets.
- **Native power.** A page inside a Tauri window reaches Rust through capability
  packages that pick their implementation at run time (the platform-seams rule).
- **Remote agents.** Claude's connectors call from Anthropic's cloud, so this
  needs a public address (Tailscale Funnel or a relay) and a real sign-in.

## Open questions

1. Trash in Mail's first version: undoable for 30 days, but not forever.
2. Whether `undo <batch>` ships with `apply` or a week later.
3. Where `@epicenter/mail` lives while unpublished: in this monorepo, linked
   into `~/Epicenter` with `bun link`, or written directly in
   `~/Epicenter/mail/` until it is worth publishing.
4. The old product's folders in `~/Epicenter` (`Todos`, `Zhongwen`,
   `Zhongwen Dev`, `so.epicenter.*`, `local`, `on-this-device`) stay as a clean
   break: discovery ignores a folder without `epicenter.ts`. An app named like
   one of them, ignoring case, waits until that folder is moved.
5. `update` waits until the first copied app's source changes; until then,
   `git merge upstream`.

## Build order

ADR-0843 is the rule: new code imports nothing from the waiting product, which
leaves by deletion, one package at a time, once nothing imports it. Each wave
below is one or more commits, each passing `bun run typecheck` and the tests of
what it touches with no failure the commit before it did not have.

Waves 0 and 1 are done (2026-11-08). Next is wave 2, Mail.

**0. Tag and prune.** Tag `folder-sync-product` at the last commit with the old
product whole. Delete `apps/epicenter`, whose job (sync, sharing, history)
belongs to the waiting product, with its scripts, release workflows, and the
checks that name it. Vocab, Todos, Capture, Honeycrisp, and Messages stay,
frozen, until each is rebuilt (ADR-0843). Done when nothing outside `docs/` and
`specs/` names the desktop app, and `bun install`, `bun run typecheck`, and
`cargo check --workspace` pass.

**1. The kit.** Done when the `reading` example works end to end
(`epicenter reading log 30` writes and commits) and `epicenter mcp` serves it to
Claude Code.

- **1a. `packages/app`.** `defineApp`, `field`, the context types, and
  `createMemoryContext`, as ADR-0841 writes them. Type tests prove that `run`'s
  input is inferred from the fields, that a field without `optional` is
  required, and that an action's return value types its `--json`. A test runs
  an action against a memory folder. The import check ADR-0843 names starts
  here, over `packages/app`; 1b adds `packages/cli` to it.
- **1b. The CLI's core.** `packages/cli` is rewritten in place. Its folder,
  sync, git, server, sign-in, and Messages commands go, and with them its
  dependencies on the old product. Kept and changed: `parse.ts` learns that an
  app's action words are the command, a positional field, and repeated flags as
  arrays; `operation.ts` renders an action, not a platform operation; `mcp.ts`
  serves apps; `output.ts` takes exit code 3 and the error's `code` and `next`.
  New: discovery of the home (`EPICENTER_HOME`, else `~/Epicenter`), the
  listing and its problems, `epicenter <app>`, `epicenter <path> …`, and the
  context on a computer (the folder on disk, the cache directory and
  `sqlite(name)`, the Keychain under `epicenter.<name>`).
- **1c. Commits and sync.** The commit rule of ADR-0842 with tests against a
  temporary repository: dirty paths noted, a write to one refused, one commit
  after `run`, only clean paths undone after a throw, one action per app at a
  time. Then `epicenter sync` and `epicenter new`.

**2. Mail.** Salvage the Gmail client, OAuth, and token code from
`280bdf4d44^:apps/local-mail/src/`; build the commands in "Mail, the first real
app". Done when the receipts and newsletter jobs are finished with Mail and
Claude Code.

**3. Your Epicenter.** ADR-0849 in `packages/cli`: only `~/Epicenter` on your
Epicenter commits (runs of an app take turns; commit on return, discard on
throw, push to the backup remote); `epicenter ./<folder> <action>` runs as a
script anywhere and never commits; another computer forwards
`epicenter <app> <action>` and `epicenter mcp` over SSH; a push to your
Epicenter is a deploy, accepted as a fast-forward between runs. Then
`epicenter serve` (pages, HTTP, and MCP for a folder or for all of
`~/Epicenter`) and `epicenter setup`. Done when Claude on the laptop runs
`mail search` on the Mac through `ssh … epicenter mcp`, the phone runs a Mail
action from `serve`'s page, an agent's edit in a worktree is untouched by a Mail
action failing on the Mac, every commit reaches the backup remote, and remote
FileVault unlock over SSH has been tried.

**4. The vault.** The vault moves to `~/Epicenter/vault` on the Mac, with
GitHub as its backup remote; `~/Code/vault` becomes a clone the author edits.
Its scripts become actions in its `epicenter.ts`. Done when
`epicenter vault calendar show …` runs, which proves nested action words on a
real app. `epicenter add` comes when the first app is copied from a source.

**5. Vocab, then the hub.** Vocab's actions and collections, rebuilt from the
frozen app; then the hub: `epicenter serve`'s pages, an action view and a data
view over collections (ADR-0845), opened in a browser or a desktop window onto
that address (ADR-0849). The frozen Vocab leaves when the rebuilt one runs.

**6. Prune the rest.** In the order ADR-0843 gives: `apps/api` loses its folder
sync routes; `packages/account`, `ai`, `svelte`, and `recorder` cut their
imports; Whispering is untangled; then `packages/folder`, `server`,
`definition`, `local`, `tauri-plugin-epicenter-folder`, and
`tauri-epicenter-standalone` are deleted, each in its own commit. A frozen
app (Vocab, Todos, Capture, Honeycrisp, Messages) leaves when its rebuilt
successor runs, or when the author says it can go; it may hold the old packages
in the tree until then.

**7. Docs.** `docs/architecture.md`, `docs/CONTEXT.md`, and each affected
package README are rewritten as the code they describe goes. This spec is
deleted when waves 1 to 5 are done, its lasting parts already in ADR-0841,
ADR-0842, or the READMEs.

Done on 2026-11-07: the vault's `defineFolder` declaration moved from
`~/Code/vault/epicenter.ts` to `~/Code/vault/folder.ts`. Its `generate` command
was already gone from the CLI (`9e2e5fe5d7`), and the vault's `bun run epicenter`
script points at `../worktrees/epicenter-stable`, which no longer exists.

## Done when

Waves 1 to 5 are done:

- `epicenter` lists apps, actions, and problems from anywhere;
  `epicenter <app> <action words>` runs one with a positional, typed flags, and
  `--json`; exit codes and errors follow ADR-0842; `epicenter mcp` serves the
  same actions with `readOnly` and `destructive` hints.
- `reading` (a toy) and `mail` work end to end; the receipts and newsletter jobs
  are done with Mail and Claude Code.
- `epicenter vault calendar show …` runs the vault's calendar command on your
  Epicenter, from the laptop as well.
- The phone runs an action on your Epicenter, which commits it and pushes it to the backup.
- Vocab runs as an app with actions and collections, and the hub shows its
  actions as a palette and its words as a table.

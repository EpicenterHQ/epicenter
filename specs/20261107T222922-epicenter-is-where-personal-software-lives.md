# Epicenter is where personal software lives

**Date**: 2026-11-07
**Status**: In Progress
**Owner**: Braden
**Branch**: claude/phase-2-machine
**Supersedes**: the folder sync product of ADR-0802 to ADR-0839, as current work (see ADR-0840)

## One Sentence

An app is a folder with a declared shape: its `epicenter.json` (no code) or
`epicenter.ts` (with actions) declares collections, each of which gives `list`,
`show`, `save`, and `delete`, and the actions its author writes. Each job takes
the least powerful form that does it. `epicenter` runs an action in a folder and
makes one commit, or nothing. Your Epicenter is the computer where
`epicenter serve` always runs and your sign-ins live. A program with the folder
writes files and commits what it wrote; one without it asks for actions over MCP
(ADR-0849 to ADR-0857).

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

On your Epicenter (ADR-0849):

```
~/Epicenter/                    the only list of apps: folders, or links to them
  mail/                         each app is its own Git repo, with one remote, origin
    epicenter.ts                export default defineApp({ name: 'mail', … }): it has actions
    package.json, bun.lock      its own dependencies and editor types; not needed for @epicenter/app
    .gitignore                  node_modules/, .cache/
    .gitattributes              binaries through LFS (ADR-0856)
    lib.ts                      shared code: functions that take a `folder`
    queries/receipts.txt        a saved Gmail search
    batches/                    reviewed changes; gitignored
    .cache/                     rebuildable: mailbox copies, browser profiles
  reading/
    epicenter.ts
    2026.csv
  reminders/                    an ordinary app from the registry (ADR-0855)
  whispering/                   epicenter.json only: Whispering writes it (ADR-0853)
  vault -> ~/Code/vault         an app elsewhere, linked by epicenter add
Keychain: epicenter.<name>      sign-ins, on your Epicenter only
epicenter serve                 the only way in: MCP, on the tailnet
```

The contract is ADR-0841 with ADR-0853, ADR-0854, and ADR-0857. The
declaration is plain data, `{ name, description, collections, actions }`, in
`epicenter.json` or as `epicenter.ts`'s default export; a collection is
`{ path, fields, readOnly? }` and gives `list`, `show`, `save`, and `delete`; an
action is `{ description, input: { …fields }, run(input, { folder, secrets }),
readOnly?, destructive? }`, keyed by one or more words (`'calendar show'`); a
field is `'text'`, `'number?'`, `['new', 'known']`, or a long form with options;
`folder` is an object (`read`, `write`, `list`, `delete`, bytes forms, and
`path` only on a computer) supplied by whatever runs the action.

```
epicenter [--json]                              apps, actions, input schemas, problems
epicenter <app> [--json]                        one app: collections, actions, folder, Keychain service
epicenter <app> <action words> [<positional>] [--flags] [--json]
epicenter <path> <action words> …               a folder by path, such as a worktree
epicenter setup | serve [--stdio] | new <name> | add <source or folder> | help
```

## Packages

| Package | Holds | Precedent |
| --- | --- | --- |
| `@epicenter/app` | the declaration's TypeBox schema (the source of `epicenter.schema.json`), `defineApp`, the types, and the typed MCP client. No Node or Bun APIs, so a page can import it | Convex's `convex/server` (`query`, `mutation`, `action` with `args: { x: v.string() }`), Trigger.dev's `task({ run })`, Drizzle's split of `drizzle-orm` (definitions) from `drizzle-kit` (CLI) |
| `@epicenter/cli` | the `epicenter` binary: discovery, commands, `serve` (MCP over HTTP or stdio), `setup`, `add` | `drizzle-kit`, `vite` |
| `@epicenter/mail` | Mail's default app, re-exported by `~/Epicenter/mail/epicenter.ts` | |

The unscoped `epicenter` name on npm is not ours; everything is under the
`@epicenter` scope.

`@epicenter/app` holds what an app author touches: the declaration's schema,
`defineApp`, the `Folder` and `Secrets` types, `createMemoryContext` for tests,
and `connect` for pages, all plain JavaScript. What needs a computer is
`epicenter`'s and lives in `@epicenter/cli`: the folder on disk, the Keychain,
Git. A notes library, when an app needs one, is new code that copies
the front-matter rule; `packages/definition` is not adapted (ADR-0843).

## Onboarding

1. **Install.** `bun add -g @epicenter/cli` gives `epicenter`.
2. **First run.** `epicenter` with no `~/Epicenter` offers to create it. Nothing
   else is generated, and Epicenter writes no instructions for agents.
3. **A new app.** `epicenter new reading` writes `reading/epicenter.json` (with
   its `$schema` and `name`), `.gitignore`, and `.gitattributes` from a template,
   and runs `git init`. Its first action renames the file to `epicenter.ts`.
   Usually the person asks Claude instead; the app works at once because Bun
   runs TypeScript.
4. **Someone else's app.** `epicenter add github:someone/apps/vocab` copies the
   files the source tracks at one commit into a new repository at
   `~/Epicenter/vocab`, keeps that copy as the `upstream` branch, and runs
   `bun install` if it has a `package.json`. A later version
   of the source is merged with `git merge upstream`. Then, for Mail,
   `epicenter mail connect` signs in.
5. **The vault.** Rename its `defineFolder` file, add an `epicenter.ts` that
   declares `name: 'vault'`, and `epicenter add ~/Code/vault`, which links it;
   `epicenter vault …` then works from anywhere, including MCP.
6. **Agents.** Claude Code runs `epicenter` in the shell. Permission rules allow
   reading actions by command prefix (`Bash(epicenter mail search *)`) and ask on
   destructive ones; never allow `Bash(epicenter *)`. Claude Desktop and other
   chat apps add `epicenter serve --stdio` to their MCP settings on your
   Epicenter, or `serve`'s MCP address on another computer (ADR-0849).
7. **A second computer.** Clone each app's repo into `~/Epicenter`, run
   `bun install` in each, recreate links, and `connect` again where an app needs
   a sign-in. Caches fill on first use.

## Sync

ADR-0842, as ADR-0850 and ADR-0851 amend it. **The repository is the sync, and
running an action makes one commit, or nothing.** An action's writes are held until it
returns, then committed with `--only`; one that throws writes nothing, and one
that would write a path the person has edited fails without writing. Exit
codes: 0 ran, 1 a finding, 2 did not run, 3 ran and threw. Runs of one app take
turns. The person commits their own edits. Each app has one remote, `origin`;
`epicenter` pushes after each commit when the branch tracks a remote, your
Epicenter also pulls before a run, and everyone else uses Git. Binary files go
through Git LFS (ADR-0856).
Files that only grow are `merge=union` in the app's `.gitattributes`; other
conflicts are Git's, left as markers. `.cache/` and secrets never sync.
Anything without the folder asks for actions through `serve`.

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
  copy in `.cache/`, for SQL triage, comes when a question needs it.
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

A sync engine; schedules, with reminders as an app instead (ADR-0849, ADR-0855); shared providers such as Google sign-in in core (ADR-0847);
sandboxing; validating schemas for folders (collections describe, ADR-0845); running
actions on the phone or in a browser. `epicenter serve`, the hub, your
Epicenter, and the phone as a client are no longer refused: ADR-0849 orders
them below.

## Later, without changing an action

- **A custom UI.** A page importing the app's type (`import type`) and calling
  actions over MCP through the typed client in `@epicenter/app` (ADR-0853). A
  page never imports `run`, which needs Bun and secrets.
- **Native power.** A page inside a Tauri window reaches Rust through capability
  packages that pick their implementation at run time (the platform-seams rule).
- **Remote agents.** Claude's connectors call from Anthropic's cloud, so this
  needs a public address (Tailscale Funnel or a relay) and a real sign-in.
- **Epicenter Cloud's LFS.** `https://api.epicenter.so/lfs/<repository>` in
  `apps/api`, answering Git LFS's batch API with signed R2 links, named by the
  `.lfsconfig` Epicenter Cloud commits (ADR-0856).
- **WebAssembly actions, or a Rust core** (ADR-0852): when apps from strangers
  run with a person's sign-ins, or when a second program wants to embed
  collections, Git, and MCP.

## Open questions

1. Trash in Mail's first version: undoable for 30 days, but not forever.
2. Whether `undo <batch>` ships with `apply` or a week later.
3. Where `@epicenter/mail` lives while unpublished: in this monorepo, linked
   into `~/Epicenter` with `bun link`, or written directly in
   `~/Epicenter/mail/` until it is worth publishing.
4. The old product's folders in `~/Epicenter` (`Todos`, `Zhongwen`,
   `Zhongwen Dev`, `so.epicenter.*`, `local`, `on-this-device`) stay as a clean
   break: discovery ignores a folder without `epicenter.json` or
   `epicenter.ts`. An app named like
   one of them, ignoring case, waits until that folder is moved.
5. `update` waits until the first copied app's source changes; until then,
   `git merge upstream`.

## Build order

ADR-0843 is the rule: new code imports nothing from the waiting product, which
leaves by deletion, one package at a time, once nothing imports it. Each wave
below is one or more commits, each passing `bun run typecheck` and the tests of
what it touches with no failure the commit before it did not have.

Waves 0 and 1 are done (2026-11-08). Next is 1d, the declaration as data,
then wave 2, Mail.

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
- **1d. The declaration as data** (ADR-0857). In `packages/app`: the
  declaration's TypeBox schema and its published `epicenter.schema.json`; fields
  in the short and long forms, replacing `field`; `defineApp` inferring inputs
  from them through a `const` type parameter, with type tests for `'number'`,
  `'text?'`, and a select; `folder.delete` for `remove`. In `packages/cli`:
  discovery of `epicenter.json` beside `epicenter.ts` (both is a problem), the
  check against the schema, `@epicenter/app` supplied to an app with no
  `node_modules`, and `epicenter mcp` becoming `epicenter serve --stdio`. The
  `reading` example in the short form. Done when `reading` runs unchanged in
  behavior, a code-free `epicenter.json` app lists and shows its collection,
  and Claude Code reaches both through `epicenter serve --stdio`.

**2. Mail.** Salvage the Gmail client, OAuth, and token code from
`280bdf4d44^:apps/local-mail/src/`; build the commands in "Mail, the first real
app". Done when the receipts and newsletter jobs are finished with Mail and
Claude Code.

**3. Your Epicenter.** In `packages/app` and `packages/cli`: an action's writes
held until `run` returns, then written and committed with `--only` (ADR-0850);
`cache` replaced by `.cache/` in the folder (ADR-0854); `epicenter sync`
deleted and `new` made `add` from a template (ADR-0851, ADR-0852). Then
`epicenter serve` (MCP) as the only way in, `epicenter setup` (checking `git`
and `git-lfs`), the CLI forwarding named actions to `serve` as tool calls, a
push after every commit and a pull before a run on your Epicenter, the
template's `.gitattributes` and the LFS check before committing, and
`epicenter` supplying `@epicenter/app` (ADR-0849 to ADR-0852, ADR-0856). Done when Claude
on the laptop runs `mail search` on the Mac through `serve`'s MCP address, an
agent's edit is untouched by a Mail action
failing in the same folder, a race of 1,000 runs against an agent's commits
loses nothing, every commit reaches the app's remote, and remote FileVault
unlock over SSH has been tried.

**4. The vault.** The vault's scripts become actions in
`~/Code/vault/epicenter.ts`, linked as `~/Epicenter/vault`; GitHub stays its
remote. Done when
`epicenter vault calendar show …` runs, which proves nested action words on a
real app. `epicenter add` comes when the first app is copied from a source.

**5. Vocab, then the hub.** A collection's `list`, `show`, `save`, and `delete`
in `packages/app` and `packages/cli` (ADR-0853); Vocab's actions and
collections, rebuilt from the frozen app; then the typed MCP client in
`@epicenter/app` and the Epicenter app, which asks `epicenter serve` through it
and shows collections as tables, `save` and actions as forms, in a browser or a
desktop window (ADR-0853). Then a date-time field, the
Reminders app, and the Epicenter app running what is due when it opens
(ADR-0855). The frozen Vocab leaves when the rebuilt one runs.

**6. Prune the rest.** In the order ADR-0843 gives: `apps/api` loses its folder
sync routes; `packages/account`, `ai`, `svelte`, and `recorder` cut their
imports; Whispering is untangled: its contract becomes an `epicenter.ts` of
collections that it writes into its folder, its desktop app writes files and
commits and pushes what it wrote with the installed `git`, and its web variant
leaves with the waiting product (ADR-0853); then `packages/folder`, `server`,
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
- `epicenter vault calendar show …` runs the vault's calendar command through the
  `~/Epicenter/vault` link, from the laptop as well.
- The phone runs an action on your Epicenter, which commits it and pushes it to the app's remote.
- Vocab runs as an app with actions and collections, and the Epicenter app
  shows its words as a table, edits one with `save`, and runs its actions as
  forms.
- A reminder whose time has passed runs once when the Epicenter app opens, even
  with the phone and laptop opening together.

# Epicenter is where personal software lives

**Date**: 2026-11-07
**Status**: In Progress
**Owner**: Braden
**Branch**: claude/phase-2-machine
**Supersedes**: the folder sync product of ADR-0802 to ADR-0839, as current work (see ADR-0840)

## One Sentence

An app is a folder: `epicenter.json` says what its files are, and
`epicenter.ts`, if present, says what you can do. Every writer commits exactly
what it wrote. `epicenter` runs actions, and your Epicenter runs them through
`serve` for anything without the folder. Git moves everything, `epicenter` never
merges, and each job takes the least powerful form (ADR-0849 to ADR-0857;
[docs/vision.md](../docs/vision.md)).

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
direction; ADR-0841 the app contract. A second independent review, on
2026-11-08 before anything past wave 1 was built, agreed the design recorded in
ADR-0849 to ADR-0857.

## Current shape

- `packages/app` (`@epicenter/app`): `defineApp({ name, description, actions })`,
  TypeBox-based `field` helpers, the context `{ folder, cache, secrets }`, and
  `createMemoryContext`, as ADR-0841 wrote them.
- `packages/cli` (`@epicenter/cli`, binary `epicenter`): discovery of
  `~/Epicenter` (or `EPICENTER_HOME`), the listing and its problems, running an
  action by app name or folder path, the commit rule of ADR-0842 (writes as the
  action runs, refuses paths with uncommitted edits, commits with `--only`,
  undoes changed paths after a throw), `epicenter mcp` over stdio, `new`, `sync`,
  and sign-ins in the Keychain. The `reading` example runs end to end.
- The waiting product (ADR-0840) is most of the repository: Whispering,
  `apps/api`, `packages/account`, `ai`, `svelte`, `recorder`, and the frozen
  apps. ADR-0843 says how it leaves.
- The author's tools are scripts in `~/Code/vault/scripts/` (calendar, photos,
  todoist, clips, memory search), run by Claude.

## Target shape

On your Epicenter (ADR-0849):

```
~/Epicenter/                    the only list of apps: folders, or links to them
  mail/                         its own Git repo, with one remote, origin
    epicenter.json              name, description, collections
    epicenter.ts                defineApp(declaration, { actions })
    epicenter.d.json.ts         generated from epicenter.json; gitignored
    package.json, tsconfig.json its own dependencies, and types in an editor
    .gitignore                  node_modules/, .cache/, epicenter.d.json.ts, batches/
    .gitattributes              binaries through LFS (ADR-0856)
    lib.ts                      shared code: functions that take a `folder`
    queries/receipts.txt        a saved Gmail search
    batches/                    reviewed changes, each message marked as applied
    .cache/                     rebuildable: mailbox copies
  reading/
    epicenter.json
    epicenter.ts
    2026.csv
  whispering/                   Whispering writes epicenter.json and its takes
  vault -> ~/Code/vault         linked by epicenter add
Keychain: epicenter.<name>      sign-ins, on your Epicenter only
epicenter serve                 the only way in: MCP, on the tailnet
```

The contract is ADR-0841 as ADR-0853, ADR-0854, and ADR-0857 amend it.
`epicenter.json` is `{ $schema, name, description, collections }`; `epicenter.ts`
is `defineApp(declaration, { collections?, actions })`, with `declaration`
imported from `./epicenter.json`. A collection is `{ path, fields }`, where
`fields` is JSON Schema. An action is `{ description, input, positional?,
annotations?, run(input, { folder, secrets, collections }) }`, keyed by one or
more words (`'calendar show'`); `input` is a map of `field` helpers that becomes
its MCP `inputSchema`, and `annotations` are MCP's. `folder` offers `read`,
`write`, `list`, `delete`, bytes forms, and `path` on a computer;
`collections.<name>` offers `list`, `show`, `save`, and `delete`.

```
epicenter [--json]                              apps, actions, input schemas, problems
epicenter <app> [--json]                        one app: collections, actions, folder, Keychain service
epicenter <app> <action words> [<positional>…] [--flags] [--json]
epicenter <path> <action words> …               a folder by path, such as a worktree
epicenter setup | serve [--stdio] | new <name> | add <url or folder> | types | help
```

## Packages

| Package | Holds | Precedent |
| --- | --- | --- |
| `@epicenter/app` | the declaration's TypeBox schema (the source of `epicenter.schema.json`), `defineApp`, `field`, the types, `createMemoryContext`, and the typed MCP client at `@epicenter/app/client`. No Node or Bun APIs, so a page can import it | Convex's `convex/server` and `convex/browser`, Trigger.dev's `task({ run })`, Astro's content collections (typed from declared schemas) |
| `@epicenter/cli` | the `epicenter` binary: discovery, commands, `serve` (MCP over HTTP or stdio), `setup`, `new`, `add`, `types` | `drizzle-kit`, `vite` |

The unscoped `epicenter` name on npm is not ours; everything is under the
`@epicenter` scope. An app is shared by its Git URL, never as a package. What
needs a computer is `epicenter`'s: the folder on disk, the Keychain, Git. A notes
library, when an app needs one, is new code that copies the front-matter rule;
`packages/definition` is not adapted (ADR-0843).

## Onboarding

1. **Install.** `bun add -g @epicenter/cli` gives `epicenter`; `epicenter setup`
   checks for `git` and `git-lfs`, and on the Mac makes it your Epicenter.
2. **A new app.** `epicenter new reading` writes `reading/epicenter.json` (with
   its `$schema` and `name`), `.gitignore`, and `.gitattributes`, and runs
   `git init`. Its first action adds `epicenter.ts`, `package.json`, and
   `tsconfig.json`. Usually the person asks Claude instead; the app works at once
   because Bun runs TypeScript.
3. **Someone else's app.** `epicenter add github:someone/apps/vocab` copies the
   files the source tracks at one commit into a new repository at
   `~/Epicenter/vocab`, keeps that copy as the `upstream` branch, and runs
   `bun install` if it has a `package.json`. A later version of the source is
   merged with `git merge upstream`. For Mail, `epicenter mail connect` signs in.
4. **The vault.** Rename its `defineFolder` file, add `epicenter.json` and
   `epicenter.ts`, and run `epicenter add ~/Code/vault`, which links it;
   `epicenter vault …` then works from anywhere on the tailnet.
5. **Agents.** Claude Code runs `epicenter` in the shell. Permission rules allow
   reading actions by command prefix (`Bash(epicenter mail search *)`) and ask on
   destructive ones; never allow `Bash(epicenter *)`. Claude Desktop adds
   `epicenter serve --stdio` to its MCP settings. Claude and ChatGPT on the phone
   do not reach apps until `serve` has a public address (ADR-0849).
6. **A second computer.** `epicenter setup` connects it to your Epicenter. Clones
   of apps for editing are ordinary Git clones.

## Writing and moving data

ADR-0850 and ADR-0851. **Every writer commits exactly what it wrote.** An action
writes as it runs and is refused a path with uncommitted edits; when it ends,
returned or thrown, `epicenter` commits the paths that still hold what it wrote,
and the message says the outcome. Exit codes: 0 ran, 1 a finding, 2 did not run,
3 ran and threw. Runs of one app take turns. The person commits their own edits.
Each app with history has one remote, `origin`; `epicenter` pushes fast-forward
only after each commit and never pulls or merges; the listing says when a copy is
behind. Binary files a folder tracks go through Git LFS (ADR-0856). Files that
only grow are `merge=union` in the app's `.gitattributes`; other conflicts are
Git's, left as markers. `.cache/` and secrets never sync. Anything without the
folder asks for actions through `serve`.

## Mail, the first real app

The author's first two jobs: find receipts to reimburse a friend, and get the
inbox under control. Gmail's web app stays where mail is read and written. Mail
is written directly in `~/Epicenter/mail/`.

```sh
epicenter mail connect                                   # loopback OAuth; refresh token in the Keychain
epicenter mail search 'receipt after:2026/09/01'         # live Gmail search
epicenter mail show <id> --attachments ~/Code/vault/…    # read one; save its files
epicenter mail plan newsletters --q 'category:promotions older_than:14d' --do archive
epicenter mail apply newsletters                         # the person runs this
```

- **A batch** (`batches/<name>.md`, gitignored, because it lists other people's
  names and subjects) lists exact message ids, one action per line
  (`archive <id>  # sender: subject`), grouped under a heading per sender. The
  person deletes lines to keep mail. `apply` checks each id still exists, sends
  one `batchModify` per 1,000 ids, and marks each line applied as it goes, so a
  run that fails partway shows what it did. A batch never re-runs its search, so
  mail that arrives after review is never swept in.
- **Saved queries** are `queries/<name>.txt`, one Gmail search each, tracked in
  Git.
- **Attachments saved into the vault** are written by `epicenter` on Mail's
  behalf into another folder, and stay uncommitted there for the person.
- **No mailbox copy at first.** Gmail's quota (6,000 units a minute per user,
  20 per message fetch) makes a whole-mailbox copy take hours. An Inbox-only
  copy in `.cache/`, for SQL triage, comes when a question needs it.
- **Permissions.** Claude Code allows `epicenter mail search`, `show`, and `plan`;
  it asks on `apply`. `apply` declares `destructiveHint: false`; it archives,
  which Gmail undoes.
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

A sync engine; schedules (ADR-0849); merging by `epicenter` (ADR-0851); shared
providers such as Google sign-in in core (ADR-0847); sandboxing; refusing hand
edits that do not fit a collection (ADR-0845); running actions on the phone or in
a browser; a schema language of Epicenter's own (ADR-0857); programs that ship
`epicenter` (ADR-0853).

## Later, each when something needs it

- **Reach from the phone and claude.ai** (ADR-0849): `serve` at a public HTTPS
  address with a sign-in and a per-action allow-or-ask policy, when the author
  wants an app on the phone.
- **Collections' four actions, handles in `run`, the typed client, and the
  Epicenter app** (ADR-0853): with Vocab.
- **Reminders**, as an ordinary app, if a real job needs one.
- **Epicenter Cloud**, with its LFS on R2 (ADR-0856) after a partial-clone check,
  and the registry: with the first person who cannot keep a computer on.
- **Rewriting the vault's history into LFS**: the author's choice, after
  measuring its media and the quota it would use.
- **Read-only collections, collections of uploaded files, two-placeholder
  paths**: with the first app that needs one.
- **Native power.** A page inside a Tauri window reaches Rust through capability
  packages that pick their implementation at run time (the platform-seams rule).
- **WebAssembly actions, or a Rust core** (ADR-0852): when apps from strangers
  run with a person's sign-ins, or when a second program wants to embed
  collections, Git, and MCP.

## Open questions

1. Trash in Mail's first version: undoable for 30 days, but not forever.
2. Whether `undo <batch>` ships with `apply` or a week later.
3. The old product's folders in `~/Epicenter` (`Todos`, `Zhongwen`,
   `Zhongwen Dev`, `so.epicenter.*`, `local`, `on-this-device`) stay as a clean
   break: discovery ignores a folder without `epicenter.json`. An app named like
   one of them, ignoring case, waits until that folder is moved.
4. `update` waits until the first copied app's source changes; until then,
   `git merge upstream`.

## Build order

ADR-0843 is the rule: new code imports nothing from the waiting product, which
leaves by deletion, one package at a time, once nothing imports it. Each wave
below is one or more commits, each passing `bun run typecheck` and the tests of
what it touches with no failure the commit before it did not have.

Waves 0, 1, and 2a are done (2a on 2026-11-09). Next is 2b, the commit rule,
then Mail.

**0. Tag and prune.** Done. Tagged `folder-sync-product`; `apps/epicenter`
deleted; the frozen apps stay until each is rebuilt (ADR-0843).

**1. The kit.** Done. `packages/app` (1a), the CLI's core (1b), and commits and
sync (1c) as ADR-0841 and ADR-0842 wrote them; `epicenter reading log 30` writes
and commits, and `epicenter mcp` serves it to Claude Code.

**2. Mail.**

- **2a. The declaration** (ADR-0857). Done, except reaching `reading` from
  Claude Code itself, which needs the author's machine; acceptance D1 to D7
  run the same path black-box. In `packages/app`: the declaration's TypeBox
  schema and `epicenter.schema.json`; `defineApp(declaration, { collections?,
  actions })` taking its name and description from `epicenter.json`; `positional`
  and `annotations` on the action; `folder.delete` for `remove`. In
  `packages/cli`: loading `epicenter.json` and merging it with `epicenter.ts`,
  the listing's problems for anything declared twice, the check against the
  schema, writing `epicenter.d.json.ts` on load and with `epicenter types`,
  `@epicenter/app` supplied to an app with no `node_modules`, `epicenter mcp`
  becoming `epicenter serve --stdio`, and `EPICENTER_HOME` removed (tests set
  `HOME`). `reading` gains an `epicenter.json`. Done when `reading` runs as
  before, a folder with only `epicenter.json` is listed, a type test shows
  `epicenter.d.json.ts` narrowing the import, and Claude Code reaches `reading`
  through `epicenter serve --stdio`.
- **2b. The commit rule** (ADR-0850). The undo after a throw goes; what an action
  wrote is committed whatever happens, labelled with the outcome; a path that
  changed after the action wrote it is left uncommitted and named. Done when a
  throwing action leaves a labelled commit, an agent's edit made during a run
  stays uncommitted and named, and a race of 1,000 runs against an agent's
  commits and edits loses or misfiles nothing.
- **2c. Mail.** Salvage the Gmail client, OAuth, and token code from
  `280bdf4d44^:apps/local-mail/src/`; build the commands in "Mail, the first real
  app" in `~/Epicenter/mail/`. Done when the receipts and newsletter jobs are
  finished with Mail and Claude Code.

**3. Your Epicenter** (ADR-0849, ADR-0851, ADR-0852, ADR-0854, ADR-0856). `cache`
replaced by `.cache/` in the folder; `epicenter sync` deleted; a fast-forward
push after each commit and "behind origin" in the listing; `new` from a template
and `add` from a URL or a folder; `epicenter serve` over HTTP on the tailnet,
running each call in a fresh process; `epicenter setup`; the CLI and
`serve --stdio` forwarding named actions to your Epicenter; the template's
`.gitattributes` and the refusal to commit an LFS path without `git-lfs`. Done
when Claude Desktop on the laptop runs `mail search` on the Mac, every commit
reaches its `origin`, and remote FileVault unlock over SSH has been tried.

**4. The vault.** `epicenter add ~/Code/vault`; an `epicenter.json` and a
`.gitattributes`; its scripts become actions in `~/Code/vault/epicenter.ts`, with
the scripts' writes to tracked files moved onto `folder` and their ignored
mirrors (`.calendar/`, `.todoist/`, `.photos/`) left as they are. Done when
`epicenter vault calendar show …` runs from the laptop.

**5. Vocab and collections** (ADR-0853). The four collection actions, the
handles in `run`, the typed client, and the Epicenter app, which shows
collections as tables and `save` and actions as forms in a browser or a desktop
window; Vocab rebuilt on them. The frozen Vocab leaves when the rebuilt one runs.

**6. Prune the rest.** In the order ADR-0843 gives: `apps/api` loses its folder
sync routes; `packages/account`, `ai`, `svelte`, and `recorder` cut their
imports; Whispering is untangled: its contract becomes the `epicenter.json` it
owns, its desktop app writes and commits its takes with the installed `git`,
pulls with `--rebase` and pushes on launch and when the network returns (skipping
the pull, and saying so, when the folder has uncommitted edits), and its web
variant leaves with the waiting product (ADR-0853); then `packages/folder`,
`server`, `definition`, `local`, `tauri-plugin-epicenter-folder`, and
`tauri-epicenter-standalone` are deleted, each in its own commit. A frozen app
(Vocab, Todos, Capture, Honeycrisp, Messages) leaves when its rebuilt successor
runs, or when the author says it can go.

**7. Docs.** `docs/architecture.md`, `docs/CONTEXT.md`, and each affected
package README are rewritten as the code they describe goes. This spec is
deleted when waves 2 to 5 are done, its lasting parts already in the ADRs, the
READMEs, and `docs/vision.md`.

Done on 2026-11-07: the vault's `defineFolder` declaration moved from
`~/Code/vault/epicenter.ts` to `~/Code/vault/folder.ts`. Its `generate` command
was already gone from the CLI (`9e2e5fe5d7`), and the vault's `bun run epicenter`
script points at `../worktrees/epicenter-stable`, which no longer exists.

## Done when

Waves 2 to 5 are done:

- `epicenter` lists apps, actions, and problems from anywhere;
  `epicenter <app> <action words>` runs one with positionals, typed flags, and
  `--json`; exit codes and errors follow ADR-0842; `epicenter serve` offers the
  same actions over MCP with their annotations.
- `reading` (a toy) and `mail` work end to end; the receipts and newsletter jobs
  are done with Mail and Claude Code.
- `epicenter vault calendar show …` runs the vault's calendar command from the
  laptop.
- Vocab runs as an app with collections and actions, and the Epicenter app shows
  its words as a table, edits one with `save`, and runs its actions as forms.

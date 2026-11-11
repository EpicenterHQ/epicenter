# Epicenter is where personal software lives

**Date**: 2026-11-07
**Status**: In Progress
**Owner**: Braden
**Branch**: claude/phase-2-machine
**Supersedes**: the folder sync product of ADR-0802 to ADR-0839, as current work (see ADR-0840)

## One Sentence

An app is a folder: `epicenter.json` says what its files are, and
`epicenter.ts`, if present, says what you can do. Every writer commits exactly
what it wrote. `epicenter` runs actions, and your server runs them through
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

On your server (ADR-0849):

```
~/Epicenter/                    the only list of apps: folders, or links to them
  mail/                         its own Git repo, with one remote, origin
    epicenter.json              name, description, collections
    epicenter.ts                exported actions and groups, from epicenter:app
    tsconfig.json               one line, extending .cache/epicenter/tsconfig.json
    package.json                only for dependencies of its own
    .gitignore                  node_modules/, .cache/, *.local, *.local.* (ADR-0858)
    .gitattributes              binaries through LFS (ADR-0856)
    lib.ts                      shared code: functions that take a `folder`
    attachments/<id>/           files saved from a message, through LFS
    batches/*.local.md          ids to act on, reviewed, kept on this computer
    .cache/epicenter/           generated types for epicenter:app
    .cache/                     rebuildable: mailbox copies
  reading/
    epicenter.json
    epicenter.ts
    2026.csv
  whispering/                   Whispering writes epicenter.json and its takes
  vault -> ~/Code/vault         linked by epicenter add
Keychain: epicenter.<name>      sign-ins, on your server only
epicenter serve                 the only way in: MCP, on the tailnet
```

The contract is ADR-0841 as ADR-0853, ADR-0854, and ADR-0857 amend it.
`epicenter.json` is `{ $schema, name, description, collections }`. Every export
of `epicenter.ts` is an action (`export const review = action({…})`) or a group
of them (`export const calendar = { show: action({…}) }`), imported from
`epicenter:app`, the app's own module generated into `.cache/epicenter/`. A
collection is `{ path, fields }`, where `fields` is JSON Schema, and gives a
group of four actions that `epicenter.ts`'s exports lay over. An action is
`{ description, input, annotations?, run(input, { collections, folder, secrets })
}`; `input` is a map of `field` helpers that becomes its MCP `inputSchema`, its
first required field is read by position, and `annotations` are MCP's. `folder`
offers `list`, `get`, `getBytes`, `set` (text or bytes), `delete`, `commit`, and
`path`; `collections.<name>` offers `list`, `get`, `set`, and `delete`.

```
epicenter [--json]                              apps, actions, input schemas, problems
epicenter <app> [--json]                        one app: collections, actions, folder, Keychain service
epicenter <app> [<group>] <action> [<first required>] [--flags] [--json]
epicenter <path> [<group>] <action> …           a folder by path, such as a worktree
epicenter new <name> | add <url or folder> | sync [<app>] | serve [--stdio]
```

## Packages

| Package | Holds | Precedent |
| --- | --- | --- |
| `@epicenter/app` | the declaration's TypeBox schema (the source of `epicenter.schema.json`), `field`, the types, `createMemoryContext`, and the typed MCP client at `@epicenter/app/client`. No Node or Bun APIs, so a page can import it | Convex's `convex/server` and `convex/browser`, Trigger.dev's `task({ run })`, Astro's content collections (typed from declared schemas) |
| `@epicenter/cli` | the `epicenter` binary: discovery, commands, `serve` (MCP over HTTP or stdio), `new`, `add`, `sync`, and the generator and Bun plugin for `epicenter:app` | `drizzle-kit`, `vite` |

The unscoped `epicenter` name on npm is not ours; everything is under the
`@epicenter` scope. An app is shared by its Git URL, never as a package. What
needs a computer is `epicenter`'s: the folder on disk, the Keychain, Git. A notes
library, when an app needs one, is new code that copies the front-matter rule;
`packages/definition` is not adapted (ADR-0843).

## Onboarding

1. **Install.** `bun add -g @epicenter/cli` gives `epicenter`; `epicenter setup`
   checks for `git` and `git-lfs`, and on the Mac makes it your server.
2. **A new app.** `epicenter new reading` writes `reading/epicenter.json` (with
   its `$schema` and `name`), `.gitignore`, and `.gitattributes`, and runs
   `git init`. Its first action adds `epicenter.ts`, `package.json`, and
   `tsconfig.json`. Usually the person asks Claude instead; the app works at once
   because Bun runs TypeScript.
3. **An app from the Epicenter repository.** `bun epicenter/install.ts capture`
   copies `epicenter/capture`'s `epicenter.json` and `epicenter.ts` into
   `~/Epicenter/capture`, commits them, and builds its view into the ignored
   `views/` (ADR-0864). There is no `upstream` and no catalog. For Mail,
   `epicenter mail connect` signs in.
4. **The vault.** Rename its `defineFolder` file, add `epicenter.json` and
   `epicenter.ts`, and run `epicenter add ~/Code/vault`, which links it;
   `epicenter vault …` then works from anywhere on the tailnet.
5. **Agents.** Claude Code runs `epicenter` in the shell. Permission rules allow
   reading actions by command prefix (`Bash(epicenter mail search *)`) and ask on
   destructive ones; never allow `Bash(epicenter *)`. Claude Desktop adds
   `epicenter serve --stdio` to its MCP settings. Claude and ChatGPT on the phone
   reach apps as connectors through `serve`'s public address, approved once
   on the tailnet (ADR-0849, ADR-0881).
6. **A second computer.** Nothing to set up: it reaches your server by `ssh` or
   through `serve`. Only Whispering keeps a copy there, with your server as its
   remote (ADR-0851).

## Writing and moving data

ADR-0850 and ADR-0851. **Every writer commits exactly what it wrote.** An action
writes as it runs and is refused a path with uncommitted edits; when it ends,
returned or thrown, `epicenter` commits the paths that still hold what it wrote,
and the message says the outcome. Exit codes: 0 ran, 2 did not run, 3 ran and
failed. Runs of one app take turns. The person commits their own edits.
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
epicenter mail show <id> --attachments                   # read one; save its files into mail/
epicenter mail archive <id>                              # one message, directly
epicenter mail search 'category:promotions older_than:14d' > batches/newsletters.local.md
epicenter mail archive --ids @batches/newsletters.local.md   # the same verb, reviewed
epicenter mail trash <id>
epicenter mail label <id> --add receipts
```

- **World verbs** (ADR-0859): `archive`, `trash`, and `label` act on the ids they
  are given, through `batchModify` 1,000 at a time, and are safe to repeat, so a
  run that fails partway is finished by running it again. Nothing records
  progress in the folder.
- **A batch** is a file of ids, read by the same verb through `@<file>`.
  `search` prints one id per line with `# sender: subject` after it, grouped
  under a heading per sender, so its output is a batch; the person deletes lines
  to keep mail. A batch never re-runs its search, so mail that arrives after
  review is never swept in. Named `.local.md`, it stays on this computer
  (ADR-0858), since it lists other people's names and subjects.
- **Attachments** are saved into `mail/` (`attachments/<id>/`, through Git LFS);
  an action writes only its own app's folder (ADR-0859).
- **No mailbox copy at first.** Gmail's quota (6,000 units a minute per user,
  20 per message fetch) makes a whole-mailbox copy take hours. An Inbox-only
  copy in `.cache/`, for SQL triage, comes when a question needs it.
- **Permissions.** Claude Code allows `epicenter mail search` and `show`; it asks
  on `archive`, `trash`, and `label`. Each declares `idempotentHint: true`;
  `archive` and `label` declare `destructiveHint: false`, which Gmail undoes, and
  `trash` keeps the default, since Gmail empties the trash after 30 days.
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

- **Handles in `run` and the typed client** (ADR-0853): with Vocab.
- **Reminders**, as an ordinary app, if a real job needs one.
- **A hosted Epicenter**, with its LFS on R2 (ADR-0856) after a partial-clone
  check: with the first person who cannot keep a computer on (ADR-0864 leaves
  it undecided).
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
2. The old product's folders in `~/Epicenter` (`Todos`, `Zhongwen`,
   `Zhongwen Dev`, `so.epicenter.*`, `local`, `on-this-device`) stay as a clean
   break: discovery ignores a folder without `epicenter.json`. An app named like
   one of them, ignoring case, waits until that folder is moved.
3. An installed app is updated by running `bun epicenter/install.ts <app>`
   again; there is no `upstream` (ADR-0864).

## Build order

ADR-0843 is the rule: new code imports nothing from the waiting product, which
leaves by deletion, one package at a time, once nothing imports it.

**How each step is built.** Acceptance tests come first: black-box runs of the
real `epicenter` in a temporary `HOME` (`packages/cli/src/runner.test-support.ts`),
each with an ID, committed on their own and failing. Then the implementation, in
small commits that each pass `bun run typecheck` and the tests of what they touch
with no failure the commit before did not have. After each step, a collapse pass
deletes what the step made unnecessary, and an independent review runs where its
findings can still change the next step. Work in progress is a commit, never a
stash, so a session that dies leaves its work in `git log`. Tests never touch the
real `~/Epicenter`, the vault, or the Keychain.

| IDs | Step | Where | State |
| --- | --- | --- | --- |
| D1–D7 | the declaration | `acceptance.declaration.test.ts` | pass |
| C1–C9 | the commit rule as rewritten: `folder.commit`, no commit of a run's own | `acceptance.commit.test.ts` | pass |
| W1–W5 | the folder, `sync`, `new`, and `add` | `acceptance.folder.test.ts` | pass |
| F1, F6, F7, F9, F10 | the final review's repairs that outlived the commit machinery | `acceptance.repairs.test.ts` | pass |
| M1–M6 | Mail | to write | after the merge, with the author present |
| S1 | `serve` over HTTPS: MCP at `/mcp`, views at `/<app>/`, and its sign-in | to write | with Capture's view (ADR-0864) |
| K1–K2 | collection actions (`list`, `get`, `set`, `delete`), `collections` in `run`, and generated types | to write | with Vocab |

Done (2026-11-09): waves 0 and 1, and 2a, 2b, 2c, and wave 3's offline parts.
Next: ADR-0850 as rewritten on 2026-11-09 replaces the checkout prototype. Delete
the commit machinery, add `folder.commit` and `epicenter sync` (ADR-0851), then
build Vocab with collections only in `epicenter.json` and types from
`epicenter.d.json.ts` (ADR-0857, K1, K2); then Mail, as ADR-0859 reshapes it.
Done the same day: the machinery is deleted, `folder.commit` and `sync` are
built. Next: the API of ADR-0853 and ADR-0857 as amended 2026-11-09, built with
Vocab: `epicenter:app` generated into `.cache/epicenter/`, exports as actions and
groups, collection actions, `collections` in `run`, the folder's renamed verbs,
the first required field as the positional, `format` asserted, and the client.

**0. Tag and prune.** Done. Tagged `folder-sync-product`; `apps/epicenter`
deleted; the frozen apps stay until each is rebuilt (ADR-0843).

**1. The kit.** Done. `packages/app`, the CLI's core, and commits as ADR-0841 and
ADR-0842 first wrote them.

**2. Mail.**

- **2a. The declaration** (ADR-0857). Done. `epicenter.json` and
  `defineApp(declaration, { collections?, actions })`; the schema and its check;
  problems for anything declared twice; `positional` and `annotations` on the
  action; `epicenter types` (deleted in 2c, F10); `@epicenter/app` supplied; `serve --stdio`, one
  fresh process per call; `EPICENTER_HOME` gone; `folder.delete`. Left: Claude
  Code reaching `reading` through `epicenter serve --stdio` on the author's Mac.
- **2b. The commit rule** (ADR-0850). Done. Each write stored as a Git object and
  the commit built from them; failures labelled in the subject; a path changed
  during the run left uncommitted and named; the CLI's failures as one tagged
  union (`packages/cli/src/errors.ts`).
- **2c. The final review's repairs.** Three independent reviewers read
  `7d13124458..32a94de043`, used the CLI in a temporary `HOME`, and agreed on these
  changes. The commit mechanism's shape stays (objects at write time, a commit
  built from them, a compare-and-swap); what it records and reports changes.
  Each item lands with its acceptance test.
  - F1. **One run report.** A run returns
    `{ action: { returned } | { threw }, refused, commit, paths: [{ path, state }],
    push: { pushed, ahead, behind, reason? } }`, `state` one of committed,
    already-in-history, changed-after, contested, not-committed. The exit code is
    derived from it. `--json` and MCP are that value, and stderr is a rendering of
    it, for every command: `new` and `add` move their `Next:` line to stderr.
    `CliError` keeps only "did not run" variants, an internal-error variant (an
    unexpected throw before the run starts is never `Usage`), and a Git failure
    for `new` and `add`. Deleted: `RunReport`, `Ran`, the `Outcome` fields in four
    variants, the `Partial<Outcome>` cast, the `instanceof` ladder, `Refusal` and
    the other Error classes mapped once into `CliError`, and the duplicated
    refusal messages. Tests: every stderr line is derivable from `--json`; push
    state appears in `--json` and MCP.
  - F2. **Refusals recorded by the run.** The `WriteLog` records each refusal, so
    an action that catches or wraps one still exits 3 with the path in `refused`.
    Tests: a swallowed and a wrapped refusal.
  - F3. **A full record per path.** At write time, `{ base, mode, object }`; at
    commit, a path whose HEAD blob equals its `base` is committed, one equal to its
    `object` is already in history, anything else is contested. A symlink target
    is refused; the executable bit is kept. Deleted: `startHead`, the
    `diff startHead..head`, the `ls-tree` loop, and the `hash-object` loop in
    `changedSince`. Tests: the false contest, a commit that already holds the
    action's bytes, a symlink, the executable bit, the first commit made during a
    run on an unborn branch.
  - F4. **One Git spawn.** `git(folder, args, { stdin, env })` always sets
    `GIT_LITERAL_PATHSPECS=1`, sets `GIT_OPTIONAL_LOCKS=0` on reads, and
    `GIT_TERMINAL_PROMPT=0` on push. The scratch index lives in the OS temporary
    directory; a temporary write file lives under the repository's git path when
    that is on the target's filesystem, otherwise beside the target. Test: a path
    with glob characters.
  - F5. **Push to the same name, after the run.** `refs/heads/<branch>` only to
    the same name, after the run lock is released. Test: a worktree branch whose
    upstream is `origin/main` does not push there.
  - F6. **An action runs in its own process.** Running an action is two
    processes; everything else (listing, help, `new`, `add`) stays one. The parent
    only relays: it forwards SIGINT and SIGTERM, copies the child's stdout and
    stderr to the person's stderr, renders the report it reads from an extra file
    descriptor, and exits with the code derived from it. The child owns the whole
    run: it imports the app, checks the input, takes the lock, commits, and pushes,
    and finishes the run even if the parent dies (it ignores EPIPE on the
    report descriptor). `serve` spawns the child directly. Every self-spawn passes
    `process.execArgv`. The report flag is internal and undocumented. This removes
    the accident of an action's console output reaching the answer, not deliberate
    interference. If the child exits without a report, the outcome is "unknown":
    exit 3, with the branch head before and after. Deleted: `withStdoutKept`.
    Tests: an action calling `console.debug` under `--json` and `serve --stdio`;
    the child killed after its commit reports exit 3 with the heads.
  - F7. **MCP without relisting.** `tools/call` decodes the tool name into app and
    action words and lets the child validate. A broken app's listing failure
    removes only its tools. `serve` never invents a failure when the child exits 0.
    Test: a broken app beside a healthy one over MCP.
  - F8. **One adopt step.** `new`, `add --init`, and `add <url>` write missing
    template files and run `git lfs install --local` when `git-lfs` exists before
    the first commit stages anything. Test: `add --init` on a folder holding
    `node_modules/` and an image.
  - F9. **The vocabulary owned once.** One exported table drives the CLI's
    dispatch and the reserved names. The `update` and `open` stubs go; `setup`
    says it is not built yet; `--json` is accepted in any position; defaulted
    fields are left out of `required`.
  - F10. **Typing waits for its first consumer** (the author's decision, which all
    three reviewers supported). Deleted until collection handles (K1, K2) arrive:
    `epicenter types`, `epicenter.d.json.ts` and its ignore line, the `D` generic
    and `App.declaration`, the differs-from-`epicenter.json` problem, the types
    notes, and D4. `defineApp(declaration, code)` keeps its signature; its JSDoc
    says the `epicenter.json` on disk is the declaration and the argument will
    type collection handles.
  - F11. **Deletions.** Exit code 1, everywhere it is documented; `file-lock.ts`'s
    `turns` queue and `waitMs` and `held`; `declaredName`'s duplicate pass;
    `folderOnDisk`'s optional `log`; the `EPICENTER_TEST_SECRETS` line in the
    person-facing help. `Context.secrets` becomes required.
  - F12. **`field.date()` carries `format: 'date'`**, and the CLI reads the format,
    not the pattern's text.
  - F13. **Records and READMEs match the code.** ADR-0850: the per-path record, the
    Git environment, and which operations hold the index lock. ADR-0851: push to
    the same name, replacing the worktree sentence. ADR-0852: `add <url>` clones
    history. ADR-0857: typing moved to K1 and K2. Both READMEs: `new` and `add` as
    built, no exit code 1. Accepted records' decisions are not edited.
  - F14. **Cleanups found on the way**: the "or undo" left in `file-lock.ts`'s
    header.

  Done when F1 to F14 pass, the earlier acceptance tests still pass, and the
  1,000-run race still loses and misfiles nothing.
- **With Mail, from the same review:** the narrower lock window (build the tree
  and commit outside the lock; take it only for the compare-and-swap and the
  index); a "waiting for <app>" note instead of a silent wait; problems as data
  (`{ at, message, next? }`); error kinds by who acts; repository state in the
  listing; one field descriptor for parsing, usage, help, errors, and JSON Schema;
  one reader of `epicenter.json` and one merge of declaration and code in
  `@epicenter/app`; `MidMerge` covering rebase, cherry-pick, and revert; how M3
  writes into another folder; and checking LFS's pre-push hook.
- **2d. Mail.** Salvage the Gmail client, OAuth, and token code from
  `280bdf4d44^:apps/local-mail/src/`; build the commands in "Mail, the first
  real app" in `~/Epicenter/mail/`, with a fake Gmail for the tests:
  - M1. `mail connect` stores a refresh token in the Keychain; an expired
    sign-in fails naming `epicenter mail connect` as the next step.
  - M2. `mail search` and `mail show` are read-only and commit nothing.
  - M3. `mail show --attachments` saves into `mail/attachments/<id>/` and
    commits them through LFS; nothing is written outside `mail/`.
  - M4. `mail search` prints a batch: one id per line, `# sender: subject`
    after it, grouped by sender.
  - M5. `mail archive --ids @<file>` archives only the ids left in the file;
    a run stopped partway and run again archives the rest and changes nothing
    already archived.
  - M6. `mail archive <id>` archives one message directly, and records nothing
    in the folder.

  Done when M1 to M6 pass against the fake and the receipts and newsletter jobs
  are finished with the real Gmail and Claude Code.

**3. Your server** (ADR-0849, ADR-0851, ADR-0852, ADR-0854, ADR-0856). Done
offline: `.cache/` in the folder, `sync` deleted, the fast-forward push and ahead
and behind in the listing, `new` and `add`, and the LFS refusal. Left:
  - S1. `epicenter serve` on the tailnet speaks MCP over Streamable HTTP, each call
    in a fresh process.
  - S2. `epicenter setup`, and the CLI and `serve --stdio` on another computer
    forwarding a named action with the same output and exit code.

  Done when Claude Desktop on the laptop runs `mail search` on the Mac, every
  commit reaches its `origin`, and remote FileVault unlock over SSH has been
  tried.

**4. The vault.** `epicenter add ~/Code/vault`; an `epicenter.json` and a
`.gitattributes`; its scripts become actions in `~/Code/vault/epicenter.ts`, with
the scripts' writes to tracked files moved onto `folder` and their ignored
mirrors (`.calendar/`, `.todoist/`, `.photos/`) left as they are. Done when
`epicenter vault calendar show …` runs from the laptop.

**5. Vocab and collections** (ADR-0853). K1: a collection's `list`, `get`,
`set`, and `delete` through the CLI and MCP, `set` refusing input that does not
fit. K2: the same as `collections` in `run`, typed through `epicenter:app`
(ADR-0857 as amended 2026-11-09; F10 deleted the earlier `epicenter.d.json.ts`).
Then the typed client and Vocab's view, served by `serve` at `/vocab/`
(ADR-0860); Vocab rebuilt on them. The
frozen Vocab leaves when the rebuilt one runs.

**6. Prune the rest.** Collection paths with two placeholders come here, with
Whispering's and Vocab's formats: Whispering's audio is `{id}.{ext}` and Vocab's
messages are `{chat}/{id}`, which a one-placeholder path cannot describe. Until
then those files stay outside generic collections. In the order ADR-0843 gives: `apps/api` loses its folder
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
- Vocab runs as an app with collections and actions, and its view in a browser
  lists its words, edits one with `set`, and runs its actions.

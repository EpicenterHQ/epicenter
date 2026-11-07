# Epicenter is where personal software lives

**Date**: 2026-11-07
**Status**: Draft
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
  tool. Commands today are platform operations for the folder sync product.
- `packages/definition`: front matter, merge, contracts for the sync product.
- The author's tools are scripts in `~/Code/vault/scripts/` (calendar, photos,
  todoist), run by Claude.

## Target shape

```
~/Epicenter/                    a private Git repo; the default home
  package.json                  "@epicenter/app" and whatever apps import
  AGENTS.md                     "run `epicenter` to see what you can do"
  mail/
    epicenter.ts                export default defineApp({ … })   (or one line re-exporting a package)
    queries/receipts.txt        a saved Gmail search
    batches/                    reviewed changes; .gitignored
  reading/
    epicenter.ts
    2026.csv
~/Code/vault/
  epicenter.ts                  the vault's scripts as actions, where it stands
~/Library/Caches/Epicenter/<app>/   rebuildable: mailbox copies, browser profiles
Keychain: epicenter.<app>            sign-ins
```

The contract is ADR-0841: `defineApp({ description, actions })`; an action is
`{ description, input: { …fields }, run(input, { folder, cache, secrets }) }`.

## Packages

| Package | Holds | Precedent |
| --- | --- | --- |
| `@epicenter/app` | `defineApp`, `field`, the types. No Node or Bun APIs, so a page can import its types | Convex's `convex/server` (`query`, `mutation`, `action` with `args: { x: v.string() }`), Trigger.dev's `task({ run })`, Drizzle's split of `drizzle-orm` (definitions) from `drizzle-kit` (CLI) |
| `@epicenter/cli` | the `epicenter` binary: discovery, commands, `mcp`, later `serve` and `open` | `drizzle-kit`, `vite` |
| `@epicenter/mail` | Mail's default app, re-exported by `~/Epicenter/mail/epicenter.ts` | |

The unscoped `epicenter` name on npm is not ours; everything is under the
`@epicenter` scope. `packages/definition`'s note and merge code moves to an
optional library for apps whose data is notes, or is deleted if no app needs it.

## Onboarding

1. **Install.** `bun add -g @epicenter/cli` gives `epicenter`.
2. **First run.** `epicenter` with no `~/Epicenter` offers to create it: a
   `package.json` depending on `@epicenter/app`, an `AGENTS.md` (and `CLAUDE.md`
   importing it) telling agents to run `epicenter`, a `.gitignore`, and
   `git init`. The person adds a private remote if they want one.
3. **A new app.** `epicenter new reading` writes `reading/epicenter.ts` from a
   template. Usually the person asks Claude instead, which writes the file; the
   app works at once because Bun runs TypeScript.
4. **An existing app.** `epicenter new mail --from @epicenter/mail` writes a
   one-line `epicenter.ts` and adds the dependency. Then
   `epicenter mail connect` signs in.
5. **The vault.** Add `~/Code/vault/epicenter.ts`; `cd ~/Code/vault && epicenter`
   lists its actions.
6. **Agents.** Claude Code needs nothing: it runs `epicenter` in the shell, and
   permission rules allow reads by command prefix and ask on the rest. Claude
   Desktop and other chat apps add `epicenter mcp` to their MCP settings.
7. **A second computer.** Clone `~/Epicenter`, `bun install`, and `connect`
   again where an app needs a sign-in. Caches fill on first use.

## Sync

**Git is the protocol, run by the person.** A folder's data travels as commits;
`epicenter` commits nothing on its own and never stages paths it did not write.
Caches never sync, because each computer rebuilds its own. Secrets never sync,
because a sign-in is granted per computer. Conflicts are Git's: line merges,
with markers left in the file for the person or an agent to resolve; notes
written with the canonical front-matter rule (one `key: <JSON>` line per field)
merge cleanly by line. An `epicenter sync` that pulls and pushes every repo
under the home is a later convenience, not a protocol.

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
- **Before writing code.** Google issues 7-day refresh tokens to clients in
  "Testing". Reuse the vault's calendar Google project, confirmed "In production",
  or move it there. An expired sign-in prints "run `epicenter mail connect`".

## Refused for now

A UI; `epicenter serve`; remote MCP; phones and browsers; Tauri and native
capabilities (Whispering stays its own app); a sync engine; shared providers
such as Google sign-in in core; installing apps from links; sandboxing; schemas
for folders.

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
4. Whether `packages/definition` survives as a notes library or is deleted.
5. What `vision.md`, `architecture.md`, `CONTEXT.md`, and the package READMEs say,
   once ADR-0840 is accepted.

## Done when

- `epicenter` in `~/Epicenter` lists apps and actions; `epicenter <app> <action>`
  runs one with typed flags and `--json`; inside an app folder the app name is
  implied; `epicenter mcp` serves the same actions.
- `reading` (a toy) and `mail` work end to end; the receipts and newsletter jobs
  are done with Mail and Claude Code.
- The vault's calendar script runs as `cd ~/Code/vault && epicenter …`.

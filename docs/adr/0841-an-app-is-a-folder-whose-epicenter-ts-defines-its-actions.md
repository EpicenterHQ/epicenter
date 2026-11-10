# 0841. An app is a folder whose `epicenter.ts` defines its actions

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the direction), [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) (commits, exit codes, sync), [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) (one table, rendered twice).
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
- **Amended by:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md): `defineApp` also takes `collections`, each a path and fields. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at where the context comes from: each host supplies it. [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md): `defineApp` composes collections and actions defined on their own, actions nest under their words, and a run reaches `folder` and `secrets` without a context argument. [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md): a run reaches `folder` only; `secrets` and the Keychain service are deleted, and secrets are `.local` files.
- **Amended:** 2026-11-08, `add` takes any source (below).
- **Unbuilt:** `epicenter add`.

## Context

ADR-0840 makes Epicenter the home of one person's apps and the agents that use
them. An app needs a name, a list of things it can do with typed input, an
implementation for each, and somewhere to keep its data. The CLI already renders
one description of an operation as a command and as an MCP tool
([ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md)); apps need the same, without writing a command
or a tool by hand. A council of three reviewers tested the command surface
against agents' permission rules, the vault's existing nested commands, and
worktrees.

## Decision

**An app is a folder containing `epicenter.ts`.** Its code and its data live
together in it, and it is its own Git repository with its own `package.json` and
lockfile.

```ts
// ~/Epicenter/reading/epicenter.ts
import { defineApp, field } from '@epicenter/app';

export default defineApp({
  name: 'reading',
  description: 'How much I read each week',
  actions: {
    log: {
      description: 'Record minutes read today',
      input: { minutes: field.number({ positional: true }), book: field.text({ optional: true }) },
      run: async ({ minutes, book }, { folder }) => { /* write under folder */ },
    },
    'week summary': {
      description: 'Minutes read this week',
      input: {},
      readOnly: true,
      run: async (_, { folder }) => ({ minutes: 210 }),
    },
  },
});
```

**Names.** An app declares its `name`, which keys its Keychain service, its
cache, and its tools, so a worktree run by path keeps its identity. Inside the
home, a folder or link must carry the declared name; a mismatch or a duplicate is
listed as a problem and not run. Names match `^[a-z][a-z0-9-]*$`. An action's key
is one or more such words separated by spaces (`'calendar show'`); no action
name is a whole-word prefix of another, so the longest match is the action.

**An action** has a `description`, an `input` that is a plain record of fields,
`run(input, { folder, cache, secrets })`, and optionally `readOnly` or
`destructive`, which become MCP's hints and the listing's marks. `run` returns a
value; the CLI prints it, as JSON with `--json`, and an agent receives the same
value.

**Fields** are `field.text`, `number`, `boolean`, `select([...])`, `tags`, and
`date`, each taking `{ optional, description, positional }`, all TypeBox
underneath. Every field is a flag; at most one is `positional`, and it remains
usable as its flag. A repeated flag gives an array. `json`, `help`, and `version`
are not field names. Raw TypeBox remains for anything else.

**The context an action receives**, three stores that differ by how long what they hold lives.
- **`folder`** is the app's folder as an object: `read`, `write`, `list`,
  `remove`, their bytes forms, and `path` only where there is a real disk. The
  runner supplies it: the disk for the CLI and `epicenter serve`, Epicenter
  Cloud for a page without Git, memory for a test. An action that uses only the
  methods runs anywhere; one that uses `path` runs only on a computer. `folder`
  has no `clear()`: data is deleted one path at a time, in an action that
  becomes a commit.
- **`cache`** is the same kind of object for anything that can be rebuilt: this
  device only, never synced, never in history, at
  `~/Library/Caches/so.epicenter.apps/<name>/` on a computer. A folder run by
  path, such as a worktree, gets its own, `<name>-<hash of its real path>/`, so a
  copy whose cache has a new shape never breaks the home app's. (The reversed
  domain keeps clear of `~/Library/Caches/epicenter`, which the desktop shell
  already uses, on a disk that ignores case.) It adds `clear()` and, on a
  computer, `sqlite(name)`, Bun's own `Database` at `<name>.sqlite`. A cache is
  never migrated: after a change of shape it is cleared and rebuilt. SQLite never
  lives in `folder`.
- **`secrets`** reads and writes the Keychain under `epicenter.<name>`, exists
  only on a computer, and never touches a file. Every copy of an app on one
  computer, a worktree included, shares its sign-ins; no other app sees them;
  they never leave the computer, so each computer connects once.

Code shared between actions and pages is ordinary modules in the app's folder
that take a `folder` as an argument.

**The command surface.** Every action has exactly one spelling, wherever the
command runs:

```
epicenter [--json]                              apps, actions, input schemas, problems
epicenter <app> [--json]                        one app: actions, folder, cache path, Keychain service
epicenter <app> <action words> [<positional>] [--flags] [--json]
epicenter <path> <action words> …               a folder by path, such as a worktree
epicenter new <name> | add <source> | sync | mcp [<app>…] | help
```

- **The home is `~/Epicenter`**, a plain directory of app folders; nothing in it
  is generated. An app elsewhere joins by a symlink in the home
  (`~/Epicenter/vault -> ~/Code/vault`), which the listing shows with its target.
- **Global flags come after the action words**, so a permission rule written as a
  command's prefix (`Bash(epicenter mail search *)`) always matches it.
- **A folder by path** uses its declared name, and is refused when its real path
  is an app in the home or a link's target, with the spelling to use instead.
- **Built-ins win.** `new`, `add`, `update`, `sync`, `mcp`, `help`, `serve`, and
  `open` are reserved; an app declaring one is listed as a problem.
- **Discovery imports each app on its own**, so one broken app is listed as a
  problem and the rest still run.
- **Every action is a local MCP tool** named by its app and words joined with
  `_` (`vault_calendar_show`).

**An app is delivered by copying it.** `epicenter add <source>` copies the files
the source tracks in Git at one commit into a new repository in the home, runs
`bun install`, records `{ from, sha }` under `epicenter` in the app's
`package.json`, and keeps that copy as the `upstream` branch. "Code, never data"
means what the source tracks: a source that tracks its author's data passes it
on. A later version of the source is merged with Git (`git merge upstream`);
`update` is reserved for that and built when the first source changes. A
source is a Git URL, the URL of a single `epicenter.ts` for a one-file app, or
a registry entry listing an app's files; whatever it is, the copy is owned code
that the person or their agent changes freely.

**A UI calls actions; it never writes files itself.** A page imports the app's
type, not its code, and calls actions through `epicenter serve`; forms come from
the fields.

## Considered alternatives

- **The current directory chooses the app** (`epicenter log` inside
  `reading/`). The same text would run different actions in different
  directories, so a permission rule written for one would allow another; the
  vault's `calendar` group would shadow a future `calendar` app.
- **The folder's name is the app's name.** A worktree run by path would be a
  stranger with no sign-in.
- **Nested groups of actions.** A record mixing actions and groups lost
  TypeScript's inference of `run`'s input (checked on 5.9.3); spaced keys keep it
  and keep the vault's spellings.
- **Kebab names for nested commands.** Would rename the vault's forty commands
  and lose grouping in `--help` and in permission rules.
- **Per-app commands on the PATH** (`mail search`). `/usr/bin/mail` and
  `/usr/bin/calendar` exist, and an agent needs one listing and one MCP server.
- **`epicenter run <app> <action>`, or a sigil.** A word or a symbol on every
  call, forever.
- **A generated Bun workspace in the home, and an `AGENTS.md` there.** The
  workspace's lockfile would live outside every repository, so a clone would
  install untested versions; agents start in the vault and repositories and never
  read the home's file.
- **`epicenter.config.ts`, or `add` and `forget` remembering paths.** A list can
  go stale; the home's entries and links say what is there.
- **`app.ts`.** Collides with files in existing code folders.
- **`operations`, `commands`, `tools`; `summary` with a `title`; an `op()`
  wrapper; `Type.Object` for input; `folder` as a path; one repository for every
  app; installing apps as packages.** As recorded when each was decided: each
  names one surface, says less, ties actions to a disk, opens every app to one
  token, or stops the person changing their copy.
- **A cache inside the app folder** (`.cache/`). Needs excluding from Git and from
  backups in every folder, and is indexed by the vault's own tools.
- **A `cache`, `link`, or `diff` command.** `epicenter <app>` prints the cache
  path; a link is `ln -s`; `diff` reads as "my uncommitted changes".

## Consequences

- Writing an app is writing one file; asking an agent for an app is asking it to
  write one, and `epicenter new` writes the `name` line.
- Typing an action always includes its app's name.
- Epicenter writes no instructions for agents anywhere. An agent learns of
  `epicenter` from the person or from a repository's own instructions, and then
  learns everything else from `epicenter --json`.
- The vault's `defineFolder` declaration, which was its `epicenter.ts`, is now
  `folder.ts`, so the name is free for the vault's actions.
- A developer shares an app by putting its folder in a Git repository; the person
  owns their copy, and a new version is a merge.

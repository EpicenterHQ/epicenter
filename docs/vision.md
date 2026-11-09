# Vision

Epicenter is where one person's software lives. Each app is a folder of files
the person, their editor, and their agents can read and change; Epicenter runs
the app's actions for them and their agents, from the terminal, from Claude, and
from any program that asks.

This page is the front door. It describes the design proposed on 2026-11-08 in
[ADR-0849] to [ADR-0857] and reviewed by three independent reviewers before
anything beyond the first kit was built. [ADR-0840] records why the direction
changed. The [spec](../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
carries the build order and the first app, Mail. [Architecture](architecture.md),
[CONTEXT](CONTEXT.md), and the package READMEs describe the code that exists,
which is mostly the earlier product described at the end.

## In four lines

1. An app is a folder: `epicenter.json` says what its files are, and
   `epicenter.ts`, if present, says what you can do.
2. Actions change files; whoever knows the intent commits, and `epicenter sync`
   commits the rest.
3. `epicenter` runs actions, and your Epicenter runs them through `serve` for
   anything without the folder.
4. Git moves everything, `epicenter` never merges, and each job takes the least
   powerful form that does it.

## What it is like

- **Receipts.** You ask Claude Code to find last month's receipts for a friend.
  It runs `epicenter mail search 'receipt after:2026/09/01'`, reads a few with
  `epicenter mail show --attachments`, which saves their files into Mail's own
  folder. Gmail is unchanged.
- **The inbox.** `epicenter mail archive <id>` archives one message. For many,
  `epicenter mail search 'category:promotions' > batches/newsletters.local.md`
  writes a batch: one id per line, grouped by sender. You delete the lines for
  mail you want to keep, then run `epicenter mail archive --ids
  @batches/newsletters.local.md`, the same verb. If Gmail fails at line 612,
  you run it again: archiving an archived message changes nothing.
- **A vault script becomes an action.** The calendar script in your vault turns
  into `epicenter vault calendar show`. Later you ask Claude Code to change how it
  groups events; it edits `epicenter.ts` in a worktree, tries it with
  `epicenter ./worktree calendar show`, and merges. The next run uses the new
  code.
- **A recording on a plane.** Whispering records, transcribes, and pastes, with no
  network and no `epicenter`. It writes each recording into `~/Epicenter/whispering`
  and commits it; when the laptop is back online, Whispering syncs, and your
  Epicenter's copy has it at its next sync.
- **Adding to someone else's folder.** You ask an agent for a weekly summary of
  your voice notes. It adds a `summaries` collection to Whispering's
  `epicenter.json` and an `epicenter.ts` with a `summarizeWeek` action. Whispering keeps writing
  its own `epicenter.json` and never notices.

## The pieces

| Noun | What it is |
| --- | --- |
| an app | a folder whose `epicenter.json` names it and declares its collections; an `epicenter.ts` beside it adds actions |
| a collection | a kind of file in the app, by path (`words/{stem}.md`) and fields; it gives `list`, `get`, `set`, and `delete` |
| a field | JSON Schema for one value; in TypeScript, written with helpers such as `field.text()` |
| an action | something you can ask an app to do: a collection's four, or one the author writes with a `run` function |
| `epicenter` | the program that runs an action in a folder |
| your Epicenter | the one computer you keep on, where `epicenter serve` runs and your sign-ins live |
| Git | history, `origin` where copies meet, `upstream` where code came from, LFS for binaries |

"Your Epicenter" is the computer; `epicenter` is the program. Everything else is a
program that either has the folder or asks for actions: your editor, Claude Code,
Claude Desktop, Whispering, the Epicenter app.

## An app

```txt
vocab/
  epicenter.json          name, description, collections
  epicenter.ts            actions
  tsconfig.json           one line, extending .cache/epicenter/tsconfig.json
  words/serendipity.md    data: front matter and a body
  .cache/epicenter/       types epicenter generates from epicenter.json
  .cache/                 rebuildable files, ignored by Git
  .gitignore, .gitattributes
```

```json
{
  "$schema": "https://epicenter.so/epicenter.schema.json",
  "name": "vocab",
  "description": "Words I'm learning",
  "collections": {
    "words": {
      "path": "words/{stem}.md",
      "fields": { "type": "object", "properties": { "stage": { "enum": ["new", "known"] } }, "required": ["stage"] }
    }
  }
}
```

```ts
import { action, field } from 'epicenter:app';

export const define = action({
  description: "Look up a word's definition",
  input: { stem: field.text() },
  annotations: { readOnlyHint: true, openWorldHint: true },
  run: async ({ stem }, { collections }) => {
    const word = await collections.words.get({ stem });
    // ask a dictionary, return what it says
  },
});
```

Vocab's tools are `words list`, `words get`, `words set`, `words delete` from
`epicenter.json`, and `define` from `epicenter.ts`; a written action with a
collection action's name replaces it, and `null` removes one. On the command
line the first required field is read by position: `epicenter vocab define
serendipity`.

A folder with only `epicenter.json` is a whole app that cannot run code. Every
collection is declared in `epicenter.json`; `epicenter.ts` holds only actions.
Every export of `epicenter.ts` is an action or a group of them, such as
`export const words = { archive: action({…}), delete: null }`. `run` gets
`folder` (the app's files, and `folder.commit`), `secrets` (its sign-ins), and
`collections` (the same four actions every client gets, checked against each
collection's schema). `epicenter:app` is the app's own module, which
`epicenter` generates from `epicenter.json` into `.cache/epicenter/`, so
`collections` and every field are typed in an editor with no `package.json`.

## How a write happens

**If you have the folder, write the files and commit them when you know what the
change was.** That is true for you in your editor, for Claude Code, and for
Whispering.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer, and
the Epicenter app.

**An action changes files and commits only if its author says so.** `run` calls
`folder.commit('Add 12 words')` when one run is one change; otherwise what it
wrote waits for you, your agent, or `epicenter sync` to commit it. Exit codes
tell an agent what happened: 0 returned, 1 threw, 2 did not run.

## Where code runs, and how to reach it

Code goes where what it needs is. Recording needs the microphone, so it lives in
Whispering. Searching Gmail needs your sign-in, so it is an action that runs on
your Epicenter.

```txt
ssh studio                                          you, then `epicenter …` there
ssh studio epicenter serve --stdio                  an agent's MCP server, from any computer
epicenter vocab define serendipity                  this computer's copy of Vocab; never forwarded
```

A command always means the computer it is typed on. `serve` speaks MCP and
nothing else, and runs each call in a fresh process, so code you just pulled is
what runs. **Claude and ChatGPT on your phone, and claude.ai, do not reach
your apps yet**: they connect from their vendors' clouds and need a public
address with a sign-in, which comes when you want an app on your phone. Until
then, nothing guards your sign-ins from another program running as you except
your agents' permission rules.

## How data moves

Each app with history has one Git remote, `origin`: where copies meet, and the
backup. `epicenter sync` commits what is left, pulls with `--rebase`, and pushes;
it is the only command that touches a remote. You, an agent, a screen's button,
or a launchd job on each computer runs it. The Mac Studio and the laptop never
talk to each other; each syncs with `origin`. Binary files a
folder tracks go through Git LFS: text is history, binaries are content.
`.cache/` and sign-ins never leave a computer.

## One ladder

Every app climbs the same ladder, and each rung is optional.

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any program reads and writes it |
| 2. History | Git, `git-lfs`, an `origin` | backup, history, copies elsewhere |
| 3. Actions | `epicenter` | its actions in the terminal and for Claude Code |
| 4. Reach | your Epicenter | the same actions from your other computers |

Whispering is whole at rung 1. Mail needs rung 4, because its code needs your
Gmail sign-in on a computer that is always on.

## Each job, the least powerful form

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare an app | `epicenter.json` | it has code: `epicenter.ts` |
| Describe a field | JSON Schema | never |
| Change data | edit a file | it needs a rule, a sign-in, or reach |
| An action | a collection's four | it needs logic |
| Record what ran | its own files, and a commit by whoever knows the intent | never |
| Share data between programs | the folder | never |
| Move data | Git | never |
| Big files | `.gitattributes` | never |
| Reach | MCP | never |
| Run something later | someone asks | never |

**Refused:** a sync engine, schedules, merging by `epicenter`, a schema language of
its own, an API beside MCP, programs that ship `epicenter`, apps hosted inside the
Epicenter app, running actions on the phone or in a browser.

**Later, each when something needs it:** reach from the phone; collections'
four actions, the typed page client, and the Epicenter app (with Vocab);
reminders as an ordinary app; Epicenter Cloud and its registry, for people who
cannot keep a computer on; moving the vault's history into LFS; WebAssembly
actions or a Rust core, when apps from strangers run with your sign-ins.

## What came before

Records [ADR-0802] to [ADR-0839] designed a folder sync product for many
people: folders kept the same on every device and with everyone they were
shared with, a server keeping every version, Git at the edges, and web and
phone apps. [ADR-0835] was its register. It waits, because its one user needed
something smaller first; the code in this repository today is mostly that
product. What carried over: files a person can read, Git as history, one table
of operations rendered as CLI and MCP ([ADR-0827]), and the rule that a note's
fields are written one `key: <JSON>` line each.

[ADR-0802]: adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md
[ADR-0827]: adr/0827-the-cli-and-mcp-render-one-table-of-operations.md
[ADR-0835]: adr/0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md
[ADR-0839]: adr/0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md
[ADR-0840]: adr/0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md
[ADR-0849]: adr/0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md
[ADR-0857]: adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md

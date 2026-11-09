# Vision

Epicenter is where your personal software lives: small apps that you and your
agents make and change, whose data is your files, and which you can use from
every device you own. Each app is a folder in one place, `~/Epicenter`, on a
computer you keep on; the `epicenter` command runs its actions for you and your
agents, and `epicenter serve` offers them over MCP to Claude, ChatGPT, and each
app's views in a browser.

This page is the front door. It describes the design proposed on 2026-11-08 in
[ADR-0849] to [ADR-0857] and reviewed by three independent reviewers before
anything beyond the first kit was built. [ADR-0840] records why the direction
changed, and [ADR-0864] why there is one copy of each app and code runs where
its owner trusts it. The [spec](../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
carries the build order and the first app, Mail. [Architecture](architecture.md),
[CONTEXT](CONTEXT.md), and the package READMEs describe the code that exists,
which is mostly the earlier product described at the end.

## In three laws

1. **What's yours is everywhere.** What you and your agents make is files in an
   app's folder on your server, the one copy, and every device reaches it
   there. `*.local` and `.cache/` stay where they are.
2. **Everything else is used where it is.** A sign-in, a machine's hardware, a
   service that exists on one machine. An action runs where what it uses is.
3. **Everything you see or ask is an interface to actions.** The terminal and
   MCP come from an app's actions; views and prompts are written.

An app is a folder: `epicenter.json` (what its files are), `epicenter.ts` (what
you can do), `views/` (for people), and `prompts/` (for agents). Getting the
folder installs it ([ADR-0861]).

## One copy, and clients that ask

`~/Epicenter` on your server is the place: a folder per app, each a Git
repository. For the author, your server is the Mac Studio. There is one copy of
each app, and every client asks it ([ADR-0864]).

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <collection> <verb>` | the command, opening the folder directly | you, agents with a shell |
| `epicenter serve` | MCP over HTTPS at `/mcp`, and each app's `views/` at `/<app>/` | Claude, ChatGPT, any agent; views in a browser |
| Git over SSH | `studio:Epicenter/whispering` as a copy's remote | a program that keeps a copy: Whispering |

Capture, Vocab, agents, and views keep nothing on a device and always see the
current files. Whispering keeps a copy on each Mac it runs on, because it must
record with no network, and pushes to your server when it can. `epicenter serve`
runs the `epicenter.ts` of each app you trust, and Epicenter holds no
third-party credentials: Mail's Google sign-in is in the Keychain of the
computer that runs Mail's actions.

Agents make apps: you start Claude Code on your server, ask for an app, and it
writes the folder. In the Epicenter repository an app's source is
`epicenter/<app>/`, and `bun epicenter/install.ts <app>` installs it into
`~/Epicenter/<app>`.

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
- **A capture from the phone.** You open Capture's view in your phone's browser,
  served by your server at `/capture/`, and save a quote. The view asks
  `capture_add` over MCP; your server writes `captures/<id>.md` and commits it.
- **A recording on a plane.** Whispering records, transcribes, and pastes, with no
  network and no `epicenter`. It writes each recording into its copy of
  `~/Epicenter/whispering` and commits it; when the laptop is back online,
  Whispering pushes to your server.
- **Adding to someone else's folder.** You ask an agent for a weekly summary of
  your voice notes. It adds a `summaries` collection to Whispering's
  `epicenter.json` and an `epicenter.ts` with a `summarizeWeek` action. Whispering keeps writing
  its own `epicenter.json` and never notices.

## The pieces

| Noun | What it is |
| --- | --- |
| the place | `~/Epicenter` on your server: a folder per app, and nothing else |
| an app | a folder whose `epicenter.json` declares its collections; an `epicenter.ts` beside it adds actions; its name is the folder's |
| a collection | a kind of file in the app, by path (`words/{stem}.md`) and fields; it gives `list`, `get`, `set`, and `delete` |
| a field | JSON Schema for one value; in TypeScript, written with helpers such as `field.text()` |
| an action | something you can ask an app to do: a collection's four, or one the author writes with a `run` function |
| a view | a web page in the app's `views/`, served at `/<app>/`, that shows its data and calls its actions over MCP |
| `epicenter` | the program that runs an action in a folder, and `epicenter serve`, which offers every app over MCP |
| a device program | an app's own program, when it needs the device: Whispering |
| your server | the computer you keep on, which holds the one copy of each app and runs its actions |
| Git | history, `origin` (your server's GitHub backup, or your server for a copy), LFS for binaries |

Everything else is a program that either has the folder or asks for actions:
your editor and Claude Code on your server, and Whispering with its copy, have
it; Claude Desktop, claude.ai, ChatGPT, and a view in a browser ask.

## An app

```txt
vocab/
  epicenter.json          description, collections
  epicenter.ts            actions
  tsconfig.json           one line, extending .cache/epicenter/tsconfig.json
  words/serendipity.md    data: front matter and a body
  views/                  the built view, ignored by Git
  .cache/epicenter/       types epicenter generates from epicenter.json
  .cache/                 rebuildable files, ignored by Git
  .gitignore, .gitattributes
```

```json
{
  "$schema": "https://epicenter.so/epicenter.schema.json",
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
change was.** That is true for you in your editor, for Claude Code on your
server, and for Whispering.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer,
claude.ai, ChatGPT, and a view.

**A write through `epicenter serve` is one commit, named for the call**
(`capture: captures set dune`), pushed to the app's GitHub backup. **An action
run from the command line commits only if its author says so.** `run` calls
`folder.commit('Add 12 words')` when one run is one change; otherwise what it
wrote waits for you, your agent, or `epicenter sync` to commit it. Exit codes
tell an agent what happened: 0 returned, 1 threw, 2 did not run.

## Where code runs, and how to reach it

Code goes where what it needs is. Recording needs the microphone, so it lives in
Whispering. Searching Gmail needs your sign-in, so it is an action that runs on
your server.

```txt
ssh studio                                   you, then `epicenter …` there
ssh studio epicenter serve --stdio           an agent's MCP server, from any computer
epicenter serve, over your tailnet           your devices: views and MCP
epicenter serve, through Tailscale Funnel    claude.ai and ChatGPT, signed in with OAuth
```

A command always means the computer it is typed on. `serve` speaks MCP and
serves views, and runs each call in a fresh process, so code you just pulled is
what runs. Adding claude.ai or ChatGPT as a connector opens a page on your
server where you approve it with a passkey, and the client receives a token you
can revoke. Nothing guards your sign-ins from another program running as you
except your agents' permission rules.

## Views

An app's interfaces are views ([ADR-0860]): a web page in the app's `views/`,
built from source and served at `/<app>/`, that reads and changes the app only
by calling its actions over MCP at `/mcp`. A view never knows where the actions
run, works in any browser that reaches your server, and keeps nothing of its
own.

| Rung | Interface | Steps up when |
| --- | --- | --- |
| 1 | the terminal, Claude, Claude Code, ChatGPT | you want to see or tap, not type |
| 2 | a view, in a browser | it needs the device in a way a browser does not give |
| 3 | a program of its own with a copy, such as Whispering | never |

## How data moves

Your server's copy is the one copy. Each app with history has one Git remote,
`origin`: on your server, the app's GitHub repository, its backup; for a
program's copy on another Mac, your server over SSH. `epicenter sync` commits
what is left and pushes; on a copy it pulls with `--rebase` first. It is the
only command that touches a remote, and you or an agent runs it; nothing runs
on a timer. A push from a copy lands in your server's working tree unless it
touches a file with uncommitted changes there. Binary files a folder tracks go
through Git LFS: text is history, binaries are content. `.cache/` and sign-ins
never leave a computer.

## One ladder

Every app climbs the same ladder, and each rung is optional.

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any program reads and writes it |
| 2. History | Git, `git-lfs`, an `origin` | backup and history |
| 3. Actions | `epicenter` | its actions in the terminal and for Claude Code |
| 4. Everywhere | `epicenter serve` on your server | every device, claude.ai, and ChatGPT reach it; its views open in a browser |

Whispering is whole at rung 1. Mail's actions run where your Gmail sign-in is,
on your server; its files reach every rung.

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
| An interface | Claude or the terminal | it needs to be seen: a view |
| Run something later | someone asks | never |

**Refused:** a sync engine, schedules, merging into your server's copy, a schema
language of its own, an API beside MCP, programs that ship `epicenter`, an
Epicenter app on every device holding a copy of each app, a catalog of apps,
Epicenter holding third-party credentials, a folder kept in a browser, a
browser that runs actions, and running other people's code in isolates or
Durable Objects.

**Later, each when something needs it:** `collections` in `run` and the typed
client, with Vocab; the field merge, if Whispering's conflicts prove frequent;
reminders as an ordinary app; a hosted Epicenter, for people who cannot keep a
computer on; moving the vault into `~/Epicenter`, and its history into LFS.

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
[ADR-0849]: adr/0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md
[ADR-0857]: adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md
[ADR-0860]: adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md
[ADR-0861]: adr/0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md
[ADR-0864]: adr/0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md

# Vision

Epicenter is where your personal software lives: small apps that you and your
agents make and change, whose data is your files, and which you can use from
every device you own. Each app is a folder in one place, `~/Epicenter`, on a
computer you keep on; the `epicenter` command runs its actions for you and your
agents, and `epicenter serve` offers them over MCP to your agents, and each
app's UI to a browser, on every device on your tailnet.

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
   app's folder on your server, the one copy that is kept, and every device
   reaches it there; a program that must work offline keeps a clone and pushes
   to it. `*.local` files and rebuilt files stay on the home.
2. **Everything else is used where it is.** A sign-in, a machine's hardware, a
   service that exists on one machine. An action runs where what it uses is.
3. **Everything you see or ask is an interface to actions.** The terminal and
   MCP come from an app's actions; UIs and prompts are written.

An app is a folder: `epicenter.ts` (what its files are and what you can do),
`ui/` (for people), and `prompts/` (for agents). Getting the
folder installs it ([ADR-0861]).

## One copy, and clients that ask

`~/Epicenter` on your server is the place: a folder per app, each a Git
repository. For the author, your server is the Mac Studio. There is one copy of
each app, and every client asks it ([ADR-0864]).

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <action>` | the command, opening the folder directly | you, agents with a shell |
| `epicenter serve` | MCP over HTTPS at `/`, the launcher there for a browser, and each app's UI at `/<app>/` | Claude Code, Claude Desktop, any agent on your tailnet; UIs in a browser |
| Git at `/<app>.git` | a clone of the app's data repository, which pushes to its own branch | a program that works offline: Whispering ([ADR-0887]) |

Capture, Vocab, agents, and UIs keep nothing on a device and see the current
files when they reach the home. Whispering on another device keeps a clone of
the `whispering` app's data, commits each recording, and pushes when it can
reach the home, which files the push into `main` ([ADR-0887], [ADR-0888]).
`epicenter serve`
runs the `epicenter.ts` of each app you trust, and Epicenter holds no
third-party credentials: Mail's Google sign-in is a `.local` file in Mail's
folder, on the computer that runs Mail's actions, and never leaves it.

Agents make apps: you start Claude Code on your server, ask for an app, and it
writes the folder. Every app is its own source: its code is changed where it
is. An app can start from a starter, a repository with no data, which it keeps
as its `upstream` remote; `epicenter update` merges the starter's changes
([ADR-0866]). Capture, Tasks, and Vocab are starters in `apps/<app>/` today, and an app is
made from one once it moves to a repository of its own.

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
- **A capture from the phone.** You open Capture's UI in your phone's browser,
  served by your server at `/capture/`, and save a quote. The UI asks
  `capture_add` over MCP; your server writes `captures/<time>.md` and snapshots it.
- **A recording on a plane.** Whispering on your laptop records, transcribes,
  and pastes with no network, and writes each recording into `~/Whispering`.
  It commits each one; when the laptop reaches your server again, it pushes,
  and the recordings appear in the `whispering` app for your agents
  ([ADR-0887]).
- **Adding to someone else's folder.** You ask an agent for a weekly summary of
  your voice notes. It adds a `summaries` collection and a `summarize-week`
  action to the `whispering` app's `epicenter.ts`, which came from
  Whispering's starter. Whispering keeps writing its recordings and never
  notices ([ADR-0889]).

## The pieces

| Noun | What it is |
| --- | --- |
| the place | `~/Epicenter` on your server: a folder per app, and nothing else |
| an app | a folder whose `epicenter.ts` default-exports `defineApp`: its description, collections, and actions; its name is the folder's |
| a collection | a kind of file in the app, by a path template (`words/{word}.md`) and fields; it gives `list`, `get`, `add`, `set`, `edit`, and `delete` |
| a field | JSON Schema for one value, written with helpers such as `field.text()` |
| an action | something you can ask an app to do: a collection's verb, or one the author writes with `defineAction` |
| a UI | a web page built from the app's `ui/` into `ui/dist/`, served at `/<app>/`, that shows its data and calls its actions over MCP |
| `epicenter` | the program that runs an action in a folder, and `epicenter serve`, which offers every app over MCP |
| a program | software that runs on its own and reads and writes a folder whose shape an app's collections declare: Whispering ([ADR-0889]) |
| a starter | an app's code repository, which someone else takes with `epicenter new --from` |
| a clone | a program's clone of an app's data repository, which pushes to the home and never merges |
| your server | the computer that runs `epicenter serve`, from a terminal or as the Epicenter Mac app ([ADR-0865]); it holds the one copy of each app and runs its actions, and every device reaches it while it is on |
| Git | snapshots on the home, optional `origin` backup, `upstream` for a starter, LFS for binaries |

Programs on the home, including your editor and Claude Code, have the folder.
Programs on other devices ask for actions, or keep a clone and push.

## An app

An app is a Git repository of three kinds of file, each with one author
([ADR-0866]):

```txt
apps/vocab/
  epicenter.ts      the app: its collections and actions          from its starter; yours to change
  ui/               the UI's source, built into ui/dist/        from its starter; yours to change
  README.md         what the app is, for people and agents        from its starter
  data/             the data repository                         yours alone
    words/你好.md    a record, whose path is `words/你好.md`
  node_modules/     installed packages, ignored
  .gitignore
```

A record's path is its path in the data repository, the same in an action, a
UI, history, and a clone ([ADR-0893]).

```ts
import { defineAction, defineApp, defineCollection, field } from '@epicenter/app';

const tasks = defineCollection({
  path: 'tasks/{time}.md',
  description: 'task',
  fields: { title: field.text(), done: field.boolean() },
});

const add = defineAction({
  description: 'Add a task to do',
  input: { title: field.text({ description: 'What to do' }) },
  positional: ['title'],
  annotations: { destructiveHint: false },
  run: ({ title }) => tasks.add({ title }),
});

export default defineApp({
  description: 'Things I mean to do',
  collections: { tasks },
  actions: { ...tasks.actions(), add },
});
```

Tasks' tools are the collection's verbs, `tasks list`, `get`, `add`, `set`,
`edit`, and `delete`, spread at the top so they are the app's own, with `add`
replaced by the one written here. A file's address is its path:
`epicenter tasks set tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md --done`. On
the command line an action's `positional` fields are read by position:
`epicenter tasks add 'Call the bank'`. An action reads and writes through its
collections (`tasks.add`), or through the `folder` (the app's files) it
imports; whatever runs it supplies the folder. A sign-in is a `.local` file in
that folder, which never leaves the computer.
`epicenter.ts` imports `@epicenter/app`, which `epicenter` supplies when it
runs, so the folder needs no install.

A starter is an app with no data: `epicenter new vocab --from <git url>` clones
one and keeps it as the app's `upstream`, and `epicenter update` merges its
later changes and rebuilds the UI; a file that no longer fits its
collection's fields says so whenever it is read. The collections are the
contract between the two: a starter that changes a field owns the change to
files already written.

## How a write happens

**If you have the folder, write the files directly.** The home snapshots pending
changes into Git history. That is true for you in your editor, for Claude Code
on the home, and for Whispering there.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer, and a
UI.

**If you are a program that must work offline, commit in your clone and push.**
The home files the push into `main` as one merge commit: Git merges by line,
and a file it cannot merge takes the later edit whole, with the other kept in
history and named in the app's status ([ADR-0888]).

**History is snapshots, named for the calls** (`tasks: add Call the bank`):
a write call, however it arrives, commits exactly the paths it wrote, holding
the app's lock from its first write to its commit, and `epicenter serve`
snapshots what else is pending and pushes to the app's optional backup every
5 minutes ([ADR-0850], [ADR-0851]). A snapshot that fails leaves the changes
pending and shows in the app's status. Writes to one app take turns at its
lock; a change that depends on what it read goes through `folder.update`, so
two at once never lose a change. Exit codes tell an agent what happened: 0 returned, 1 threw,
2 did not run ([ADR-0867]).

## Where code runs, and how to reach it

Code goes where what it needs is. Recording needs the microphone, so it lives in
Whispering. Searching Gmail needs your sign-in, so it is an action that runs on
your server.

```txt
ssh studio                                   you, then `epicenter …` there
ssh studio epicenter serve --stdio           an agent's MCP server, from any computer
epicenter serve, over your tailnet           your devices: UIs and MCP
```

A command always means the computer it is typed on. `serve` speaks MCP and
serves UIs, and runs each app as its files are on disk, so code you just
changed is what runs (ADR-0880). It signs no one in. Who reaches it is decided
by its host, the computer that runs it: for your server, the tailnet
([ADR-0883]). An agent that changes your apps runs where their files are, such
as Claude Code on your server, which you can drive from your phone.

## UIs

An app's UI ([ADR-0860]) is a web page built from the app's `ui/` into
`ui/dist/` and served at `/<app>/`, that reads and changes the app only by
calling its actions over MCP at `/`. A UI never knows where the actions
run, works in any browser that reaches your server, and keeps nothing of its
own.

| Rung | Interface | Steps up when |
| --- | --- | --- |
| 1 | the terminal, Claude Code, any agent | you want to see or tap, not type |
| 2 | a UI, in a browser | it needs the device in a way a browser does not give |
| 3 | a program of its own, such as Whispering | never |

## How data moves

The home holds each app's one kept copy. Other devices call its actions, or
keep a clone, push to its own branch, and fast-forward to what the home filed.
The home keeps snapshots in Git. `epicenter sync` snapshots pending changes
and pushes to the optional `origin` backup, without pulling or rebasing. A
refused push leaves the backup untouched and appears in the app's status
([ADR-0851]), as does an app with no backup or one that has never received
it. `epicenter serve` does what `sync` does for every app every 5 minutes. An
app made from a starter has `upstream`, which only `epicenter update` fetches;
nothing pushes to it. Binary files a folder tracks go through Git LFS: text is history,
binaries are content. Rebuilt files and `.local` sign-ins stay on the home.

## One ladder

Every app climbs the same ladder, and each rung is optional.

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any program reads and writes it |
| 2. History | Git, `git-lfs`, optional `origin` | local snapshots, optional backup |
| 3. Actions | `epicenter` | its actions in the terminal and for Claude Code |
| 4. Everywhere | `epicenter serve` on your server | every device on your tailnet reaches it; its UIs open in a browser |

The Epicenter Mac app installs rungs 2 to 4 at once: it carries its own Git and
Git LFS and runs `epicenter serve`, so the Mac it is on is your server
([ADR-0865]).

Whispering is whole at rung 1. Mail's actions run where your Gmail sign-in is,
on your server; its files reach every rung.

## Each job, the least powerful form

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare an app | collections in `epicenter.ts`, each a path and fields | it needs a rule: an action |
| Describe a field | JSON Schema | never |
| Change data | edit a file | it needs a rule, a sign-in, or reach |
| An action | a collection's verbs | it needs logic |
| Record what ran | snapshots named for the calls known to the home | never |
| Share data between programs | the folder | never |
| Move data | Git | never |
| Big files | `.gitattributes` | never |
| Reach | MCP | never |
| An interface | Claude or the terminal | it needs to be seen: a UI |
| Run something later | someone asks | never |

**Refused:** a sync engine, schedules, a merge that can stop or that writes
anything but the merged files, conflict markers or conflict files, a schema
language of its own, an API beside MCP, programs that ship `epicenter`, an
Epicenter app on every device holding a copy of each app, a catalog of apps,
Epicenter holding third-party credentials, a folder kept in a browser, a
browser that runs actions, and running other people's code in isolates or
Durable Objects.

**Later, each when something needs it:** reminders as an ordinary app; a
hosted Epicenter, for people who cannot keep a computer on; moving the vault
into `~/Epicenter`, and its history into LFS.

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
[ADR-0850]: adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md
[ADR-0851]: adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md
[ADR-0857]: adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md
[ADR-0860]: adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md
[ADR-0861]: adr/0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md
[ADR-0864]: adr/0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md
[ADR-0865]: adr/0865-the-epicenter-mac-app-runs-epicenter-serve-so-the-computer-it-is-on-is-your-server.md
[ADR-0866]: adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md
[ADR-0867]: adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md
[ADR-0887]: adr/0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md
[ADR-0888]: adr/0888-the-host-merges-with-gits-line-merge-and-a-file-it-cannot-merge-takes-the-later-side-whole.md
[ADR-0889]: adr/0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md
[ADR-0893]: adr/0893-a-records-path-is-its-path-in-the-apps-data-repository.md
[ADR-0883]: adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md

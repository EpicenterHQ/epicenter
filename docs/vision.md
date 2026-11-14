# Vision

**You keep one computer switched on, and what you want to hold onto ends up
there as plain text files: tasks, reading notes, vocabulary. Some of it you
write there directly. Some of it comes from elsewhere, like your email, and
that computer fetches a copy. You reach all of it from your phone or laptop,
and so do your agents.**

Epicenter is where one person's software lives. `~/Epicenter` is on a computer
you control and keep on, owned or rented: the home. It holds a folder per app:
one TypeScript file that declares the app's data and actions, and a `data/`
folder of files a person can read, mostly Markdown, in Git. One command,
`epicenter serve`, offers every app's actions over MCP, and each app's UI in a
browser, to every device on your tailnet. Nothing syncs and no one signs in:
your other devices are thin clients of the one copy, and `origin` is a
push-only backup.

This page is the front door. [ADR-0896] and [ADR-0898] state the rules below;
[ADR-0840] records why the direction changed from the folder sync product, and
[ADR-0897] why hosted Notes waits. [Architecture](architecture.md),
[CONTEXT](CONTEXT.md), and the package READMEs describe the code that exists,
which is mostly the earlier product described at the end.

## The rules

1. **File over app.** What a person makes is plain files in a documented
   shape. Any program that writes that shape is a valid writer and needs no
   Epicenter ([ADR-0889]).
2. **Each collection has one writer of record within an Epicenter:** its
   folder, or a source: a service, or a program's folder. Epicenter never
   reconciles two writable copies.
3. **Have the folder, write files; otherwise ask an action.** Actions exist
   for reach, rules, and sign-ins.
4. **Commit what the person made.** A copy of data whose truth is elsewhere
   is written only by its pull, whoever runs it. Keep it `.local` when the
   source can send it again; commit it as Markdown when the person would want
   it after the source is gone.

## Where a collection's truth is

| Form | Where a write counts | How Epicenter's copy keeps up | Collections today |
| --- | --- | --- | --- |
| Kept | this Epicenter's folder | it is the truth | Tasks, Reading, Vocab, Capture, Mail's proposals, Messages' drafts |
| Cached | a source: a service, or a program's folder | its pull copies it | Mail's mailbox (`.local` SQLite); Whispering's recordings brought home |
| Live | a service | nothing is copied; the app asks each time | Messages' conversations in Beeper |

These words describe; they are not API. No collection declares its form, and
`serve` acts on none.

Live is the cheapest form, for a service that answers quickly, data too
private to copy, or data that changes faster than a pull. An app caches only
when it needs search, reading while the source is away, or history. What the
person makes is kept by default.

A pull uses whatever its source offers, from the most hostile to the
friendliest: a requested export, listing everything and comparing, a change
feed with a cursor (Gmail's `history.list`), or the source pushing changes.

`origin` is a backup, never a truth: one writer pushes to it, and no writer
pulls from it ([ADR-0851]).

## How apps compose

**What arrives is cached or live. What you decide is kept, keyed by the
source's id. Changing the source is an action.** Mail is the example: an agent
reads the cached mailbox and writes a proposal, and you run `epicenter mail
apply <proposal>`, which changes Gmail and records each outcome ([ADR-0882]).

| Way | What it does | Example |
| --- | --- | --- |
| pull | copies a source's items inward; never writes the source | Gmail, a Todoist inbox, Whispering's folder |
| move | writes a kept record carrying `from: <source>/<id>`, then closes the item at the source | a Todoist item becomes a task, then is completed in Todoist |
| apply | changes the source through an action, then pulls what changed | Mail's `apply` |

An item moves by transfer, never by link: it becomes a record, nothing flows back,
and nothing is kept in step. Copying works only for what is never edited
elsewhere: recordings, arrivals in an inbox, received mail.

Apps never import, call, or subscribe to each other. You or an agent join
them through actions. A move you repeat often becomes a prompt, then an action
in a personal app. Scheduling belongs to the home: launchd, cron, or an
agent's routine may call `epicenter <app> <action>`.

| You want | Reach for |
| --- | --- |
| a new kind of thing about the same subject, under the same rules | a collection in the existing app |
| a new source, sign-in, or contract with its own lifetime | a new app |
| something that crosses apps | an agent, then an action in a personal app |

For an app's shape, copy the nearest example: Tasks for a kept collection,
Mail for a cached one, Messages for a live one.

## Ways in

`~/Epicenter/apps` on the home holds a folder per app, each two Git
repositories: its code, and its `data/` ([ADR-0877]).
For the author, the home is the Mac Studio.

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <action>` | the command, opening the folder directly | you, agents with a shell |
| `epicenter serve` | MCP at `/`, the launcher for a browser, and each app's UI at `/<app>/` | Claude Code, Claude Desktop, any agent on your tailnet; UIs in a browser |
| the files | the folder itself | your editor, Claude Code on the home, a program that writes the contract |

Capture, Vocab, agents, and UIs keep nothing on a device and see the current
files when they reach the home. `epicenter serve` runs the `epicenter.ts` of
each app you trust, and Epicenter holds no third-party credentials: Mail's
Google sign-in is a `.local` file in Mail's folder, on the computer that runs
Mail's actions, and never leaves it ([ADR-0870]).

Agents make apps: you start Claude Code on the home, ask for an app, and it
writes the folder. An app can also start as a copy of another app's code:
`epicenter new <name> --from <git url>` copies it into a repository of your
own, with no data and no remote. `<git url>#<folder>` takes one folder of a
repository that holds several apps, and a path on the same computer names
the app's folder itself. No command merges later changes. Your agent reads
what changed where the code came from and takes what you want ([ADR-0904]).

## What it is like

- **Receipts.** You ask Claude Code to find last month's receipts for a
  friend. It runs `epicenter mail search 'receipt after:2026/09/01'` and reads
  a few with `epicenter mail show --attachments`. Gmail is unchanged.
- **The inbox.** An agent searches the cached mailbox and writes a proposal
  to archive 600 newsletters, one line per message. You delete the lines for
  mail you want to keep and run `epicenter mail apply <proposal>`. If Gmail
  fails partway, the next apply retries what failed.
- **A vault script becomes an action.** The calendar script in your vault
  becomes `epicenter vault calendar show`. Later Claude Code changes how it
  groups events in a worktree, tries it with `epicenter ./worktree calendar
  show`, and merges.
- **A capture from the phone.** You open Capture's UI in your phone's browser
  at `/capture/` and save a quote. The UI calls `capture_add`; the home
  writes `captures/<time>.md` and snapshots it.
- **Tasks from anywhere.** You add a task on the phone through Tasks' UI. You
  also drop things into Todoist from your watch; an agent pulls that inbox,
  adds each item worth keeping with `epicenter tasks add`, and completes it in
  Todoist. Todoist stays near empty, and Tasks is the list.
- **A recording on a plane.** Whispering on your laptop records, transcribes,
  and pastes with no network, and keeps each recording, with its audio, in
  its own folder ([ADR-0894], Proposed). It needs no Epicenter, and no
  account: an Epicenter account only unlocks paid models. If you point its
  folder into `~/Epicenter/apps/whispering/data`, or copy new files there with
  a file syncer, the recordings appear for your agents. A later Whispering may
  hand each new recording over to your home once it can reach it, and from
  then on every device sees and edits it there ([ADR-0900], Proposed).
- **A weekly summary.** You ask an agent for a summary of your voice notes. It
  adds a `summaries` collection and a `summarize-week` action to
  Whispering's inside app. Whispering keeps writing recordings and never
  notices.

## The pieces

| Noun | What it is |
| --- | --- |
| Epicenter | your folder of apps, `~/Epicenter` on the home, together with the command that serves it; "your Epicenter" and "an Epicenter" mean one person's |
| an inside app | a folder in `~/Epicenter/apps` that runs on the home, whose `epicenter.ts` default-exports `defineApp`: its description, collections, and actions; its name is the folder's; bare "app" on this page, in records, and in code means this |
| a collection | a kind of record in the app, by a path template (`words/{word}.md`) and fields; it gives six actions: `list`, `get`, `add`, `set`, `edit`, and `delete` |
| a record | one file in a collection, addressed by its path; it is yours |
| an item | one thing at a source that is not a record yet: a message in Gmail, a row in Todoist |
| a field | JSON Schema for one value, written with helpers such as `field.text()` |
| an action | something you can ask an app to do: one of a collection's six, or one the author writes with `defineAction`; it is a command in the terminal and a tool over MCP |
| a UI | a web page built from the app's `ui/` into `ui/dist/`, served at `/<app>/`, that shows its data and calls its actions over MCP |
| `epicenter` | the command: it runs an action in a folder, and `epicenter serve` offers every app over MCP |
| a personal app | an app you made to join other apps: it holds the actions that cross them |
| an outside app | any software that works without an Epicenter: Whispering, Gmail, Beeper, Todoist, a notes product; it is one of two kinds, a program or a service |
| a program | an outside app that runs on your device: Whispering; the friendliest writes files in the shape an inside app's collections declare, in its own folder, and none has to |
| the home | the computer your Epicenter is on, which you control: it runs `epicenter serve` from a terminal, as a job the OS keeps running ([ADR-0878]), or as Epicenter for Mac ([ADR-0865]); you own it or rent it, and a rented one puts your files and sign-ins in its provider's hands; Epicenter never supplies it |
| a service | an outside app that runs on someone else's servers and holds the truth of its own data: Gmail, a hosted notes service |
| a source | where a pull copies from: a service, or a program's folder |
| Git | snapshots on the home, optional `origin` backup, the first commit of copied code naming where it came from, LFS for binaries |

Every app is inside an Epicenter or outside it. The test: does it work
without an Epicenter? If it does, it is an outside app. Data crosses only
through an inside app's actions: Mail brings Gmail in, and Gmail does nothing.
A product can have both halves: Whispering is an outside app, and Whispering's
inside app is the `whispering` folder in an Epicenter ([ADR-0901]).

"Epicenter" is the place, and `epicenter` is its command. "Server" means
someone else's computer, and "hosted" means someone else runs it; yours is the
home, and an inside app runs on the home.

Epicenter, the company, makes several products. Epicenter is the home-first
one. The others stand alone and choose their own data model, and each has its
own name: Whispering is standalone, and a hosted notes service would not be
called Epicenter and would sit beside the vault, not replace it. Each is an
outside app, and an Epicenter can bring any of them in, the way Mail brings in
Gmail. "Local-first" is only for a product whose devices sync.

## An app

An app is its `epicenter.ts` over its data. `epicenter.ts` is the contract,
and a UI is one view of it that can be replaced. On disk an app is a code
repository with a data repository inside it ([ADR-0877], [ADR-0904]):

```txt
apps/vocab/
  epicenter.ts      the app: its collections and actions          yours to change, written here or copied
  ui/               the UI's source, built into ui/dist/        yours to change, written here or copied
  README.md         what the app is, for people and agents
  data/             the data repository                         yours alone; never copied
    words/你好.md    a record, whose path is `words/你好.md`
  node_modules/     installed packages, ignored
  .gitignore
```

A record's path is its path in the data repository, the same in an action, a
UI, and history ([ADR-0893]).

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

Tasks' actions are the collection's six, `tasks list`, `get`, `add`, `set`,
`edit`, and `delete`, with `add` replaced by the one written here. A record's
address is its path:
`epicenter tasks set tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md --done`. On
the command line an action's `positional` fields are read by position:
`epicenter tasks add 'Call the bank'`. An action reads and writes through its
collections, or through the `folder` it imports; whatever runs it supplies the
folder. `epicenter.ts` imports `@epicenter/app`, which `epicenter` supplies
when it runs, so the folder needs no install.

## How a write happens

**If you have the folder, write the files directly.** The home snapshots
pending changes into Git history. That is true for you in your editor, for
Claude Code on the home, and for a program writing there.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer, and a
UI.

**History is snapshots, named for the actions** (`tasks: add Call the bank`):
an action that writes commits exactly the paths it wrote, holding the app's
lock from its first write to its commit, and `epicenter serve` snapshots what else is
pending and pushes to the app's optional backup every 5 minutes ([ADR-0850],
[ADR-0851]). A change made outside an action is committed as "changed outside
epicenter". Exit codes tell an agent what happened: 0 returned, 1 threw, 2 did
not run ([ADR-0867]).

## Where code runs

Code goes where what it needs is. Recording needs the microphone, so it lives
in Whispering. Searching Gmail needs your sign-in, so it is an action that
runs on the home.

```txt
ssh studio                                   you, then `epicenter …` there
ssh studio epicenter serve --stdio           an agent's MCP server, from any computer
epicenter serve, over your tailnet           your devices: UIs and MCP
```

A command always means the computer it is typed on. `serve` runs each app as
its files are on disk, so code you just changed is what runs ([ADR-0880]). It
signs no one in; the home decides who reaches it, for the author the tailnet
([ADR-0883]).

## UIs

An app's UI ([ADR-0860]) is a web page served at `/<app>/` that reads and
changes the app only by calling its actions. It never knows where they run and
keeps nothing of its own.

## One ladder

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any software reads and writes it |
| 2. History | Git, `git-lfs`, optional `origin` | local snapshots, optional backup |
| 3. Actions | `epicenter` | its actions in the terminal and for Claude Code |
| 4. Everywhere | `epicenter serve` on the home | every device on your tailnet reaches it; its UIs open in a browser |

Epicenter for Mac installs rungs 2 to 4 at once ([ADR-0865]). Whispering
is whole at rung 1.

## Each job, the least powerful form

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare an app | collections in `epicenter.ts` | it needs a rule: an action |
| Describe a field | JSON Schema | never |
| Change data | edit a file | it needs a rule, a sign-in, or reach |
| Reach a service's data | ask it each time | it needs search, offline reading, or history: a pull |
| Join two apps | an agent | the steps are stable: an action in a personal app |
| Record what ran | snapshots named for the actions | never |
| Move data | Git | never |
| Reach | MCP | never |
| An interface | Claude, any agent, or the terminal | you want to see or tap: a UI. It needs the device in a way a browser does not give: a program of its own, such as Whispering |
| Run something later | the home's scheduler runs an action | never |

## Next, not yet, and never

**Next, in order, each tied to its need** ([ADR-0898]):

1. The vault as a folder app, served from the home and used from the phone for
   a month ([ADR-0897]).
2. An `add` that answers done for the same id and content.
3. Files beside a record, for audio and attachments.
4. Freshness in each pull's status.
5. Which kind of caller wrote, a person or an agent, so an action can be
   refused to agents.

**Not yet; each needs the owner's yes:** a program handing its new records
over to a home, which then holds them ([ADR-0900], Proposed), and a phone
queueing its adds the same way; moving a
collection's truth; a published protocol for third parties; `serve` running
pulls on a clock; Epicenter hosting any service.

**Never:** reconciling two writable copies or keeping two lists in step; a
queue of edits made while the truth was unreachable; an event bus, triggers,
or a workflow engine between apps; a scheduler of its own; a hosted home; a
collection form that `serve` acts on; conflict markers or conflict files; an
Epicenter app on every device holding a copy of each app; a folder kept in a
browser; Epicenter holding third-party credentials; running other people's
code in isolates or Durable Objects; Yjs or any CRDT in Epicenter.

**Hosted Notes** is a product beside Epicenter, not an Epicenter app, and
waits for the month's evidence ([ADR-0897]). If it is built, from an
Epicenter it is a cached collection, like Gmail.

## What came before

Records [ADR-0802] to [ADR-0839] designed a folder sync product for many
people: folders kept the same on every device and with everyone they were
shared with, a server keeping every version, Git at the edges, and web and
phone apps. [ADR-0835] was its register. It stopped because its one user
needed something smaller first, and it is retired ([ADR-0899]); some of its
code is still in this repository until nothing imports it. What carried over: files a person can read, Git as history, one table
of operations rendered as CLI and MCP ([ADR-0827]), and the rule that a note's
fields are written one `key: <JSON>` line each.

[ADR-0802]: adr/0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md
[ADR-0827]: adr/0827-the-cli-and-mcp-render-one-table-of-operations.md
[ADR-0835]: adr/0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md
[ADR-0839]: adr/0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md
[ADR-0840]: adr/0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md
[ADR-0899]: adr/0899-the-folder-sync-product-is-retired.md
[ADR-0850]: adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md
[ADR-0851]: adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md
[ADR-0860]: adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md
[ADR-0865]: adr/0865-the-epicenter-mac-app-runs-epicenter-serve-so-the-computer-it-is-on-is-your-server.md
[ADR-0867]: adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md
[ADR-0870]: adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md
[ADR-0877]: adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md
[ADR-0878]: adr/0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md
[ADR-0880]: adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md
[ADR-0882]: adr/0882-mail-leaves-mail-in-gmail-and-agents-change-it-through-proposals-the-person-applies.md
[ADR-0883]: adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md
[ADR-0889]: adr/0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md
[ADR-0893]: adr/0893-a-records-path-is-its-path-in-the-apps-data-repository.md
[ADR-0894]: adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md
[ADR-0896]: adr/0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md
[ADR-0897]: adr/0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md
[ADR-0898]: adr/0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md
[ADR-0900]: adr/0900-a-program-may-hand-its-new-records-over-to-a-home-which-then-holds-them.md
[ADR-0901]: adr/0901-an-app-is-inside-an-epicenter-or-outside-it.md
[ADR-0904]: adr/0904-copying-is-the-only-way-to-take-an-apps-code.md

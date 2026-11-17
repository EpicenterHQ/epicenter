# Vision

**You keep one computer switched on, and what you want to hold onto ends up
there as plain text files: tasks, reading notes, vocabulary. Some of it you
write there directly. Some of it comes from elsewhere, like your email, and
that computer fetches a copy. You reach all of it from your phone or laptop,
and so do your agents.**

Epicenter is where one person's software lives. `~/Epicenter` is on a computer
you control and keep on: the home. Today that is a computer you own; a rented
one you control is allowed ([ADR-0903]) and gets its own setup later. Each home
uses one private root Git repository. Each apps/<app>/ container holds a code/
Bun project and sibling data/ records, mostly Markdown. One command,
`epicenter serve`, offers every app's actions over MCP, and each app's UI in a
browser, on that computer; your private network brings your other devices in.
Nothing syncs and no one signs in: your other devices are thin clients of the
one copy, and `origin` is a push-only backup. [ADR-0910] records this layout, implemented in the source
and live Epicenter.

This page is the front door. [ADR-0896] and [ADR-0898] state the rules below;
[ADR-0840] records why the direction changed from the folder sync product, and
[ADR-0897] why hosted Notes waits. [Architecture](architecture.md),
[CONTEXT](CONTEXT.md), and the package READMEs describe the code that exists,
which is mostly the earlier product described at the end.

## A computer that stays on

**Your Epicenter lives on a regular computer you keep on.**

It uses that computer's normal filesystem. Your apps, files, and history
live there, and `epicenter serve` makes them available to your agents and, with
a private connection, to your other devices. The computer can be a laptop you
use, an older laptop you repurpose, or a desktop.

`serve` listens only on that computer and signs no one in. Your private network
decides which other devices reach it ([ADR-0927]):

```text
Your phone -------------\
Your other computer ----+-- Private connection -- Computer running Epicenter
Your connected agents --/                         Your apps, files, and history
```

For example, an older laptop can stay plugged in and awake, and
`tailscale serve --bg 4747` gives your devices on your tailnet an HTTPS address
for it. Never expose the port publicly; `serve` refuses Tailscale Funnel.

Agents can run on the home itself or reach its actions from another
connected computer. If the home sleeps or goes offline, your other devices
cannot reach it. For the listener and service setup, see
[the epicenter command](../packages/cli/README.md#a-call-runs-where-it-arrives).

## The rules

1. **File over app.** What a person makes is plain files in a documented
   shape. Any program that writes that shape is a valid writer and needs no
   Epicenter ([ADR-0889]).
2. **Each kind of record has one writer of record within an Epicenter:** its
   folder, or a source: a service, or a program's folder. Epicenter never
   reconciles two writable copies.
3. **Have the folder, write files; otherwise ask an action.** Actions exist
   for reach, rules, and sign-ins.
4. **Commit what the person made.** A copy of data whose truth is elsewhere
   is written only by its pull, whoever runs it. Keep it in the app's `local/`
   when the source can send it again; commit it as Markdown when the person
   would want it after the source is gone.

## Where a record's truth is

| Form | Where a write counts | How Epicenter's copy keeps up | Records today |
| --- | --- | --- | --- |
| Kept | this Epicenter's folder | it is the truth | Tasks, Reading, Vocab, Capture, Mail's proposals, Messages' drafts |
| Cached | a source: a service, or a program's folder | its pull copies it | Mail's mailbox (SQLite in `local/`); Whispering's recordings brought home |
| Live | a service | nothing is copied; the app asks each time | Messages' conversations in Beeper |

These words describe; they are not API. No data key declares its form, and
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
in a personal app. Scheduling belongs to the home: a routine in `routines/`
runs a command on a cron schedule while `serve` runs, and runs once to catch up
after the home was off ([ADR-0908], [ADR-0937]). launchd or cron can call
`epicenter <app> <action>` too.

| You want | Reach for |
| --- | --- |
| a new kind of thing about the same subject, under the same rules | a data key in the existing app |
| a new source, sign-in, or contract with its own lifetime | a new app |
| something that crosses apps | an agent, then an action in a personal app |

For an app's shape, copy the nearest example: `examples/tasks` or
`examples/writing` for kept records. Mail (cached) and Messages (live) are
the author's apps and are not published yet.

## Ways in

`~/Epicenter/apps` holds stable app containers with code/ and data/ siblings
in the source layout ([ADR-0910]). The private root origin backs up both.
For the author, the home is the Mac Studio.

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <action>` | the command, opening the folder directly | you, agents with a shell |
| `epicenter serve` | MCP at `/`, the launcher for a browser, and each app's UI at `/<app>/` | Claude Code, Claude Desktop, any agent on the home or, through your private network, on your other devices; UIs in a browser |
| the files | the folder itself | your editor, Claude Code on the home, a program that writes the contract |

Capture, Vocab, agents, and UIs keep nothing on a device and see the current
files when they reach the home. `epicenter serve` runs the `code/epicenter.ts` of
each app you trust, and no sign-in leaves the home: Mail's Google sign-in is
a file in Mail's `local/`, on the computer that runs Mail's actions
([ADR-0870]).

Agents make apps: you start Claude Code on the home, ask for an app, and it
writes its code and records. An app can start with committed code copied by
`epicenter new --from`, from a folder in Git or `owner/repo/folder` on GitHub,
without a remote or later merge ([ADR-0929]). The agent adapts any later source
changes in place ([ADR-0910]).

## What it is like

- **Receipts.** You ask Claude Code to find last month's receipts for a
  friend. It runs `epicenter mail search '{"query":"receipt after:2026/09/01"}'`
  and reads a few, with their attachments, through `epicenter mail show`.
  Gmail is unchanged.
- **The inbox.** An agent searches the cached mailbox and writes a proposal
  to archive 600 newsletters, one line per message. You delete the lines for
  mail you want to keep and run `epicenter mail apply '{"proposal":"<proposal>"}'`. If Gmail
  fails partway, the next apply retries what failed.
- **A vault script becomes an action.** The calendar script in your vault
  becomes `epicenter vault calendar show`. Later Claude Code changes how it
  groups events in a temporary Epicenter outside the live folder, tests it,
  then applies the code change deliberately.
- **A capture from the phone.** You open Capture's UI in your phone's browser
  at `/capture/` and save a quote. The UI calls `capture_add`; the home
  writes `data/captures/<time>.md`; a checkpoint records pending files later.
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
  adds a `summaries` data key and a `summarize-week` action to
  Whispering's inside app. Whispering keeps writing recordings and never
  notices.

## The pieces

| Noun | What it is |
| --- | --- |
| Epicenter | your folder of apps, `~/Epicenter` on the home, together with the command that serves it; "your Epicenter" and "an Epicenter" mean one person's |
| an inside app | a folder in `~/Epicenter/apps` that runs on the home, whose `code/epicenter.ts` default-exports `defineApp`: its description, data, and actions; its name is the folder's; bare "app" on this page, in records, and in code means this |
| a data key | a kind of record in the app, declared with `defineData`: a folder (`words` holds `data/words/<id>.md`) or one file (`settings.md`), and its fields; it gives the actions it names: `list`, `get`, `add`, `set`, and `delete` |
| a record | one file of a data key, addressed by its path; it is yours |
| an item | one thing at a source that is not a record yet: a message in Gmail, a row in Todoist |
| a field | JSON Schema for one value, written with helpers such as `field.text()` |
| an action | something you can ask an app to do: one a data key gives, or one the author writes with `defineAction`; it is a command in the terminal and a tool over MCP |
| a UI | a web page built from the app's `code/ui/` into `code/ui/dist/`, served at `/<app>/`, that shows its data and calls its actions over HTTP |
| `epicenter` | the command: it runs an action in a folder, and `epicenter serve` offers every app over MCP |
| a personal app | an app you made to join other apps: it holds the actions that cross them |
| an outside app | any software that works without an Epicenter: Whispering, Gmail, Beeper, Todoist, a notes product; it is one of two kinds, a program or a service |
| a program | an outside app that runs on your device: Whispering; the friendliest writes files in the shape an inside app's data declares, in its own folder, and none has to |
| the home | the computer your Epicenter is on, which you control: it runs `epicenter serve` from a terminal or under a job the person sets up ([ADR-0941]); today one you own, and a rented one, later, puts your files and sign-ins in its provider's hands |
| a service | an outside app that runs on someone else's servers and holds the truth of its own data: Gmail, a hosted notes service |
| a source | where a pull copies from: a service, or a program's folder |
| Git | one private root history, sampled checkpoints, optional origin backup, LFS for binaries |

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

An app is a stable container with code and records beside each other
([ADR-0910]):

```txt
apps/vocab/
  code/                 the editable Bun project
    epicenter.ts        data and actions
    README.md           the app's format and use
    package.json  bun.lock
    ui/                 source; ui/dist/ is ignored
    node_modules/       ignored
  data/                 records and settings
    words/你好.md       path: data/words/你好.md
```

A record's address is its path from the container, with data/ included, in an
action, a UI, and the files an agent opens. The proposed data-root API of
[ADR-0893] is not implemented by this layout change.

```ts
import { defineAction, defineApp, defineData, field, timeId } from '@epicenter/app';

const data = defineData({
  tasks: {
    description: 'task',
    fields: { title: field.text(), done: field.boolean() },
  },
});

const add = defineAction({
  description: 'Add a task to do',
  input: { title: field.text({ description: 'What to do' }) },
  annotations: { destructiveHint: false },
  run: ({ title }) => data.tasks.add(timeId(), { title }),
});

export default defineApp({
  description: 'Things I mean to do',
  data,
  actions: { ...data.tasks.actions('list', 'get', 'set'), add },
});
```

Tasks' actions are `tasks list`, `get`, and `set` from its data key, and the
`add` written here. A verb names a record by its id, the file's name:
`epicenter tasks set '{"id":"2026-11-10T09-30-00-000Z-k3x9a2f8","done":true}'`.
On the command line an action's input is one JSON object, as an agent gives
it over MCP: `epicenter tasks add '{"title":"Call the bank"}'`. An action reads and writes through its
data handles, or through the `folder` it imports; whatever runs it supplies the
container. `code/epicenter.ts` imports `@epicenter/app`, which `epicenter` supplies
when it runs. Install other dependencies in code/.

## How a write happens

**If you have the folder, write the files directly.** Root checkpoints record
pending code and records in Git history. That is true for you in your editor, for
Claude Code on the home, and for a program writing there.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer, and a
UI.

**History comes from Git, which the home runs itself.** Actions make no
commits, nothing takes a lock, and one serve runs every action ([ADR-0936],
Proposed). Epicenter has no command that commits: a home that wants automatic
history has a routine that runs a short script of its own, for example every
five minutes ([ADR-0937], [ADR-0940], Proposed). The script commits what is
pending and pushes only to the optional private root origin. Its commits can
contain partial direct edits or part of a running call. Make a named commit before a risky change ([ADR-0910]).
Exit codes say what happened: 0 returned, 1 threw, 2 did not run ([ADR-0867]).

## Where code runs

Code goes where what it needs is. Recording needs the microphone, so it lives
in Whispering. Searching Gmail needs your sign-in, so it is an action that
runs on the home.

```txt
ssh studio                                   you, then `epicenter …` there
ssh studio epicenter <app> <action>           an action from a remote shell
epicenter serve, through tailscale serve     your devices: UIs and MCP
```

A command always means the computer it is typed on. `serve` runs each app as
its files are on disk, so code you just changed is what runs ([ADR-0880]). It
signs no one in and listens only on the home; your private network decides
which other devices reach it, for the author the tailnet ([ADR-0927]).

## UIs

An app's UI ([ADR-0860]) is a web page served at `/<app>/` that reads and
changes the app only by calling its actions. It never knows where they run and
keeps nothing of its own.

## One ladder

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any software reads and writes it |
| 2. History | Git, `git-lfs`, optional `origin` | root checkpoints, optional private backup |
| 3. Actions | `epicenter` | its actions in the terminal and for Claude Code |
| 4. Everywhere | `epicenter serve` on the home, and a private network such as Tailscale | your devices reach it; its UIs open in a browser |

Whispering is whole at rung 1.

## Each job, the least powerful form

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare an app | data keys in `epicenter.ts` | it needs a rule: an action |
| Describe a field | JSON Schema | never |
| Change data | edit a file | it needs a rule, a sign-in, or reach |
| Reach a service's data | ask it each time | it needs search, offline reading, or history: a pull |
| Join two apps | an agent | the steps are stable: an action in a personal app |
| Record pending files | one root checkpoint | a named commit records intent |
| Move data | Git | never |
| Reach | MCP | never |
| An interface | Claude, any agent, or the terminal | you want to see or tap: a UI. It needs the device in a way a browser does not give: a program of its own, such as Whispering |
| Run something later | a routine runs a command on a cron schedule | never |

## Next, not yet, and never

**Next, in order, each tied to its need** ([ADR-0898]):

1. The vault on the current engine: its records as data keys and its
   commands as actions, served from the home and used from the phone for a
   month ([ADR-0897]). Its files moved in on 2026-11-15; its code still runs on
   the retired engine.
2. An `add` that answers done for the same id and content.
3. Files beside a record, for audio and attachments.
4. Freshness in each pull's status.
5. Which kind of caller wrote, a person or an agent, so an action can be
   refused to agents.

**Not yet; each needs the owner's yes:** a program handing its new records
over to a home, which then holds them ([ADR-0900], Proposed), and a phone
queueing its adds the same way; moving a
record's truth; a published protocol for third parties; a rented home's
setup; Epicenter hosting anything new.

**Never:** reconciling two writable copies or keeping two lists in step; a
queue of edits made while the truth was unreachable; an event bus, triggers,
or a workflow engine between apps; a
record form that `serve` acts on; conflict markers or conflict files; an
Epicenter app on every device holding a copy of each app; a folder kept in a
browser; a third-party sign-in stored anywhere but the home; running other people's
code in isolates or Durable Objects; Yjs or any CRDT in Epicenter.

**Hosted Notes** is a product beside Epicenter, not an Epicenter app, and
waits for the month's evidence ([ADR-0897]). If it is built, from an
Epicenter it is a cached source, like Gmail.

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
[ADR-0867]: adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md
[ADR-0870]: adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md
[ADR-0877]: adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md
[ADR-0941]: adr/0941-whoever-starts-serve-keeps-it-running.md
[ADR-0880]: adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md
[ADR-0882]: adr/0882-mail-leaves-mail-in-gmail-and-agents-change-it-through-proposals-the-person-applies.md
[ADR-0889]: adr/0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md
[ADR-0893]: adr/0893-a-records-path-is-its-path-in-the-apps-data-repository.md
[ADR-0894]: adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md
[ADR-0896]: adr/0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md
[ADR-0897]: adr/0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md
[ADR-0898]: adr/0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md
[ADR-0900]: adr/0900-a-program-may-hand-its-new-records-over-to-a-home-which-then-holds-them.md
[ADR-0901]: adr/0901-an-app-is-inside-an-epicenter-or-outside-it.md
[ADR-0903]: adr/0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md
[ADR-0904]: adr/0904-copying-is-the-only-way-to-take-an-apps-code.md
[ADR-0908]: adr/0908-serve-runs-the-homes-daily-routines.md
[ADR-0936]: adr/0936-one-serve-per-home-runs-every-action.md
[ADR-0937]: adr/0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md
[ADR-0940]: adr/0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md

[ADR-0910]: adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md
[ADR-0927]: adr/0927-serve-listens-only-on-this-computer.md
[ADR-0929]: adr/0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md

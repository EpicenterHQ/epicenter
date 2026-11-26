# Vision

**You keep one computer switched on, and what you want to hold onto ends up
there as plain text files: tasks, reading notes, vocabulary. Some of it you
write there directly. Some of it comes from elsewhere, like your email, and
that computer fetches a copy. You reach all of it from your phone or laptop,
and so do your agents.**

Epicenter is where one person's software lives. `~/Epicenter` is on a computer
you control and keep on. Today that is a computer you own; a rented
one you control is allowed and gets its own setup later. Your Epicenter, the
folder, is one private Git repository and one program: its root `epicenter.ts`
declares the records and composes the apps. Records live in root `data/`,
mostly Markdown; app code lives in `apps/`; caches live in `.epicenter/`.
One command, `epicenter serve`, offers every app's actions over MCP on that
computer; your private network brings your other devices in. Nothing syncs
and no one signs in: your other devices are thin clients of the one copy,
and `origin` is a push-only backup. `@epicenter/app` implements this layout;
[its README](../packages/app/README.md#a-home) shows it.

This page is the front door. Its core invariants state what Epicenter
promises and what it gives up. The package READMEs describe the code that
exists.

## A computer that stays on

**Your Epicenter lives on a regular computer you keep on.**

It uses that computer's normal filesystem. Your apps, files, and history
live there, and `epicenter serve` makes them available to your agents and, with
a private connection, to your other devices. The computer can be a laptop you
use, an older laptop you repurpose, or a desktop.

`serve` listens only on that computer and signs no one in. Your private network
decides which other devices reach it ([serve's rules](../packages/app/README.md#running-the-home)):

```text
Your phone -------------\
Your other computer ----+-- Private connection -- Computer running Epicenter
Your connected agents --/                         Your apps, files, and history
```

For example, an older laptop can stay plugged in and awake, and
`tailscale serve --bg 4747` gives your devices on your tailnet an HTTPS address
for it. Never expose the port publicly; `serve` refuses Tailscale Funnel.

Agents can run on that computer itself or reach its actions from another
connected computer. If the computer sleeps or goes offline, your other devices
cannot reach it. For the listener, see
[the epicenter command](../packages/app/README.md#the-command-and-serve).
Keeping `serve` running is your job (a terminal, launchd or systemd); Epicenter
writes no service job.

## Core invariants

Epicenter assumes you have one computer you control and keep running. Your other devices reach it. Each kind of record has one place where edits count, and Epicenter never reconciles two writable copies. The software is yours to change. These assumptions determine what Epicenter needs to handle, what it can leave to other tools, and which promises it gives up.

These six commitments guide the design. Epicenter does not need to
anticipate every need because you can change the software and compose it
with other tools.

| Commitment | What it lets us remove | What we give up |
| --- | --- | --- |
| **Your Epicenter lives on one computer you control and keep running.** Your devices and agents reach it through your private connection. | Complete copies and runtimes on every device; distributing your Epicenter's service credentials; a separate sign-in system for it. | Access while the computer is unreachable; automatic failover; public access with separate caller permissions. |
| **Every kind of record has one place where edits count.** That place is your Epicenter's folder or an outside source. | Reconciling independently writable copies, merge policies, conflict files, and offline edit queues. | Editing both a source and its copy and expecting them to converge. Copies may be stale; a backup is never a second writable Epicenter. |
| **One running Epicenter process executes every action.** The terminal, browser, and agents all call it. | Separate CLI execution and fallback; cross-process action locks and their waits. | Actions while `serve` is stopped; process isolation between apps; automatic transactions across a whole action. |
| **What you make belongs in files you can use without Epicenter.** Apps record lasting outcomes; Git keeps their history. | Mandatory SDK access to records; a second platform store for run histories, replay, and receipts. | Automatic recovery of unsaved progress after a reload; an automatic audit of every attempt. An app saves any receipt it needs. |
| **You can change the software you run.** Apps are editable code that you or your agents can inspect and adapt. You choose which code to trust. | Platform settings and extension systems for every specialized need; sandboxing each trusted app. | Configuring every behavior without code; isolation from a faulty app. You are responsible for what you run. |
| **Epicenter composes tools that already do the job.** Git keeps history, Bun manages packages, and the operating system keeps Epicenter running. | Rebuilding version control, package management, and process supervision. | A platform-managed solution to every operational problem. Some work remains ordinary tool use. |

Six rules are the short form, for checking a proposal. Ask which rule
already answers it. When the answer is that a tool or the owner does the
work, the feature is a line of documentation, not code.

1. Your Epicenter is a folder: one Git repository and one Bun project. Data
   is files in it, and Git is the history. Each record has one place where
   edits count: this folder, or the outside source it copies.
2. Serve is the one program that loads and runs app code. It reads code and
   packages when it starts, and you restart it to change them. The command,
   pages, and agents are its clients.
3. An action takes JSON and answers `{ data, error }`, and it is described
   in plain JSON. What must outlast the call goes in a file.
4. `.epicenter/` keeps itself out of Git. Serve does not yet refuse a `.env` that
   Git would commit, so the owner's `.gitignore` guards it.
5. The code is yours. The only setting is the port.
6. Epicenter does only what needs an app's declaration or the running serve.
   Everything else is a line in a README. One exception: where a skipped
   step fails silently and cannot be undone, Epicenter refuses or reports.
   It never repairs.

A writable copy fails rule 1, and a second action runner fails rule 2.

One place where edits count and one process running actions are different
promises. Actions can overlap while waiting for a service. A platform file
update reads, changes, and replaces one file without yielding; a change
across several files is not a transaction. Direct writers, including
editors, agents, and scripts, must coordinate when they touch the same
records.

Apps save what needs to survive a reload. Progress updates are for whoever
is watching now; configuration, caches, and temporary runtime state still
exist. Git records the commits you make, not every event ([the rules for actions](../packages/app/README.md#actions)).

A specialized app can use a CRDT for concurrent editing and export a saved
representation into Epicenter. The CRDT document owns the live edits; the
exported files are a copy. Editing both independently would bring back the
reconciliation we refuse. An app can also add its own deadline, subprocess,
or receipt without making every app inherit that machinery.

## Working with files

**Have the folder, write files; otherwise ask an action.** Any program that
writes the documented shape is a valid writer and needs no Epicenter. Actions exist for reach, rules, and sign-ins.

**Commit what the person made.** A copy of data whose truth is elsewhere is
written only by its pull, whoever runs it. Keep it under your Epicenter's `.epicenter/`
when the source can send it again; commit it as Markdown when the person
would want it after the source is gone.

## Where a record's truth is

| Form | Where a write counts | How Epicenter's copy keeps up | Records today, in the author's setup |
| --- | --- | --- | --- |
| Kept | this Epicenter's folder | it is the truth | Tasks, Reading, Vocab, Capture, Mail's proposals, Messages' drafts |
| Cached | a source: a service, or a program's folder | its pull copies it | Mail's mailbox (SQLite in `.epicenter/`) |
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
pulls from it.

## How apps compose

**What arrives is cached or live. What you decide is kept, keyed by the
source's id. Changing the source is an action.** Mail is the example: an agent
reads the cached mailbox and writes a proposal, and you run `epicenter mail
apply <proposal>`, which changes Gmail and records each outcome.

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
in a personal app. Your home declares [scheduled actions](../packages/app/README.md#scheduled-actions)
in `epicenter.ts`. Serve calls them while it runs.

| You want | Reach for |
| --- | --- |
| a new kind of thing about the same subject, under the same rules | a data key in your Epicenter's `epicenter.ts`, and actions in the existing app |
| a new source, sign-in, or contract with its own lifetime | a new app |
| something that crosses apps | an agent, then an action in a personal app |

For an app's shape, start from the `writing` example in
[`@epicenter/app`'s README](../packages/app/README.md#a-home). This
repository ships no inside apps; Mail (cached) and Messages (live) are the
author's and are not published.

## Ways in

`~/Epicenter` holds your Epicenter's `epicenter.ts`, its apps' code in `apps/`, and
its records in `data/`. The private root origin backs up all three.
For the author, the computer is a Mac Studio.

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <action>` | the command, sending its call to your Epicenter's running `serve` | you, agents with a shell |
| `epicenter serve` | MCP at `/`, actions at `/actions/<app>/<action>`, and the listing at `/actions/` | Claude Code, Claude Desktop, any agent on that computer or, through your private network, on your other devices |
| the files | the folder itself | your editor, Claude Code on that computer, a program that writes the contract |

An agent on another device keeps no copy; it sees the current files each time
it calls your computer. `epicenter serve` imports your Epicenter's one `epicenter.ts`, which
composes the apps you trust, and no sign-in leaves the computer: Mail's Google
sign-in is a file under `.epicenter/`, on the computer that runs Mail's actions.

Agents make apps: you start Claude Code on that computer, ask for an app, and it
writes its code in `apps/`, its data keys in `epicenter.ts`, and its records.
An app can also start as a copy of another Epicenter's `apps/<app>/` folder, taken
with ordinary file tools and kept without a remote or later merge (no command
copies an app: [the package's rules](../packages/app/README.md#the-home)). The
agent adds the data keys it reads and adapts any later source changes in
place.

## What it is like

These come from the author's own setup. Mail, Capture, Tasks and Todoist are the
author's apps and do not ship here.

- **Receipts.** You ask Claude Code to find last month's receipts for a
  friend. It runs `epicenter mail search '{"query":"receipt after:2026/09/01"}'`
  and reads a few, with their attachments, through `epicenter mail show`.
  Gmail is unchanged.
- **The inbox.** An agent searches the cached mailbox and writes a proposal
  to archive 600 newsletters, one line per message. You delete the lines for
  mail you want to keep and run `epicenter mail apply '{"proposal":"<proposal>"}'`. If Gmail
  fails partway, the next apply retries what failed.
- **A capture from the phone.** You ask the agent on your phone, connected to
  your computer over MCP, to save a quote. It calls `capture_add`; your Epicenter writes
  `data/captures/<time>.md`, and your next commit records it.
- **Tasks from anywhere.** You add a task on the phone through an agent. You
  also drop things into Todoist from your watch; an agent pulls that inbox,
  adds each item worth keeping with `epicenter tasks add`, and completes it in
  Todoist. Todoist stays near empty, and Tasks is the list.
- **A recording on a plane.** Whispering on your laptop records, transcribes,
  and pastes with no network, and keeps each recording as files in its own
  folder ([Whispering's decisions](../apps/whispering/README.md#the-folder)). It
  needs no Epicenter and no account. Point that folder at `~/Epicenter/data` and
  declare data keys for its notes, and an agent can read the notes and
  transcripts as records. Audio waits for files beside a record, which is not
  built yet.

## The pieces

| Noun | What it is |
| --- | --- |
| Epicenter | the folder `~/Epicenter` on your computer, together with the command that serves it; "your Epicenter" and "an Epicenter" mean one person's |
| an inside app | a function of your Epicenter's data, usually in `~/Epicenter/apps/<app>/`, that returns its description and actions; the root `epicenter.ts` composes it into `defineEpicenter({ apps })`, and its key there is its name; bare "app" on this page, in records, and in code means this |
| a data key | a kind of record in your Epicenter, declared in the root `epicenter.ts` with `defineData`: a folder (`words` holds `data/words/<id>.md`) and its fields; its handle has `list`, `get`, `create`, `patch`, `edit`, and `delete`, which an app's actions call |
| a record | one file of a data key, addressed by its path; it is yours |
| an item | one thing at a source that is not a record yet: a message in Gmail, a row in Todoist |
| a field | JSON Schema for one value, written with helpers such as `field.text()` |
| an action | something you can ask an app to do, written with `defineAction`; it is a command in the terminal and a tool over MCP |
| an app's page | a web page that shows an app's data and calls its actions over HTTP; [not built yet](../packages/app/README.md#not-built-yet) |
| `epicenter` | the command: it sends an action to your Epicenter's running `serve`, which offers every app over MCP and HTTP |
| a personal app | an app you made to join other apps: it holds the actions that cross them |
| an outside app | any software that works without an Epicenter: Whispering, Gmail, Beeper, Todoist, a notes product; it is one of two kinds, a program or a service |
| a program | an outside app that runs on your device: Whispering; the friendliest writes files in the shape an inside app's data declares, in its own folder, and none has to |
| your computer | the computer your Epicenter is on, which you control: it runs `epicenter serve` from a terminal or under a job the person sets up ([serve's rules](../packages/app/README.md#running-the-home)); today one you own, and a rented one, later, puts your files and sign-ins in its provider's hands |
| a service | an outside app that runs on someone else's servers and holds the truth of its own data: Gmail, a hosted notes service |
| a source | where a pull copies from: a service, or a program's folder |
| Git | one private root history of the commits you make, optional origin backup, LFS for binaries |

Every app is inside an Epicenter or outside it. The test: does it work
without an Epicenter? If it does, it is an outside app. Data crosses only
through an inside app's actions: Mail brings Gmail in, and Gmail does nothing.
A product can have both halves: Whispering is an outside app, and Whispering's
inside app is the `whispering` app in an Epicenter.

"Epicenter" is the place, and `epicenter` is its command. "Server" means
someone else's computer, and "hosted" means someone else runs it; yours is your
computer, and an inside app runs on it.

Epicenter, the company, makes several products. Epicenter is the one that
lives on your own computer. The others stand alone and choose their own data model, and each has its
own name: Whispering is standalone, and a hosted notes service would not be
called Epicenter and would sit beside the vault, not replace it. Each is an
outside app, and an Epicenter can bring any of them in, the way Mail brings in
Gmail. "Local-first" is only for a product whose devices sync.

## Your Epicenter

App code lives in `apps/`. Records belong to your Epicenter, not to an app, so a record any app or no app writes still has a
place. `data/` is what you would want back if this computer were lost, and
Git keeps its history. `.epicenter/` is what this computer can rebuild or sign
in again, such as a sign-in or a copy of a mailbox, and it never leaves
this computer. [The package README](../packages/app/README.md#a-home) shows the layout
and a complete app; that README is the one place the mechanics are written
down.

## How a write happens

**If you have the folder, write the files directly.** Your next commit records
code and records together in Git history. That is true for you in your editor, for
Claude Code on that computer, and for a program writing there.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer, and,
once it is built, an app's page.

**History comes from Git, which you run.** Nothing in Epicenter commits or
pushes. What you have not committed is in neither its history nor its
backup, so make a named commit before a risky change
([the rules for actions](../packages/app/README.md#actions)).

## Where code runs

Code goes where what it needs is. Recording needs the microphone, so it lives
in Whispering. Searching Gmail needs your sign-in, so it is an action that
runs on your computer. One `serve` there runs every action
([running `serve`](../packages/app/README.md#running-the-home)).

## Pages

An app's page, a web page that reads and changes the app only by calling its
actions, is [not built yet](../packages/app/README.md#not-built-yet). What a
person or an agent does is still an action.

## One ladder

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any software reads and writes it |
| 2. History | Git, `git-lfs`, optional `origin` | the commits you make, optional private backup |
| 3. Actions | `epicenter serve` running on your computer | the CLI and agents call its actions |
| 4. Everywhere | a private network such as Tailscale | your other devices and their agents reach it |

Whispering is whole at rung 1.

## Each job, the least powerful form

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare records | data keys in your Epicenter's `epicenter.ts` | it needs a rule: an action in an app |
| Describe a field | JSON Schema | never |
| Change data | edit a file | it needs a rule, a sign-in, or reach |
| Reach a service's data | ask it each time | it needs search, offline reading, or history: a pull |
| Join two apps | an agent | the steps are stable: an action in a personal app |
| Record history | a commit you make | never |
| Back up your Epicenter | Git and an optional private origin | never |
| Reach | MCP | never |
| An interface | Claude, any agent, or the terminal | you want to see or tap: an app's page, not built yet. It needs the device in a way a browser does not give: a program of its own, such as Whispering |
| Run something later | a scheduled action in `epicenter.ts` | catch-up after downtime |

## Next, not yet, and never

**Next, in order, each tied to its need**:

1. The vault on the current engine: its records as data keys and its
   commands as actions, served from your computer and used from the phone for a
   month. Its files moved in on 2026-11-15; its code still runs on
   the retired engine.
2. An `add` that answers done for the same id and content.
3. Files beside a record, for audio and attachments.
4. Freshness in each pull's status.
5. Which kind of caller wrote, a person or an agent, so an action can be
   refused to agents.

**Not yet; each needs the owner's yes:** a program handing its new records
over to your Epicenter, which then holds them, and a phone
queueing its adds the same way; moving a
record's truth; a published protocol for third parties; a rented computer's
setup; Epicenter hosting anything new.

**Never:** reconciling two writable copies or keeping two lists in step; a
queue of edits made while the truth was unreachable; an event bus, triggers,
or a workflow engine between apps; a
record form that `serve` acts on; conflict markers or conflict files; an
Epicenter app on every device holding a copy of each app; a folder kept in a
browser; a third-party sign-in stored anywhere but your computer; running other people's
code in isolates or Durable Objects; a built-in CRDT or a platform protocol
for reconciling editable copies. An app may use a specialized collaboration
tool while keeping one place where its edits count.

**Hosted Notes** is a product beside Epicenter, not an Epicenter app, and
waits for the month's evidence. If it is built, from an
Epicenter it is a cached source, like Gmail.

## What came before

Records ADR-0802 to ADR-0839 designed a folder sync product for many
people: folders kept the same on every device and with everyone they were
shared with, a server keeping every version, Git at the edges, and web and
phone apps. ADR-0835 was its register. It stopped because its one user
needed something smaller first, and it is retired; some of its
code is still in this repository until nothing imports it. What carried over: files a person can read, Git as history, one table
of operations rendered as CLI and MCP, and the rule that a note's
fields are written one `key: <JSON>` line each.

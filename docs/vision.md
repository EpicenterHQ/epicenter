# Vision

**Bring the parts of your life you want to keep into one folder on a computer
you control. Use your own apps to work with them, from your phone, your laptop,
or with an agent. Keep the work in files you can take with you.**

Epicenter is where one person's software lives. Anyone who can reach its
computer can do everything in it, so people who share an Epicenter share
everything; separate access means a separate Epicenter. `~/Epicenter` is on a computer
you control and keep on. Today that is a computer you own. A rented
one you control is allowed and gets its own setup later. Your Epicenter, the
folder, is one private Git repository and one Bun project: its root `epicenter.ts`
declares the file-backed records and composes the apps. `epicenter serve` runs
their actions on that computer. Your private network brings your other devices
in. The package README shows the layout and a complete app.
[Your Epicenter](../packages/app/README.md#a-home)

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

## Who can read your files

**Whoever can read your computer can read your Epicenter.** On a computer you
own, that is you and whatever you let in: a user account, a backup tool, an
agent you give a shell. On a rented computer, the provider can also read the
disk and its snapshots, `.epicenter/` included. Epicenter relies on the
computer for encryption at rest.

**Whoever reaches `serve` can do everything.** It signs no one in, so anything
that reaches it can call every action of every app. There are no roles or
per-person permissions inside an Epicenter. A team whose members trust each
other equally can share one; people who need separate access each run their
own, and an agent can connect to several. Never tunnel the port: `serve`
refuses the tunnels it recognizes, but one it cannot recognize would reach it
with no sign-in.

**The code you run is trusted.** `serve` imports every app into one process
with your privileges and no sandbox. An app you copy from someone else runs
its author's code, so read it as you would any program you install.

**Copies elsewhere follow their own access.** Whoever hosts your Git backup
can read what you push. A device that keeps an app's offline copy exposes it
to whoever can read that device's browser storage. A model endpoint sees what
you send it.

## Core invariants

Six rules determine what Epicenter needs to handle, what it can leave to
other tools, and which promises it gives up. Epicenter does not need to
anticipate every need because you can change the software and compose it
with other tools.

| Rule | What it lets us remove | What we give up |
| --- | --- | --- |
| 1. **Your Epicenter is a folder, and every kind of record has one source of truth.** The folder is one Git repository and one Bun project. See [where edits count](#where-edits-count). | Reconciling independent stores that both claim to hold the same record. | Editing both an app's live data and its export and expecting the edits to merge. |
| 2. **One running `serve` loads and runs all app code.** It reads code and packages when it starts, and you restart it to change them. The command, UIs, and agents are its clients. | Separate CLI execution and fallback; cross-process action locks and their waits. | Actions while `serve` is stopped; process isolation between apps; automatic transactions across a whole action. |
| 3. **What you make belongs in files you can use without Epicenter.** An action takes JSON and answers `{ data, error }`, and it is described in plain JSON. What must outlast the call goes in a file, and Git keeps its history. | Mandatory SDK access to records; a second platform store for run histories, replay, and receipts. | Automatic recovery of unsaved progress after a reload; an automatic audit of every attempt. An app saves any receipt it needs. |
| 4. **Your Epicenter lives on one computer you control and keep running.** Your devices and agents reach it through your private connection. Sign-ins and caches stay there: `.epicenter/` keeps itself out of Git. Serve does not yet refuse a `.env` that Git would commit, so the owner's `.gitignore` guards it. | A full Epicenter on every device and a separate sign-in system for it. | Running actions while the computer is unreachable, automatic failover, and public access with separate caller permissions. |
| 5. **The code is yours.** Apps are editable code that you or your agents can inspect and adapt. You choose which code to trust. The only setting is the port. | Platform settings and extension systems for every specialized need; sandboxing each trusted app. | Configuring every behavior without code; isolation from a faulty app. You are responsible for what you run. |
| 6. **Epicenter does only what needs an app's declaration or the running `serve`.** Git keeps history, Bun manages packages, and the operating system keeps `serve` running. Everything else is a line in a README. One exception: where a skipped step fails silently and cannot be undone, Epicenter refuses or reports. It never repairs. | Rebuilding version control, package management, and process supervision. | A platform-managed solution to every operational problem. Some work remains ordinary tool use. |

To check a proposal, ask which rule already answers it. When the answer is
that a tool or the owner does the work, the feature is a line of
documentation, not code. A second source of truth for a record fails rule 1,
and a second action runner fails rule 2.

One place where edits count and one process running actions are different
promises. Actions can overlap while waiting for a service. A platform file
update reads, changes, and replaces one file without yielding; a change
across several files is not a transaction. Direct writers, including
editors, agents, and scripts, must coordinate when they touch the same
records.

Apps save what needs to survive a reload. Progress updates are for whoever
is watching now; configuration, caches, and temporary runtime state still
exist. Git records the commits you make, not every event ([the rules for actions](../packages/app/README.md#actions)).

## Where edits count

Start with a file. Give a record another source of truth when the way you use
it calls for one. These examples describe the author's apps. `serve` runs
their actions the same way in each case.

| Where edits count | How you work with it | What ends up in `data/` |
| --- | --- | --- |
| A file in your Epicenter | Zhongwen's actions read and update its Markdown records. An editor with the folder can also write those files directly in the app's format. | The live record. |
| A store the app owns on your computer | Capture, Notes, and Tasks each use a Yjs document. The home saves it in `.epicenter/apps/<app>/log.bin`. The browser can edit its copy offline and merge changes into the same document when it reconnects. Agents use the app's actions to work with the live document. | The Markdown copy the app writes when you run `materialize`. The next export replaces hand edits to that copy. |
| An outside service or program | Mail applies changes through Gmail. It can pull Gmail's changes since a saved cursor into a local SQLite cache for search. Messages reads conversations from Beeper on demand. | What you choose to keep independently of the source. Mail's saved views are already file-backed records of their own. |

The browser, terminal, and agents can work through actions in all three cases.
Use an action when a write needs the app's rules or a sign-in. A pull refreshes
a working copy from an outside source. Materializing writes portable files
from an app's own live data. Each goes in one direction.

**Recovery means getting your work back after losing the original store.**
For file-backed records, back up the files. For an app with its own store,
back up the store to recover its live state, or export the records to recover
them as files. Loading those files back into the app takes an importer. For
outside data you want to keep, save your own copy while you can still fetch it.

Git records the files you commit. A private `origin` can keep those commits off
the computer as a backup. In the author's home, the commit job runs
`materialize` first. Capture's Git backup gets as far as the last export that
was committed and pushed. A surviving device can sync back the changes its
copy holds.

## How apps compose

**Keep what you make from an outside item with its source ID.** In Mail, a
pull copies messages to the home for reading and search. You queue changes in
the Outbox and run `epicenter mail apply` to send them to Gmail.

| Way | What it does | Example |
| --- | --- | --- |
| pull | copies a source's items inward; never writes the source | Gmail, a Todoist inbox |
| move | writes a kept record carrying `from: <source>/<id>`, then closes the item at the source | a Todoist item becomes a task, then is completed in Todoist |
| apply | changes the source through an action, then pulls what changed | Mail's `apply` |

An item moves by transfer, never by link: it becomes a record, nothing flows back,
and nothing is kept in step. Copying works only for what is never edited
elsewhere: recordings, arrivals in an inbox, received mail.

Apps never import, call, or subscribe to each other. You or an agent join
them through actions. A move you repeat often becomes a prompt, then an action
in a personal app: an app you made to join others, which holds the actions
that cross them. Your home declares [scheduled actions](../packages/app/README.md#scheduled-actions)
in `epicenter.ts`. Serve calls them while it runs.

| You want | Reach for |
| --- | --- |
| a new kind of thing about the same subject, under the same rules | a data key in your Epicenter's `epicenter.ts`, and actions in the existing app |
| a new source, sign-in, or contract with its own lifetime | a new app |
| something that crosses apps | an agent, then an action in a personal app |

For an app's shape, start from the `writing` example in
[`@epicenter/app`'s README](../packages/app/README.md#a-home). This
repository ships no apps for an Epicenter: `apps/whispering` is a program.
Mail (cached) and Messages (live) are the author's and are not published.

## Ways in

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <action>` | the command, sending its call to your Epicenter's running `serve` | you, agents with a shell |
| `epicenter serve` | MCP at `/`, actions at `/actions/<app>/<action>`, and the listing at `/actions/` | Claude Code, Claude Desktop, any agent on that computer or, through your private network, on your other devices |
| the files | the record or its export, depending on [where edits count](#where-edits-count) | your editor, Claude Code on that computer, programs that read or write the app's file format |

An agent on another device can call the home to read a record or run an
action. The home supplies service credentials when an action needs them.
[Who can read your files](#who-can-read-your-files)

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
- **The inbox.** An agent searches the cached mailbox and queues newsletters
  for archive in the Outbox. You review it and press Apply to send the changes
  to Gmail. Any changes Gmail fails to confirm stay in the Outbox.
- **A capture from the phone.** You ask the agent on your phone, connected to
  your computer over MCP, to save a quote. It calls `capture_add`; your Epicenter writes
  `data/captures/<time>.md`, and your next commit records it.
- **Tasks from anywhere.** You add a task on the phone through an agent. You
  also drop things into Todoist from your watch; an agent pulls that inbox,
  adds each item worth keeping with `epicenter tasks add`, and completes it in
  Todoist. Todoist stays near empty, and Tasks is the list.
- **A recording on a plane.** Whispering on your laptop records, transcribes,
  and copies the text with no network, and keeps each recording as files in its own
  data directory ([what Whispering stores](../apps/whispering/README.md#what-it-stores)). It
  needs no Epicenter and no account.
- **A voice reply from the phone.** You record a reply in an app's UI. Its
  action hands the audio to a speech program installed on your computer, run
  as a command with the file's path, and reads the text it prints. Handy does
  this today; Whispering's command line can transcribe a file, and the switch to it is next
  ([the backlog](../BACKLOG.md#whispering-as-a-transcription-engine)).

## The pieces

| Noun | What it is |
| --- | --- |
| Epicenter | the folder `~/Epicenter` on your computer, together with the command that serves it; "your Epicenter" and "an Epicenter" mean one person's |
| your computer | the computer your Epicenter is on, which you control: it runs `epicenter serve` from a terminal or under a job the person sets up ([serve's rules](../packages/app/README.md#running-the-home)); today one you own, and a rented one, later, puts your files and sign-ins in its provider's hands |
| an app | a function of your Epicenter's data, usually in `~/Epicenter/apps/<app>/`, that returns its description and actions; the root `epicenter.ts` composes it into `defineEpicenter({ apps })`, and its key there is its name |
| a data key | a kind of record in your Epicenter, declared in the root `epicenter.ts` with `defineData`: a folder (`words` holds `data/words/<id>.md`) and its fields; its handle has `list`, `get`, `create`, `patch`, `edit`, and `delete`, which an app's actions call |
| a record | one piece of your work, such as a word, note, or task. A file-backed record is one file of a data key |
| an action | something you can ask an app to do, written with `defineAction`; it is a command in the terminal and a tool over MCP |
| a program | software that runs on your device and needs no Epicenter: Whispering; the friendliest writes files in a shape your `epicenter.ts` declares, and none has to |
| a service | software on someone else's servers that holds the truth of its own data: Gmail, Beeper, Todoist |
| a source | where a pull copies from: a service, or a program's folder |
| an item | one thing at a source that is not a record yet: a message in Gmail, a row in Todoist |

An app is code in your Epicenter. Everything else is a program or a
service, and it works without an Epicenter. Data crosses only through an
app's actions or through files in the documented shape: Mail brings Gmail in,
and Gmail does nothing. Whispering is a program. An action can also run a
program as a command and read what it prints. The program still knows nothing
about your Epicenter.

"Epicenter" is the place, and `epicenter` is its command. "Server" means
someone else's computer, and "hosted" means someone else runs it; yours is your
computer, and your apps run on it.

Epicenter, the company, makes several products. Epicenter is the one that
lives on your own computer. The others stand alone and choose their own data model, and each has its
own name: Whispering is standalone, and a hosted notes service would not be
called Epicenter and would sit beside your Epicenter, not replace it. Each
works without an Epicenter, and an Epicenter can bring any of them in, the way
Mail brings in Gmail. "Local-first" is only for a product whose devices sync.

## Where code runs

Code goes where what it needs is. Recording needs the microphone, so it lives
in Whispering. Searching Gmail needs your sign-in, so it is an action that
runs on your computer. One `serve` there runs every action
([running `serve`](../packages/app/README.md#running-the-home)).

## One ladder

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any software can read the files and edit file-backed records |
| 2. History | Git, `git-lfs`, optional `origin` | the commits you make, optional private backup |
| 3. Actions | `epicenter serve` running on your computer | the CLI and agents call its actions |
| 4. Everywhere | a private network such as Tailscale | your other devices and their agents reach it |

Whispering is whole at rung 1.

## Each job, the least powerful form

| Job | Least powerful form | Steps up only when |
| --- | --- | --- |
| Declare records | data keys in your Epicenter's `epicenter.ts` | it needs a rule: an action in an app |
| Describe a field | JSON Schema | never |
| Change a file-backed record | edit the file | it needs a rule, a sign-in, or reach |
| Reach a service's data | ask it each time | it needs search, offline reading, or history: a pull |
| Join two apps | an agent | the steps are stable: an action in a personal app |
| Record history | a commit you make | never |
| Back up your Epicenter | [back up the files and any live app stores you want to recover](#where-edits-count) | never |
| Reach | MCP | never |
| An interface | an agent or the terminal | you want to see or tap: an app's UI, a web page that reads and changes the app only by calling its actions. It needs the device in a way a browser does not give: a program of its own, such as Whispering |
| Run something later | a scheduled action in `epicenter.ts` | catch-up after downtime |

## Next, not yet, and never

**Next, in order, each tied to its need**:

1. The vault, the author's 3,400 pages of plain-file notes, on the current
   engine: its records as data keys and its
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

**Never built into the Epicenter runtime:** reconciling two writable copies or keeping two lists in step; a
queue of edits made while the truth was unreachable; an event bus, triggers,
or a workflow engine between apps; a
record form that `serve` acts on; conflict markers or conflict files; an
Epicenter app on every device holding a copy of each app; a folder kept in a
browser; a third-party sign-in stored anywhere but your computer; running other people's
code in isolates or Durable Objects; a built-in CRDT or a platform protocol
for reconciling editable copies.

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

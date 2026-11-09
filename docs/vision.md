# Vision

Epicenter is where your personal software lives: small apps that you and your
agents make and change, whose data is your files, and which you can use on every
device you own. Each app is a folder in one place, `~/Epicenter`; the
`epicenter` command runs its actions for you and your agents, Claude reaches
them over MCP, and the Epicenter app shows them on your Mac and your phone.

This page is the front door. It describes the design proposed on 2026-11-08 in
[ADR-0849] to [ADR-0857] and reviewed by three independent reviewers before
anything beyond the first kit was built. [ADR-0840] records why the direction
changed, and [ADR-0863] how the phone gets your apps. The [spec](../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
carries the build order and the first app, Mail. [Architecture](architecture.md),
[CONTEXT](CONTEXT.md), and the package READMEs describe the code that exists,
which is mostly the earlier product described at the end.

## In three laws

1. **What's yours is everywhere.** What you and your agents make is files in an
   app's folder, and every copy converges through one meeting place, merged
   field by field ([ADR-0862]). `*.local` and `.cache/` stay where they are.
2. **Everything else is used where it is.** A sign-in, a machine's hardware, a
   service that exists on one machine. An action runs where what it uses is.
3. **Everything you see or ask is an interface to actions.** The terminal, MCP,
   and the palette come from an app's actions; views and prompts are written.

An app is a folder: `epicenter.json` (what its files are), `epicenter.ts` (what
you can do), `views/` (for people), and `prompts/` (for agents). Getting the
folder installs it. Notes merge field by field and never stop a sync, and
anything to repair is on the app's problems list ([ADR-0861], [ADR-0862]).

## The place and the app

`~/Epicenter` is the place: a folder per app, each a Git working copy. The
Epicenter app shows the place, on a Mac and on a phone, where it keeps its own
copy ([ADR-0863]).

| Place | Holds | Runs |
| --- | --- | --- |
| a Mac: `epicenter`, the Epicenter app, Whispering | `~/Epicenter` | everything |
| a phone: the Epicenter app | its own copy of each app | collections, views, an on-device model |
| a browser, claude.ai, Claude on the phone | nothing | nothing; they ask your server |

An app is one of three kinds, by what its actions use:

| Kind | Apps | Where its actions run |
| --- | --- | --- |
| files only | vocab, zhongwen, notes, honeycrisp, capture, tasks, timebox, theark | everywhere, the phone included, offline |
| a service or one machine | mail, messages, photos | on the Mac with the sign-in or the machine; its files show everywhere |
| a device program | whispering, bureaucracy, tabs | in its own program, which writes its folder in the place |

An app has a folder (its short name, `~/Epicenter/notes`), an optional identity
naming its publisher (`so.epicenter.notes`, `com.bradenwong.honeycrisp`), and a
program of its own only if it needs the device. Agents make apps from the root:
you start Claude Code in `~/Epicenter`, ask for an app, and it writes the folder;
the Epicenter app on your phone shows it at its next sync.

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
- **Words on the subway.** You open Vocab in the Epicenter app on your phone
  with no signal, practise, and mark three words known. The app commits on the
  phone and pushes when the train surfaces; your Mac has them at its next sync.
- **A new app by asking.** In `~/Epicenter` you ask Claude Code for a reading
  log. It writes `reading/epicenter.json` and a view, commits, and pushes. That
  evening the Epicenter app on your phone lists Reading, with no build.
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
| the place | `~/Epicenter`: a folder per app, and nothing else |
| an app | a folder whose `epicenter.json` declares its collections and, optionally, its publisher's `id`; an `epicenter.ts` beside it adds actions |
| a collection | a kind of file in the app, by path (`words/{stem}.md`) and fields; it gives `list`, `get`, `set`, and `delete` |
| a field | JSON Schema for one value; in TypeScript, written with helpers such as `field.text()` |
| an action | something you can ask an app to do: a collection's four, or one the author writes with a `run` function |
| a view | an HTML page in the app's folder that shows its data and calls its actions, inside Claude or the Epicenter app |
| `epicenter` | the program that runs an action in a folder |
| the Epicenter app | the program that shows the place on a Mac and a phone: every app's actions, its views, and sync |
| a device program | an app's own program, when it needs the device: Whispering |
| your server | a computer you keep on, needed by places that hold no copy and by actions that use what is on it: a sign-in kept there, Beeper |
| Git | history, `origin` where copies meet, `upstream` where code came from, LFS for binaries |

Everything else is a program that either has the folder or asks for actions:
your editor, Claude Code, Whispering, and the Epicenter app have it; Claude
Desktop, claude.ai, and a browser ask.

## An app

```txt
vocab/
  epicenter.json          id, description, collections
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
  "id": "com.bradenwong.vocab",
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
change was.** That is true for you in your editor, for Claude Code, for
Whispering, and for the Epicenter app.

**If you do not, or the write needs a sign-in or an app's rule, ask for an
action.** That is true for Claude Desktop, an agent on another computer,
claude.ai, and a browser.

**An action changes files and commits only if its author says so.** `run` calls
`folder.commit('Add 12 words')` when one run is one change; otherwise what it
wrote waits for you, your agent, or `epicenter sync` to commit it. Exit codes
tell an agent what happened: 0 returned, 1 threw, 2 did not run.

## Where code runs, and how to reach it

Code goes where what it needs is. Recording needs the microphone, so it lives in
Whispering. Searching Gmail needs your sign-in, so it is an action that runs on
your server.

```txt
ssh studio                                          you, then `epicenter …` there
ssh studio epicenter serve --stdio                  an agent's MCP server, from any computer
epicenter vocab define serendipity                  this computer's copy of Vocab; never forwarded
```

A command always means the computer it is typed on. `serve` speaks MCP and
nothing else, and runs each call in a fresh process, so code you just pulled is
what runs. **Claude and ChatGPT on your phone, and claude.ai, do not reach
your apps yet**: they connect from their vendors' clouds and need a public
address with a sign-in, which comes when you want one of them; your phone itself
has the Epicenter app. Until
then, nothing guards your sign-ins from another program running as you except
your agents' permission rules.

## Views

An app's interfaces are views ([ADR-0860]): HTML in its `views/` folder, from
one page to a whole single-page app, that reads and changes the app only by
calling its actions. A view is an MCP App, so the same file shows inside a
Claude conversation when an action names it, full screen in the Epicenter app
on your Mac or phone, and as plain text in a terminal. A view never knows where
the actions run: in the Epicenter app against its own copy, offline included; in
`epicenter` on a Mac; or on your server, for a browser and claude.ai.

| Rung | Interface | Steps up when |
| --- | --- | --- |
| 1 | the terminal, Claude, Claude Code | you want to see or tap, not type |
| 2 | the Epicenter app, on a Mac or a phone: every action in a command palette, tables, and forms | a table and a form cannot do it |
| 3 | a view of the app's own | it needs the device in a way the Epicenter app does not give |
| 4 | a program of its own with the folder, such as Whispering | never |

## How data moves

Each app with history has one Git remote, `origin`: where copies meet, and the
backup. `epicenter sync` commits what is left, pulls with `--rebase`, and pushes;
it is the only command that touches a remote. You, an agent, a screen's button,
or a launchd job on each computer runs it. The Mac Studio and the laptop never
talk to each other; each syncs with `origin`, and so does the Epicenter app on
your phone, with libgit2, whenever it opens. Binary files a
folder tracks go through Git LFS: text is history, binaries are content.
`.cache/` and sign-ins never leave a computer.

## One ladder

Every app climbs the same ladder, and each rung is optional.

| Rung | You add | Every app gains |
| --- | --- | --- |
| 1. Files | nothing | any program reads and writes it |
| 2. History | Git, `git-lfs`, an `origin` | backup, history, copies elsewhere |
| 3. Actions | `epicenter` | its actions in the terminal and for Claude Code |
| 4. Everywhere | the Epicenter app, and your server | the app on your phone, offline; a browser and claude.ai through your server |

Whispering is whole at rung 1. Mail's actions run where your Gmail sign-in is,
on a computer you keep on; its files reach every rung.

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
| An interface | Claude or the terminal | it needs to be seen: the Epicenter app, then a view |
| Run something later | someone asks | never |

**Refused:** a sync engine, schedules, merging by `epicenter`, a schema language of
its own, an API beside MCP, programs that ship `epicenter`, apps hosted inside the
Epicenter app through an API of its own, a folder kept in a browser, a browser
that runs actions.

**Later, each when something needs it:** collections' four actions, views, and
the Epicenter app on the Mac and the phone, after Vocab and Mail work on the Mac;
`serve` over HTTPS, for claude.ai, Claude on the phone, and a browser; the
catalog, when other people install apps; reminders as an ordinary app; Epicenter
Cloud running your server, for people who cannot keep a computer on; moving the
vault into `~/Epicenter`, and its history into LFS; WebAssembly actions or a Rust
core, when apps from strangers run with your sign-ins.

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
[ADR-0861]: adr/0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md
[ADR-0862]: adr/0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md
[ADR-0860]: adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md
[ADR-0863]: adr/0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md
[ADR-0857]: adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md

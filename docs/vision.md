# Vision

Epicenter is where your personal software lives. Each app is a folder holding
its code and its data together, in files you can read. Everything an app can do
is a command you type and a tool your agent calls, and every change an app makes
is a commit, so nothing it does is lost or hidden.

This page is the front door. It describes the design as decided on 2026-11-07;
none of it is built yet. [ADR-0840] records the direction and why it changed,
[ADR-0841] what an app is, and [ADR-0842] how its data is kept and moves. The
[spec](../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
carries onboarding, the first app (Mail), and open questions.
[Architecture](architecture.md), [CONTEXT](CONTEXT.md), and the package READMEs
still describe the code that exists, which is the earlier product below.

## What a person knows

1. Each of your apps is a folder in `~/Epicenter`: its code and its data, in
   files you can read.
2. Everything an app can do is a command for you and a tool for your agent.
3. Every change an app makes is a commit, so every version is kept, and any
   folder can be taken anywhere as Git.
4. Your apps are yours: you or Claude write them, change them, and copy them
   from anyone.

## An app is a folder

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
  },
});
```

An action has a description, an input made of fields, and `run`. Epicenter
hands `run` a context of three stores, which differ by how long what they hold
lives ([ADR-0841]):

| Store | Holds | If it is lost |
| --- | --- | --- |
| `folder` | what you would keep if Epicenter vanished; in Git | gone, which is why it is in Git |
| `cache` | anything the app can rebuild: a copy of your mailbox, an index, a browser profile | you wait while it rebuilds |
| `secrets` | sign-ins, in the Keychain, on this computer only | you connect again |

`folder` and `cache` are objects with the same four verbs (`read`, `write`,
`list`, `remove`), and a real `path` only on a computer, so an action that only
touches files can run anywhere. What a person reads is Markdown; what a machine
makes is CSV, JSON, or SQL; a cache can be anything, including SQLite.

## One command

```
epicenter                                      your apps, their actions, any problems
epicenter mail search 'receipt after:2026/09/01'
epicenter vault calendar show 2026-11-07
epicenter new <name> | add <source> | sync | mcp
```

Every action has one spelling, wherever it is typed, so an agent's permission
rules, a commit message, and an MCP tool name always agree. An app outside
`~/Epicenter`, such as the vault, joins by a symlink. `--json` gives an agent
every action's input schema in one call, and `epicenter mcp` offers the same
actions to chat apps.

## History and sync

Each app folder is its own Git repository ([ADR-0842]). When an action returns,
what it changed becomes one commit named for it; when it fails, its changes are
undone; it never commits edits you had open. You commit your own edits.
`epicenter sync` pulls and pushes every app and never commits. Caches and
sign-ins never leave a computer. A computer uses any Git host; anything without
Git, such as a page on a phone, will reach an app only through Epicenter Cloud.

## Agents

Agents write files and call actions; apps act on the world. Anything that
changes the world outside your folders, such as archiving mail, is an action
marked `destructive`, which an agent's permission rules ask you about.

## What Epicenter refuses, for now

A user interface beyond the terminal; a server process; phones and browsers;
sharing; live editing; a sync engine of its own; running other people's code
in a sandbox; installing apps any way but copying them. Each can come later
without changing how an action is written ([ADR-0840]).

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
[ADR-0841]: adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md
[ADR-0842]: adr/0842-an-action-is-a-commit-and-the-repository-is-the-sync.md

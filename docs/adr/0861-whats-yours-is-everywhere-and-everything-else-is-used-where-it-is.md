# 0861. What's yours is everywhere, and everything else is used where it is

- **Status:** Proposed
- **Date:** 2026-11-09
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (the remote), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (apps are folders), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (paths that stay), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (the folder and the world), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, and clients that ask).
- **Unbuilt:** `prompts/`, and the problems a missing sign-in or machine adds to the listing.

## Context

The design had gathered special cases, each true of one app: device programs
beside folder apps, records beside mirrors, an Epicenter sign-in beside other
sign-ins, a phone path over the tailnet for some apps, queued calls, and a copy
of every app on every device. Each was the same few facts seen from one app.

A browser has no file system other programs share. The Origin Private File
System is private to one site and may be evicted, and in WebKit it returned
zeros on reads and refused writes near the 4,840th file (ADR-0623); the File
System Access API opens a real folder only in Chrome on a desktop. Your server,
the Mac Studio, is always on and holds the one copy of each app (ADR-0864).

## Decision

**Three laws.**

1. **What's yours is everywhere.** What a person and their agents make is files
   in an app's folder on your server, the one copy, and every device reaches it
   there (ADR-0864). A program that keeps a copy on another computer, such as
   Whispering, syncs it with that one. `*.local` and `.cache/` stay where they
   are (ADR-0858, ADR-0854).
2. **Everything else is used where it is.** A sign-in, a machine's hardware, a
   service that exists on one machine (Beeper Desktop, iMessage). An action runs
   where what it uses is.
3. **Everything you see or ask is an interface to actions.** The terminal and
   MCP are generated from an app's actions; views (ADR-0860) and prompts are
   written.

**An app is a folder of three parts, and there is one kind of folder.**

```txt
vocab/
  epicenter.ts      collections and actions: what the files are and what you can do (ADR-0857)
  ui/               for people: a web client's source, built into .cache/ui/ and served at /vocab/
  prompts/          for agents: each prompt is a Markdown file, offered as an MCP prompt
  entries/  conversations/  settings.md
```

Getting the folder installs the app. A program such as Whispering.app is one
more interface, one that can also use its machine; its folder is an app like
any other.

**An action uses at most three things, and runs where they are.**

| It uses | Which are |
| --- | --- |
| the app's files | your server, or a program's own copy |
| a service | wherever the person is signed into it |
| something on one machine | on that machine |

An action uses what its context gives and never asks where it runs. What is
missing fails when used, and the app's listing shows it as a problem ("needs
Gmail's sign-in, held on studio").

**Sign-ins are one kind.** Each is held in a `.local` file of the app, on the
computer whose actions use it, and never leaves that computer (ADR-0870).
Epicenter holds only its own sign-in, the one `epicenter serve` gives a client
(ADR-0871).

**To ask for an action that runs on a machine other than your server, write a
record.** A draft marked `ready`, a batch of message ids: the record is a file
on your server, and the action that processes it runs where it can, when
someone asks there. Live calls from one device to another, through a relay or a
tailnet, are not part of the design.

**Nothing runs unless asked.** There are no listeners, schedules, or timers
(ADR-0849).

**Actions compose as functions.** Within an app, an action imports another and
calls its `run` with its own context. Across apps, an agent composes.

## Consequences

- Vocab, The Ark, and notes are used from any device that reaches your server,
  and from none while it is down. Mail's search and archive run where Gmail's
  sign-in is. Messages' drafts are written anywhere, and sent from the Mac that
  runs Beeper.
- A program that must work offline keeps a copy and pays for it in Git and an
  occasional conflict on that Mac (ADR-0864).

## Considered alternatives

- **A copy on every device, converging through a meeting place such as
  Cloudflare Artifacts.** A phone needs Git and a merge, and Artifacts' API
  reads files but does not commit, so a browser would need a Git client, the
  engine ADR-0623 measured and ADR-0700 retired (ADR-0864).
- **A file system in the browser kept in step with Git.** Private to one site,
  evictable, broken in WebKit, and a sync of its own.
- **A website that edits a local folder (File System Access API).** Chrome on a
  desktop only, and no actions.
- **Archetypes of app (records, mirrors, devices).** Every real app mixes them;
  what each action uses is the line that holds.
- **Two kinds of sign-in, Epicenter's and everyone else's.** Gmail also accepts a
  sign-in in an app; what differs is a service that exists on one machine.
- **Queued calls as request files (`{ action, input }`).** Mechanical, and they
  say nothing to a person; a draft marked `ready` says what it is.
- **Live calls through a relay or a tailnet.** Nothing on the author's list needs
  an answer, now, from a machine they are not at.
- **Listeners and schedules.** Runs nobody asked for (ADR-0849).
- **Removing `.local`.** Storage and privacy are real reasons to keep a file on
  one computer, chosen by a setting such as "Keep audio on this Mac only".
- **GitHub as the copies' remote.** A timer or webhook before your server sees a
  push, and its copy merging unattended (ADR-0864). GitHub stays as the backup.

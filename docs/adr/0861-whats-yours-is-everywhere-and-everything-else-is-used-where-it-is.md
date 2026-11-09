# 0861. What's yours is everywhere, and everything else is used where it is

- **Status:** Proposed
- **Date:** 2026-11-09
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server, now optional), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`origin`), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (apps are folders), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (paths that stay), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (the folder and the world), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0862](0862-nothing-blocks-and-nothing-is-lost.md) (the merge).
- **Unbuilt:** all of it: Artifacts as `origin`, the browser's `folder` over the meeting place, `prompts/`, and the problems a missing sign-in or machine adds to the listing.

## Context

The design had gathered special cases, each true of one app: device programs
beside folder apps, records beside mirrors, an Epicenter sign-in beside other
sign-ins, a phone path over the tailnet for some apps, queued calls, and an
always-on server that every remote use went through. Each was the same few
facts seen from one app.

A browser has no file system other programs share. The Origin Private File
System is private to one site and may be evicted; the File System Access API
opens a real folder only in Chrome on a desktop. Keeping either in step with
Git is the folder sync product that waits (ADR-0840), and the author has tried
it. Cloudflare Artifacts, in beta since April 2026, keeps Git repositories that
ordinary Git clients clone and push, and accepts commits over an API with no
working copy.

## Decision

**Three laws.**

1. **What's yours is everywhere.** What a person and their agents make is files
   in an app's folder. Every copy converges through one meeting place, merged
   field by field (ADR-0862). `*.local` and `.cache/` stay where they are
   (ADR-0858, ADR-0854).
2. **Everything else is used where it is.** A sign-in, a machine's hardware, a
   service that exists on one machine (Beeper Desktop, iMessage). An action runs
   where what it uses is.
3. **Everything you see or ask is an interface to actions.** The terminal, MCP,
   and the Epicenter app's palette are generated from an app's actions; views
   (ADR-0860) and prompts are written.

**An app is a folder of four parts, and there is one kind of app.**

```txt
vocab/
  epicenter.json    collections: what the files are, readable by any language
  epicenter.ts      actions: what you can do
  views/            for people: each view is one HTML file, built however its author likes
  prompts/          for agents: each prompt is a Markdown file, offered as an MCP prompt
  entries/  conversations/  settings.md
```

Getting the folder installs the app. A program such as Whispering.app is one
more interface, one that can also use its machine; its folder is an app like
any other.

**An action uses at most three things, and runs where they are.**

| It uses | Which are |
| --- | --- |
| the app's files | anywhere with a copy, or a connection to the meeting place |
| a service | wherever the person is signed into it |
| something on one machine | on that machine |

An action uses what its context gives and never asks where it runs. What is
missing fails when used, and the app's listing shows it as a problem ("needs
Gmail's sign-in, held on studio").

**Sign-ins are one kind.** Each is held where the actions that use it run: the
Keychain on a computer, a token in a browser. None is ever a file. Epicenter
Cloud is one service among them, holding the meeting place and hosted models.

**The meeting place is Cloudflare Artifacts.** Each app's `origin` is a
repository there, and a GitHub repository may be a second push URL as a backup
(ADR-0851).

**A computer has a working copy; a browser does not.** On a computer the folder
is on disk, and whoever knows the intent commits (ADR-0850). In a browser
`folder` writes through the meeting place's API, and each write is one commit.
When the remote has moved, the commit is refused; the browser reads that file
again, merges its change with the function the computers use (ADR-0862), and
commits again. So an app whose actions use only its files runs on a phone with
no computer on.

**To ask from a place that cannot run an action, write a record.** A draft
marked `ready`, a batch of message ids: the record travels, and the action that
processes it runs where it can, when someone asks there. Live calls from one
device to another, through a relay or a tailnet, are not part of the design.

**Nothing runs unless asked.** There are no listeners and no schedules
(ADR-0849); a timer that runs `epicenter sync` only moves files.

**Actions compose as functions.** Within an app, an action imports another and
calls its `run` with its own context. Across apps, an agent composes.

## Consequences

- Vocab, Ark, and notes run in a browser and on a phone with no computer on.
  Mail's search and archive run where Gmail's sign-in is. Messages' drafts are
  written anywhere, and sent from the Mac that runs Beeper.
- Your server becomes optional: a computer kept on, needed only for actions that
  use what is on it (ADR-0849, edited).
- `serve` over HTTP is not needed now: Claude Desktop starts `serve --stdio`, and
  a browser reaches an app's files through the meeting place. It returns with
  claude.ai and Claude on the phone, which need a public address and a sign-in.
- A phone cannot search a mailbox copy kept on a computer; the service's own app
  does that.
- A browser reads over the network; a view asks again after an action.
- Artifacts is in beta. Whether it serves Git LFS is not checked; nothing that
  runs in a browser needs LFS yet.

## Considered alternatives

- **Your server at the center (ADR-0849 as written).** Every remote use went
  through one computer that had to stay on, including uses that touched only
  files.
- **A file system in the browser kept in step with Git.** Private to one site,
  evictable, and a sync of its own: the product that waits.
- **A website that edits a local folder (File System Access API).** Chrome on a
  desktop only, and no actions.
- **Archetypes of app (records, mirrors, devices).** Every real app mixes them;
  what each action uses is the line that holds.
- **Two kinds of sign-in, Epicenter's and everyone else's.** Gmail also accepts a
  sign-in in a browser; what differs is a service that exists on one machine.
- **Queued calls as request files (`{ action, input }`).** Mechanical, and they
  say nothing to a person; a draft marked `ready` says what it is.
- **Live calls through a relay or a tailnet.** Nothing on the author's list needs
  an answer, now, from a machine they are not at.
- **Listeners and schedules.** Runs nobody asked for (ADR-0849).
- **Removing `.local`.** Storage and privacy are real reasons to keep a file on
  one computer, chosen by a setting such as "Keep audio on this Mac only".
- **GitHub as the meeting place.** A GitHub token in every browser and its rate
  limits; it stays as a backup.

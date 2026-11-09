# 0861. What's yours is everywhere, and everything else is used where it is

- **Status:** Proposed
- **Date:** 2026-11-09 (amended 2026-11-09 by [ADR-0863](0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md): every place with a file system holds a working copy, including the Epicenter app on a phone; a browser holds nothing and asks your server. The browser's `folder` over Artifacts' API is withdrawn, since Artifacts' API does not commit.)
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server, now optional), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`origin`), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (apps are folders), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (paths that stay), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (the folder and the world), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md) (the merge), [ADR-0863](0863-epicenter-is-one-place-and-one-app-shows-it-on-every-device-you-own.md) (the place and the Epicenter app).
- **Unbuilt:** all of it: Artifacts as `origin`, `prompts/`, and the problems a missing sign-in or machine adds to the listing.

## Context

The design had gathered special cases, each true of one app: device programs
beside folder apps, records beside mirrors, an Epicenter sign-in beside other
sign-ins, a phone path over the tailnet for some apps, queued calls, and an
always-on server that every remote use went through. Each was the same few
facts seen from one app.

A browser has no file system other programs share. The Origin Private File
System is private to one site and may be evicted, and in WebKit it returned
zeros on reads and refused writes near the 4,840th file (ADR-0623); the File
System Access API opens a real folder only in Chrome on a desktop. Cloudflare
Artifacts, in open beta since 2026-10-01, keeps Git repositories that ordinary
Git clients clone and push. Its REST API and Workers binding read files and
inspect objects; a commit goes through a Git client (checked 2026-11-09). A
phone app, unlike a browser, has a real file system and can run libgit2
(ADR-0863).

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

**An app is a folder of four parts, and there is one kind of folder.**

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
| the app's files | any place that holds a copy |
| a service | wherever the person is signed into it |
| something on one machine | on that machine |

An action uses what its context gives and never asks where it runs. What is
missing fails when used, and the app's listing shows it as a problem ("needs
Gmail's sign-in, held on studio").

**Sign-ins are one kind.** Each is held where the actions that use it run: the
Keychain on a computer or a phone. None is ever a file. Epicenter Cloud is one
service among them, holding the meeting place and hosted models.

**The meeting place is Cloudflare Artifacts.** Each app's `origin` is a
repository there, and a GitHub repository may be a second push URL as a backup
(ADR-0851).

**A place with a file system holds a working copy; a place without one asks.** A
computer holds `~/Epicenter`, and the Epicenter app on a phone holds its own
copy of each app; both commit and sync with Git (ADR-0850, ADR-0863). A browser,
claude.ai, and Claude on the phone hold nothing: they ask your server over
HTTPS (ADR-0849). So an app whose actions use only its files runs on a phone
with no computer on.

**To ask from a place that cannot run an action, write a record.** A draft
marked `ready`, a batch of message ids: the record travels, and the action that
processes it runs where it can, when someone asks there. Live calls from one
device to another, through a relay or a tailnet, are not part of the design.

**Nothing runs unless asked.** There are no listeners and no schedules
(ADR-0849); a timer that runs `epicenter sync` only moves files.

**Actions compose as functions.** Within an app, an action imports another and
calls its `run` with its own context. Across apps, an agent composes.

## Consequences

- Vocab, The Ark, and notes run in the Epicenter app on a phone with no computer
  on. Mail's search and archive run where Gmail's sign-in is. Messages' drafts
  are written anywhere, and sent from the Mac that runs Beeper.
- Your server becomes optional: a computer kept on, needed by places that hold
  nothing and by actions that use what is on it (ADR-0849, edited).
- `serve` over HTTPS is how a browser, claude.ai, and Claude on the phone reach
  apps, with a public address and a sign-in; it is built when one of them is
  wanted.
- A phone cannot search a mailbox copy kept on a computer; the service's own app
  does that.
- Artifacts is in beta, limits a repository to 1 GB, a file to 32 MiB, and a
  push to 64 MiB, and serves no Git LFS; an app with large binaries keeps them in
  LFS elsewhere (ADR-0856).

## Considered alternatives

- **Your server at the center (ADR-0849 as written).** Every remote use went
  through one computer that had to stay on, including uses that touched only
  files.
- **A browser that writes through the meeting place's API, one commit per write
  (this record until its amendment).** Artifacts' API reads but does not commit,
  so a browser would need a Git client, the engine ADR-0623 measured and
  ADR-0700 retired, or a hosted runtime to commit for it.
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
- **GitHub as the meeting place.** A GitHub token on every device and its rate
  limits; it stays as a backup.

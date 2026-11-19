# History

This file lists the big turns in Epicenter's life, oldest first: decisions
that changed what the product is or reversed a direction. Current rules live
in the `## Decisions` section of each area's README; this file is background,
never instructions. A record named below is in `docs/adr/` until its area
moves to a README, and in the `adr-archive` Git tag after that.

A new entry is for a decision that changes what Epicenter is or reverses a
direction, where the losing option would take weeks to return to. It is one
short paragraph: what we did before, what changed, why, and what we gave up.

## 2025-08-04: Whispering's repository becomes Epicenter

Until then the repository was Whispering, one free dictation app. We renamed the project Epicenter, described it as a set of local-first, open-source apps, and moved Whispering into `apps/whispering` as one app among several. A landing page, a command-line tool, and the first hosted API project arrived in the same two weeks. We gave up the simplicity of a repository that ships one app.

Records: none. Commit cd6684f297.

## 2025-10-01: App data lives in a Yjs document

The shared data library kept each app's data in SQLite and treated the database as the truth. We made a Yjs document the truth instead, a format built so several devices can edit and merge, and rebuilt SQLite tables and Markdown files from it as copies for reading. The reason was a move to a collaborative workspace that syncs between devices. We gave up writing to SQL directly and took on a sync engine that shaped the next year of work.

Records: none. Commits 2330a28cbe, a30c04429a.

## 2025-11-25: The license changes from MIT to AGPL-3.0

Whispering and everything around it had been MIT, which lets anyone copy the code into a closed product. We relicensed the repository to AGPL-3.0, which lets anyone run, change, and host it but makes them publish their changes if they distribute or host a modified version. The licensing strategy written later names the worry: a competitor copying the code and shipping it as their own. Versions already published under MIT stay MIT.

Records: none. Commits 61c28d4ab6, fd41fc2dd2; `docs/licensing/licensing-strategy.md`.

## 2026-03-11: Epicenter runs a hosted service at api.epicenter.so

Apps had run on the device alone. We put a server at `api.epicenter.so` that signed people in and synced their workspaces between devices, and a week later it sold AI use through paid credits. This made Epicenter a company service as well as software a person runs. Every app that synced now depended on a server we had to keep running.

Records: none. Commits d8f9aec0de, 347fdb86e4, 3e7e7eaf98.

## 2026-06-15: The sync server can read your data, and private means running it yourself

We had drafted end-to-end encryption, where the server stores data it cannot read. We withdrew it and removed the encryption layer, because collaboration, search, and recovery all need a server that reads the data, and few people had asked for a blind one. Nine days later we settled the promise that follows: the hosted app has no privacy settings, and a person who wants privacy runs the server on their own machine. We gave up the claim "we cannot read your data" for the hosted service.

Records: ADR-0004, ADR-0003, ADR-0068, ADR-0069.

## 2026-07-10: Epicenter ships as one desktop app that hosts every app

Whispering was its own desktop program, and a chat app that could call the other apps' actions was becoming a second one. We chose one signed desktop app, Epicenter, that serves every built-in app from one local address and owns recording, shortcuts, and windows for all of them. Shipping separate programs would have doubled the installers, permissions, and updates. Use from a phone became remote access to that one desktop session, and we stopped building a way for each app to be reached across devices.

Records: ADR-0080, ADR-0118.

## 2026-08-08: Desktop is the only place apps run, and the first data stack is deleted

The repository supported five ways to run an app: a hosted website, a standalone desktop bundle, the desktop host, a server process, and a Chrome extension. We kept one, a page inside the Epicenter desktop app, over a rewritten store that the app itself holds. We refused hosted web apps, deleted the tab manager extension, and put off apps from other developers. We deleted the old data stack instead of keeping it working, and accepted that data saved in it was lost, with no importer.

Records: ADR-0227, ADR-0224.

## 2026-08-29: One license, and no toolkit for other developers

Since March 2026 a few packages had been MIT so other developers could build them into their own products, while the apps stayed AGPL. No such developer arrived, most MIT packages had only AGPL users, and the rule that kept the two tiers apart was moving code to the wrong places. We made everything AGPL-3.0-or-later and marked every package private. Bringing MIT back needs a named developer who wants to build on a package, not a hope of one.

Records: ADR-0288.

## 2026-10-14: Plain files replace the Yjs store, and Matter, Local Mail, and Skills are deleted

Three data models ran side by side: the Yjs store synced through our servers, data folders of Markdown and JSON files with Git history, and Matter, a separate tool for Markdown tables. We kept data folders as the only model, so a person, an app, and an agent all edit the same files, and Git moves them to a server the person chooses. About 110,000 lines went, with Local Mail, Skills, and Matter and the data people had synced through the store. We gave up real-time sync: a folder syncs only when someone runs a Git transfer.

Records: ADR-0534, ADR-0521, ADR-0450.

## 2026-10-31: Apps become separate programs again

The Epicenter desktop app had two jobs: it managed folders, and it hosted Todos, Capture, Honeycrisp, Whispering, and Messages in its own windows. Once an app's data was a file layout that any program may write, hosting bought only a second build and a second release channel for each app. We made each app its own program and left the Epicenter app to manage folders only. This reversed the July decision to ship everything as one desktop app.

Records: ADR-0700, ADR-0701, ADR-0611.

## 2026-11-05: Folder sync becomes a product for groups, synced only through Epicenter servers

Folders had synced over plain Git to any server the person chose. We redesigned the product around spaces, groups such as a family or a couple who share folders, and decided that a folder syncs only with an Epicenter server, hosted or self-hosted, that keeps every version and decides who may see what. The design grew to web and phone apps and sharing by email. We gave up syncing a folder with GitHub or GitLab.

Records: ADR-0802, ADR-0803, ADR-0835.

## 2026-11-07: Epicenter is where one person's software lives, and folder sync stops

The folder sync product for many people was mostly unbuilt, and its one user, the owner, rarely edited on two computers in a week and shared nothing. We narrowed Epicenter to one person's software: each app is a folder with its code and its data, and each action is a command for the person and a tool for their agents. We stopped the sync engine, the server that keeps history, sharing, and the web and phone apps, and the next day deleted the Epicenter desktop app and the apps built on folder sync. For this period a non-developer cannot use Epicenter.

Records: ADR-0840, ADR-0841, ADR-0842, ADR-0843.

## 2026-11-13: Each set of records has one writer, and Epicenter never merges two copies

Earlier drafts sorted apps into classes, each with its own machinery for mirrors, outboxes, and merging. A look at the owner's real apps showed that truth belongs to each set of records, not to the app: Mail's decisions are files in the folder, while the mail itself stays in Gmail. We set one rule: each set of records has one place that may write it, and Epicenter never reconciles two writable copies. We refused to build conflict merging; whoever holds the folder writes files, and everyone else asks an action.

Records: ADR-0896, ADR-0898.

## 2026-11-13: The folder sync product is retired

Six days earlier we had said the folder sync product "waits", which left its records marked as accepted and its design open to revival. Asked whether to return to it, the owner said to retire it. Every record that designed it is closed, and its code stays only in the `folder-sync-product` Git tag as history. A later product that needs sync, sharing, or a server must make its own case from its own evidence.

Records: ADR-0899.

## 2026-11-13: Whispering 8 is a clean rewrite that needs no Epicenter

Unreleased Whispering had been rebuilt on the folder sync product, with sign-in and a folder on our server. We chose a clean break: Whispering 8 is a new install that keeps recordings and their audio as plain Markdown and audio files in its own folder, with no Git, no account, and no Epicenter. It imports version 7.11's recordings when asked and nothing else. People install it fresh and grant the microphone and Accessibility again.

Records: ADR-0894, ADR-0892, ADR-0962.

## 2026-11-14: The home is a computer its person controls, and Epicenter builds nothing for hosting

Several records had left room for "Epicenter Cloud", a hosted computer a person could pick instead of their own. We decided the home is a computer the person controls, owned or rented, and that the program is built for one person's computer. Nothing in it is for a hosting service: no sign-in in front of `serve` and no per-caller limits. Whoever provides a rented computer can read it, and Epicenter adds no protection against that.

Records: ADR-0903.

## 2026-11-14: An Epicenter is one private Git repository

Each app had been two repositories, one for code and one for records, inside a third that listed them; nine apps meant nineteen repositories. Epicenter made a commit for every action call and offered its own history, undo, sync, and update commands. We moved to one private repository that holds every app's code beside its records, committed by the person when they choose. We dropped per-call commits and updating an app by merging from the app it was copied from.

Records: ADR-0910, ADR-0940.

## 2026-11-16: `serve` listens only on this computer

`serve` signs no one in, yet a flag let it listen on any network address, and two earlier designs gave it a public address with passkeys and OAuth. We made `serve` listen only on the local machine, with no flags. Reaching it from a phone is the job of the owner's private network, for example Tailscale. We gave up a public address and any sign-in of our own.

Records: ADR-0927.

## 2026-11-18: The repository ships no apps

The repository carried example apps, and the front page told a new owner to install one with a single command. Nothing checked the examples, so they drifted from the library, and checking them meant bending the repository around them. We deleted them: a real app lives in its owner's Epicenter, beside its records. A new owner writes a first one-file app from a walkthrough, and no command makes an app or an Epicenter.

Records: ADR-0969, ADR-0955, ADR-0958.

## 2026-11-18: The hosted API is retired

`api.epicenter.so` handled sign-in, AI, transcription, and billing. Nothing we ship called it any more, since Whispering's sign-in was removed before it was ever released, and keeping it cost a deploy step, a database in the test gate, and a share of every dependency update. We deleted it and its account website. Epicenter now runs no service, and revenue from hosted services waits for a product that needs one.

Records: ADR-0970.

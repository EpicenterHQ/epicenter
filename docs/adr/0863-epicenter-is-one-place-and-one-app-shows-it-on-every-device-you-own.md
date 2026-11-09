# 0863. Epicenter is one place, and one app shows it on every device you own

- **Status:** Proposed. Accepted when the iPhone spike below passes.
- **Date:** 2026-11-09
- **Amends:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) at "no web or phone app" and at its rejected "platform that runs apps": the phone gets one Epicenter app, built after the first apps work on the Mac. [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md) at "a computer has a working copy; a browser does not": every place with a file system holds a working copy, and a browser holds nothing. [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) at the Epicenter app and its transports.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server, for places that hold nothing), [ADR-0857](0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md) (`epicenter.json` and `epicenter.ts`), [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md) (the merge), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) and [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (Git in the browser, retired).
- **Unbuilt:** all of it: the Epicenter app on any platform, its catalog, `id` in `epicenter.json`, the skill `epicenter` ships, and Spotlight and shortcut front doors.

## Context

ADR-0840 rejected "a platform that runs apps (one shell hosting apps as views,
apps installed from links, a phone app containing every app)" for having no
stated need, and for needing a sandbox, a runtime, and an install story first.
On 2026-11-09 the author listed the apps they expect to have, about twenty
(below), wanted between five and fifteen on their phone within a year, and
expected several to be used by other people within a year: Whispering, Vocab,
and Zhongwen. Agents already write the author's software: their vault holds 479
agent-written commits since 2026-10-01.

Three earlier answers to "how does the phone get an app's data" failed on
evidence. A Git clone in the browser took 43 s where native Git took 3.1 s, and
WebKit's private file system returned zeros on reads, merged `A.md` with
`a.md`, and refused writes near the 4,840th file (ADR-0623); it was retired
(ADR-0700). A browser writing through Cloudflare Artifacts' API (ADR-0861 as
written) depends on an operation Artifacts does not offer: its REST API and
Workers binding read files, and Cloudflare's own write example runs
isomorphic-git, commits, and pushes. A hosted server for every person works,
but no requirement of the author's needs one.

A native app is not a browser. Research on 2026-11-09 found: libgit2, through
`git2-rs`, clones, fetches, commits, merges, and pushes over HTTPS on iOS, and
Working Copy ships it there (gitoxide still cannot push); Tauri 2 builds,
signs, and ships iOS apps through TestFlight, with Swift plugins for Apple APIs;
iOS apps cannot start a `git` process; App Review guideline 4.7 permits HTML5
mini apps that are not built into the binary, with the host responsible for an
index of them, content reporting, per-app consent, and no native platform API
exposed to them without Apple's permission (4.7.2); guideline 4.3(a) discourages
one app under several bundle IDs; iOS gives an app no way to add an icon to the
Home Screen, while Android's `ShortcutManager.requestPinShortcut` does, with the
person's confirmation.

## Decision

**Epicenter is a place, and the Epicenter app shows it.** The place is
`~/Epicenter` on a computer, and the Epicenter app's own storage on a phone: a
folder per app, each a Git working copy. The Epicenter app is one program,
built with Tauri for the Mac and the iPhone (and later Android), that lists the
apps in the place, opens their views, runs their collections, and syncs them.
An app's home is its folder in the place, whatever program writes it.

**A place with a file system holds a working copy; a place without one asks.**

| Place | Holds | Runs | Reaches actions |
| --- | --- | --- | --- |
| a Mac: the CLI, the Epicenter app, a device program | `~/Epicenter` | everything | in its own process, or stdio to `epicenter` |
| a phone: the Epicenter app | its own copy of each app | `epicenter.json`'s collections, views, an on-device model | in its own process |
| a browser, claude.ai, Claude on the phone | nothing | nothing | HTTPS to your server (ADR-0849) |

**`epicenter.json` runs everywhere; `epicenter.ts` runs on computers.** A
collection's `list`, `get`, `set`, and `delete` need no code, so the phone runs
them against its copy, checked against the collection's schema, and so does an
on-device model given them as tools. `epicenter.ts` runs where `epicenter` runs.
A rule that must hold on the phone lives in the data (a path such as
`entries/{word}.md` makes saving a word twice write one file) or in the view.

**An app is one of three kinds, by what its actions use.**

| Kind | The author's apps | Its own program |
| --- | --- | --- |
| files only | vocab, zhongwen, notes, honeycrisp, opensidian, capture, tasks, timebox, theark, ancestry, geopolitics, invest | none: the Epicenter app runs it everywhere, offline included |
| a service or one machine | mail, messages, photos, decox-manager | none: its views show its files anywhere; its actions run on the Mac that has the sign-in or the machine |
| a device program | whispering, bureaucracy, tabs | yes: a global shortcut, background recording, pasting into other apps, a menu bar, a browser extension |

A device program writes its folder in the place like any app, so its files
appear in the Epicenter app; the Epicenter app gains none of a device program's
abilities.

**An app has a folder, an identity, and maybe a program.** The folder is where
its data lives and its short name (`~/Epicenter/notes`, so `epicenter notes …`),
chosen by the person. The identity is who publishes it, as a reverse domain in
`epicenter.json`'s optional `id`: Epicenter's Notes is `so.epicenter.notes`;
the author's Honeycrisp is `com.bradenwong.honeycrisp`. An app needs an `id` only
to be published to a catalog or updated from one. Only a device app has a
program.

**A front door is packaging, not architecture.** Each installed app is found by
Spotlight on iPhone and Mac through one App Intent ("open an app") whose
parameter is an installed app, and on Android pinned to the Home Screen with
`requestPinShortcut`; on iPhone a person may add a Shortcuts icon or a widget.
A store listing of an app's own is decided when that app has an audience,
within guideline 4.3.

**Installing an app is getting its folder, and a person always confirms it.**
The author's build installs from any Git URL. Anyone else's installs from a
reviewed catalog at `epicenter.so/apps`, the index guideline 4.7 asks for. A
link such as `epicenter.so/vocab` opens the app or leads to it, and never
installs on its own:

1. Nothing installs without an install sheet: the app's icon, name, publisher,
   where it comes from, and what it can do. On the phone that is "Vocab can read
   and change only its own files"; on a Mac, an app with `epicenter.ts` also
   says "includes actions that run on this Mac".
2. An update from the app's upstream is offered, never applied silently.
3. Nothing runs in the background but sync while the app is open.
4. Removing an app is one step, and asks whether to keep its files.
5. Names are honest: a page offering Vocab says it runs in Epicenter.

An app opens with no sign-in; signing in appears when the person wants a second
device, and creates the app's `origin`.

**Agents make apps from the root.** A person starts Claude Code in
`~/Epicenter` and asks for an app; the agent writes its folder, commits, and
pushes, and the Epicenter app on the phone shows it at its next sync, with no
build. `epicenter` installs and updates a skill that teaches an agent how an app
is made, because that knowledge changes with the tool. `~/Epicenter` holds only
app folders.

**The phone syncs with libgit2.** The Epicenter app uses `git2-rs`, keeps each
`origin`'s token in the Keychain, and refuses redirects when it sends one. It
syncs when it opens, after a write, and when it returns to the front; iOS's
background runs are a bonus. It merges notes with ADR-0862's function over
libgit2's three-way file merge. It supports repositories without Git LFS at
first.

**A view is sandboxed.** A view runs in an iframe without `allow-same-origin`,
talks to the host only by `postMessage`, and reaches only its own app's
collections; the host checks each message's source and never lets a view call
its native commands. A view may hold state that does not need to survive it
closing (ADR-0860).

**The Mac's Epicenter app is a signed, notarized download.** It opens
`~/Epicenter` directly and installs the `epicenter` command into `~/.local/bin`
with one button, as VS Code installs `code`. The Mac App Store's sandbox and
guideline 2.4.5 forbid both.

**Order.** Vocab and Mail on the Mac first (ADR-0840's promise), then the merge
function (ADR-0862), then the iPhone spike. This record is accepted when the
spike, through TestFlight on the author's iPhone, does all of this: clones Vocab
with `git2-rs`, changes a field, commits, and pushes it to a Mac; shows a view
that cannot reach the host's commands; works in airplane mode and after a
restart; and finds Vocab from Spotlight. Before anyone else installs an app, a
submission to App Review tests the catalog.

## Consequences

- Twenty apps are one build. A new app is a folder an agent commits, with no
  Xcode, TestFlight, or review in the author's build.
- Files-only apps work on the phone with no computer on and with no network.
  Your server matters only to a browser, claude.ai, and Claude on the phone.
- The phone does not run `epicenter.ts`; an app whose rules live only in code
  is weaker there until they move into its data or its view.
- A bug in the Epicenter app reaches every app. The host stays free of code
  specific to any app, which is also what App Review and a later single-app
  build need.
- Epicenter takes on a publisher's duties for its catalog: review, reporting,
  and consent per app.
- Two apps can both be notes: `so.epicenter.notes` and
  `com.bradenwong.honeycrisp` live in `~/Epicenter/notes` and
  `~/Epicenter/honeycrisp`.
- Whispering stays its own program and its own front door; its folder is in the
  place.
- The vault moves into `~/Epicenter` (as `theark` or `vault`) when The Ark is
  built, so no app's folder lives elsewhere.
- Open: whether a Shortcuts icon on iOS opens the Epicenter app directly; whether
  App Review accepts views from a catalog that read and write their own files
  under 4.7.2; libgit2's size on iOS and its deprecated Secure Transport TLS.

## Considered alternatives

- **A separate app for each idea, sharing an engine.** Each feels native and has
  its own icon; twenty listings, builds, and reviews, a 4.3 risk, and a new app
  needs a build. Kept for a device program, and for one app with an audience of
  its own.
- **No Epicenter app; Spotlight as the only launcher.** Spotlight is the front
  door here; something still has to hold the copy and show the views.
- **A browser that runs actions against the meeting place (ADR-0861 as
  written).** Artifacts' API does not commit; writing means a Git client in the
  browser or a hosted runtime.
- **A Git clone in the browser (ADR-0623).** Measured and retired.
- **Your server, hosted by Epicenter, as every place's runtime.** Works, at a
  few cents to a few dollars a person a month on sleeping containers, and fails
  only the phone with no network. Nothing of the author's needs it; it remains a
  later deployment of `epicenter serve`.
- **A CRDT document per app (Yjs).** A second data model beside files, which
  ADR-0534 deleted; nothing here edits one text live with other people.
- **The Epicenter app lending a device's abilities to apps.** Every app would
  share every deep permission, and the host would grow an API of its own.
- **Swift code per app.** Apps would need builds; an app is data and HTML.
- **The Mac App Store.** Its sandbox and 2.4.5 forbid installing the command.

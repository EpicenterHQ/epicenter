# 0895. Only the home commits an app's data, and a connected program delivers to it through the app's actions

- **Status:** Proposed
- **Date:** 2026-11-13
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (direct writes on the home, and snapshots), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (a program sends its data through an action, with "a possible later offline outbox", which this builds), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binary files), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (`connect`), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (the contract), [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (Whispering 8's folder).
- **Unbuilt:** all of it. This record stays Proposed until the five sequences below run end to end, on a phone browser for the second.

## Context

ADR-0894 withdraws a program's Git clone. A program still needs to reach the
home: the clients are a laptop and a phone, as a Tauri program or a page the
home serves, and a browser tab runs no Git. Audio is the largest payload.
Whispering creates records, each with a new id, and occasionally changes one
field.

The home already offers every action at `POST /<app>/<action>`
(`packages/cli/src/http.ts:134`). The generated `set` changes only the fields
it is given and keeps the rest and the body
(`packages/app/src/collection.ts:730-737`). The generated `add` refuses a path
that exists (`collection.ts:725`). `serve` refuses a request whose `Origin` is
not its own host (`http.ts:414-426`). The action route takes JSON only
(`http.ts:141`).

Earlier designs gave each device a full copy of the app's data and
reconciled the copies. The owner's use does not need that, and a feed of
changes back to every device is the folder sync product ADR-0840 set aside.

## Decision

**Only the home commits an app's data. Whoever has the folder writes files;
everyone else asks the home through actions. A connected program delivers
its new records to the home, keeps its own records offline, and reads the
rest from the home when it can reach it. No device keeps `.git` or a
continuously synced copy.**

| | Who | How they write |
| --- | --- | --- |
| Have the folder | you, an agent, or an editor on the home | edit files; the home snapshots them as changed outside a call (ADR-0850) |
| Ask it | a UI, a phone, an agent elsewhere, a program | call an action; the home runs it and commits |

What a connected device can do:

| | Offline | Online |
| --- | --- | --- |
| Record and transcribe | yes | yes |
| Browse and edit its own recordings | yes | yes |
| Browse other devices' recordings | those it last saw, cached | yes, asked live |
| Edit a recording the home already has | yes, held as a pending change | yes, sent at once |

How a device asks:

| What | Action |
| --- | --- |
| deliver a new record | `recordings.add`, with an id the device made |
| deliver its audio | a byte route, keyed by the record's id |
| change a delivered record | one pending `recordings.set` per record, merged if edited again, sent when online |
| browse | `recordings.list` and `get` over `connect()`, kept as a read-only cache outside `data/` |
| anything else | any action while online; never queued |

- **A device queues only generated actions,** which derive from the
  contract. An app's custom actions may depend on the home's state or a
  sign-in, so they run live or not at all.
- **A record edited outside the program** is caught by a fingerprint of each
  record as delivered: a file whose fingerprint changed is sent as a `set`
  of all its fields.
- **`connect` takes `url` for a program,** which the home does not serve. A
  UI reads its app and its home from its page's address.

### Before this is built

- **`add` answers done for the same id and content,** so a retry after a lost
  reply succeeds; with other content it refuses, and the program shows it.
- **A write that carries a body,** since `set` keeps it.
- **`serve` admits a program:** which origins, and how a program proves it is
  the person's.
- **The byte route** resumes, lands audio before or with its note, and says
  where the home keeps audio and whether Git or the home's own backup holds
  it, against ADR-0856.
- **A rule for a contract that changed on the home** while a device held
  pending records, for example a new required field.
- **A contract a program in another language can read:** paths, fields, and
  the HTTP of `add`, `set`, and the byte route.
- **A phone browser page that opens offline** and an outbox that survives a
  closed tab.
- **Whether a program runs the app's collections** in its webview, which
  needs `@epicenter/app` without `AsyncLocalStorage` (`context.ts:17`) and
  `Bun.YAML` (`front-matter.ts:181`), is decided by the prototype.

### Acceptance

Each sequence states what is acknowledged, what clashes, where the audio is,
and what is kept:

1. Record on the laptop offline, then reconnect.
2. Record in a phone browser, offline, then reconnect.
3. An agent on the home tags a recording while the laptop is offline; then
   the laptop changes its title.
4. Whispering on the home points at `~/Epicenter/apps/whispering/data`.
5. A recorder written in another language delivers a recording and its
   audio.

## Consequences

- One way in from outside the home: a program cannot write a file the app's
  actions never saw.
- No merge algorithm. Two changes to different fields both survive; a field
  changed on both sides keeps the later change.
- A device shows recordings made elsewhere only when it has seen them.
- `@epicenter/folder`'s sync is not the delivery client.

## Considered alternatives

- **A clone that pushes (ADR-0887).** Git on every device, none on a phone or
  in a browser, a second route for audio, and writes that skip the app's
  actions.
- **A full copy on every device, with a feed of changes from the home.**
  Acknowledged versions, deletion tracking, and a clash rule per record, for
  offline browsing of what other devices recorded.
- **Upload whole files with `If-Match`, merged on the home.** A merge for a
  write pattern that is nearly all new records.
- **A queue of every call, replayed in order.** It misses an edit made outside
  the program and needs ordering and a rule for calls behind a refused one.
- **Every write through actions, even with the folder.** It cannot be
  enforced against a shell, and it ends how the owner's most-used software is
  written (ADR-0850's 479 commits).
- **Whichever computer is on is the home.** A relay runs no action, and
  Mail's sign-in lives on one computer.

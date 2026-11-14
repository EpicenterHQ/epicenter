# 0896. Each collection has one writer of record, and Epicenter never reconciles two writable copies

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Amends:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) at its description of Epicenter, which this states as one sentence below.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (an action changes files), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (a remote is a push-only backup), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (a cache is what an app gitignores), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (an action changes the folder or the world), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (Proposed), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (a sign-in stays on its computer), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (any program that writes valid files is a valid writer), [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (Whispering's folder), [ADR-0897](0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md) (hosted Notes).
- **Unbuilt:** nothing. This names what the built apps already do and what the platform refuses.

## Context

Earlier drafts classified apps: a home holding every app's data, then
"folder apps" and "service apps", each with an outbox, mirrors, a hosted
home, a five-route protocol, or a command to move an app. A review of the
apps on the owner's home (`~/Epicenter/apps`) found that no app fits one
class:

- Mail commits `data/proposals/<time>.md`, the person's decisions, and keeps
  each Gmail account in `accounts/gmail-<address>.local.sqlite`, never
  committed.
- Messages commits drafts and attempts, and asks Beeper for conversations
  each time; it keeps no copy of them.
- Tasks, Reading, Vocab, and Capture keep everything in the folder.

So truth belongs to a collection, not an app. And in every case the
platform's work is the same: whoever holds the folder writes files, and
anything that needs a rule, reach, or a sign-in goes through an action.

## Decision

**Epicenter is where one person's software lives: small apps the person and
their agents change through their files or their actions. What the person
makes is Markdown files they hold, with Git history once the folder is in an
Epicenter.**

1. **File over app.** What a person makes is plain files in a documented
   shape. Any program that writes that shape is a valid writer and needs no
   Epicenter.
2. **Each collection has one writer of record within an Epicenter: its
   folder, or a source elsewhere, such as a service or another program's
   folder.** Epicenter never reconciles two writable copies. Someone else's
   tool may, at the person's choice and risk.
3. **Have the folder, write files; otherwise ask an action.** Actions exist
   for reach, rules, and sign-ins.
4. **Commit what the person made.** A copy of data whose truth is elsewhere
   is written only by the app's own pull, and by an action that changes the
   source and pulls what it changed before it returns. Keep the copy
   `.local` when the source can send it again. Commit it as Markdown when
   the person would want it after the source is gone, as with Whispering's
   recordings and hosted Notes. A stray edit to a committed copy is
   snapshotted ("changed outside epicenter",
   `packages/cli/src/snapshot.ts:321`), then replaced by the next pull.

### Where a collection's truth is

| Form | Where a write counts | How Epicenter's copy keeps up | Collections |
| --- | --- | --- | --- |
| Kept | this Epicenter's folder | it is the truth | Tasks, Reading, Vocab, Capture, Mail's proposals, Messages' drafts |
| Cached | elsewhere: a service, or another program's folder | the app pulls a copy | Mail's mailbox from Gmail; Whispering's recordings brought home from Whispering's folder |
| Live | elsewhere: a service | none; the app asks each time | Messages' conversations in Beeper |

These words describe; they are not API. No collection declares its form, and
nothing in `serve` acts on it.

**Live is the cheapest form.** It suits a service that already answers
quickly, data private enough not to copy, or data that changes faster than a
pull. An app starts live and caches only when it needs search, reading while
the service is away, or history.

**A cached collection pulls by whatever its source offers,** from the most
hostile to the friendliest: a requested export, such as Google Takeout;
listing everything and comparing; a change feed with a cursor, such as
Gmail's `history.list`; or the source pushing changes. A service Epicenter
runs offers a change feed.

**Forms compose.** A cached collection can feed a kept one: tasks pulled from
another service into an inbox, which a person or an agent moves into Tasks
through Tasks' actions. The kept collection never pulls; moving an item is a
write by whoever decides.

**A remote is a backup, never a truth** (ADR-0851). One writer pushes to it,
and no writer pulls from it.

**Whispering's recordings are kept in Whispering's own folder on the computer
that makes them** (ADR-0894). Whispering writes them, not Epicenter, and a
recording is written only where it was made. Whispering keeps no Git, so
bringing recordings home is copying new files, a pull by file copy: with a
file syncer the person chooses, or by pointing Whispering's folder at
`~/Epicenter/apps/whispering/data`, which makes Whispering a writer of a kept
collection there. Epicenter builds neither.

## Consequences

- Nothing in Epicenter merges two writable copies.
- While the home is unreachable, other devices can neither read nor write
  its kept collections.
- A cached collection cannot be written while its service is unreachable.
- An agent reads its own write to a service, because the action pulls before
  it returns.

## Not yet

Each waits for a person who needs it, and building one needs the owner's yes.

- A program delivering records to a home through actions. Actions accept
  JSON only (`packages/cli/src/http.ts:141`), so audio cannot travel.
- An offline outbox for actions.
- Moving a collection's truth between a folder and a service.
- A published protocol for third parties. `serve` prints a contract as JSON
  Schema (`packages/cli/src/listing.ts:108`), unpromised.
- `serve` pulling cached collections on a clock. Mail catches up when asked;
  the vision refuses schedules.
- A field declaring a collection's form.
- Epicenter hosting any service (ADR-0897).

## Considered alternatives

- **Classify apps as folder apps and service apps.** Mail and Messages are
  both.
- **The home holds every collection's truth.** Gmail's and Beeper's truth is
  theirs regardless.
- **A committed Markdown copy of every service.** Mail rightly keeps a
  528 MB `.local` index instead; a Markdown mail archive would be overfit.
- **Code always writes through actions.** Whispering is code that writes
  files, and ADR-0889 makes any valid writer valid.

# 0900. A program may hand its new records over to a home, which then holds them

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md) at "Epicenter builds neither" and at Not yet's "A program delivering records to a home through actions" and "An offline outbox for actions": a program may hand new records over through the app's `add`, and only new records wait while the home is unreachable.
- **Relates:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) (whoever runs a home decides who reaches it), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (a program and an app meet at the contract), [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (Whispering's folder), [ADR-0898](0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md) (a move, a repeatable `add`, files beside a record).
- **Unbuilt:** all of it. It waits for an `add` that answers done for the same id and content (`packages/app/src/collection.ts:740` refuses an existing path), for files beside a record (`packages/app/src/path.ts:79` takes `.md` only), and for an action's input to carry audio (`packages/cli/src/http.ts:141` reads JSON only).

## Context

ADR-0896 gave a program's records two ways to a home and built neither:
pointing the program's folder at the app's data folder on the home, or
copying new files there with a file syncer the person chooses. It filed
delivery through actions under "Not yet". ADR-0887's Git clone was superseded
by ADR-0894, and a draft that made delivery through queued actions the rule
for every connected program was withdrawn in `567ee91679` as fitted to
Whispering alone.

With a file syncer, Whispering on a laptop shows only the recordings made on
that laptop. Every recording is visible only in the `whispering` app's UI on
the home. An edit made there changes the home's copy and leaves the laptop's
as it was, and nothing says which is right.

The owner wants every device to see and edit every recording, and asked
whether that needs two-way sync. Three wants were being asked for at once:
adding while the home is unreachable, reading while it is unreachable, and
editing an existing record while it is unreachable. New records cannot
collide, since each has its own id. Only the third needs a merge.

## Decision

**How a program's records reach a home is the program's choice. Epicenter
holds one rule: at any moment one place writes a record (ADR-0896). Handing
over is one way to keep it, and the way Whispering takes.**

| A program may | Who writes a record | What the home has |
| --- | --- | --- |
| stay alone | the program | nothing |
| share the folder, on the home itself | the program, writing the app's data folder | the truth |
| be pulled from | the program | a copy its pull writes |
| hand over | the program until hand-over, then the home | the truth |
| keep nothing and ask each time | the home | the truth |

Sharing the folder and being pulled from are ADR-0896's two ways. Keeping
nothing is what a UI does. Handing over is new.

**A program that hands over calls the app's `add` for each new record. Once
the home answers, the home's copy is the record, and every device changes it
by asking the home.**

- **Hand-over is a move** (ADR-0898), from the program's folder to the app's
  kept collection. The record keeps its id, so a hand-over that is sent
  twice is answered done the second time.
- **Files beside a record travel with it.** A recording's audio is handed
  over with its Markdown.
- **After hand-over, the home is where a record is read and changed.** The
  program lists records by asking the home, and an edit on any device runs
  the home's action. One copy is writable.
- **While the home is unreachable, only new records wait.** The program goes
  on making records in its own folder and hands them over when the home
  answers. An edit to a record the home holds is refused until then.
- **What hand-over leaves in the program's folder is not written again.**
  The program keeps it until the person deletes it.
- **The address is a setting on the program's computer.** Who may reach a
  home is decided by whoever runs it (ADR-0883): for the owner, the tailnet.

What Epicenter supplies is the same for every program: an `add` that is safe
to repeat, and files that travel beside a record. When a program hands over,
what it shows while the home is unreachable, and whether it hands over at
all are its developer's decisions.

## Consequences

- Nothing reconciles. Before hand-over the program writes a record; after
  it, the home does.
- A record the home holds cannot be edited while the home is unreachable.
- While the home is unreachable, a program that hands over shows what is in
  its own folder: for Whispering, the recordings made on that device.
- A program that needs the same record edited in two places while they
  cannot reach each other has no way here. It is a service of its own, which
  a home pulls from (ADR-0897).
- A file syncer stays the person's choice and risk (ADR-0896). Epicenter
  builds none.
- The three unbuilt pieces are ADR-0898's next items. A move between apps
  and a capture from a phone need the same `add`.

## Open

- Whether a program keeps a read-only copy of the home's records, so every
  record can be read while the home is unreachable.
- Which Whispering release carries hand-over.

## Considered alternatives

- **Every connected program delivers through actions.** A rule for all
  programs drawn from one. A program on the home shares the folder, and one
  that keeps nothing has nothing to deliver.
- **Two-way sync between a program's folder and the home,** merging by
  `key: <JSON>` line. The merge is the small part. It needs a base both sides
  share, so history on every device and a log they agree on; a rule for a
  delete against an edit, and for audio; and a client that does all of it on
  a phone and in a browser. ADR-0840 set that product aside.
- **A file syncer as the only way home** (ADR-0896). A program shows only its
  own device's records, and the home's copy and the device's drift apart.
- **Queue any action while the home is unreachable.** That queues edits to a
  truth the device cannot see, which ADR-0898 refuses. A queue of new records
  cannot collide.
- **A Git clone that pushes** (ADR-0887). Git on every device, and a merge on
  the home.

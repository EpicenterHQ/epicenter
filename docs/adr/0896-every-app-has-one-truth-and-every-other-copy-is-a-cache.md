# 0896. Every app has one truth, and every other copy is a cache

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) at its description of Epicenter, which this states as one sentence below.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (an action changes files), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (Proposed; its "one copy of each app" becomes one truth per app, which need not be on the home), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (a sign-in stays on its computer), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (the contract), [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (Whispering's folder), [ADR-0897](0897-notes-keeps-each-note-as-a-yjs-document-behind-its-markdown-contract.md) (Notes, the first service Epicenter runs).
- **Unbuilt:** a service app's `sync` as a shared shape, and Notes. Folder apps, their actions, and the CLI exist.

## Context

The owner's apps disagree about where their data's truth lives. Tasks,
Reading, Vocab, and Capture keep it in a folder on the home. Mail's truth is
Gmail; the home keeps a copy to read and query. Notes is meant to be hosted
at `notes.epicenter.so` for the owner and for customers, with a Markdown copy
on the owner's home for agents and backup. Whispering keeps its recordings in
its own folder on the computer it runs on.

Earlier drafts gave every app's data to the home and built an offline
outbox, a read-only mirror, a hosted home, a five-route protocol, and a
command to move an app between them. Each served one hypothetical case.
Gmail already shows the simpler account: a service holds the truth, and a
copy follows it.

## Decision

**Epicenter is where one person's software lives: small apps whose data is
Markdown in Git, which the person and their agents change through each app's
actions.**

Four rules follow from it.

1. **File over app.** An app's contract is the shape of its files. If any
   program disappears, the files and their history still read in tools the
   person already has.
2. **Every app has one truth.** The truth is a folder, or a service such as
   Gmail or `notes.epicenter.so`. Every other copy, in Markdown, SQLite, or a
   phone's storage, is a cache that follows it.
3. **Write to the truth, read anywhere.** Code writes through actions,
   everywhere: UIs, the CLI, and programs. A person or agent holding the
   truth's folder may also edit its files directly. A cache is never edited;
   a write goes to its truth, and the cache catches up.
4. **A program works alone.** A program that follows an app's contract needs
   no Epicenter.

That gives two kinds of app.

| Kind | The truth | The app's folder in `~/Epicenter` | Apps |
| --- | --- | --- | --- |
| Folder app | the folder | the truth | Tasks, Reading, Vocab, Capture |
| Service app | a service | a Markdown cache, refreshed by the app's `sync` action | Mail (Gmail), Notes (`notes.epicenter.so`) |

- **A program is not a kind of app.** Whispering, a UI, and Claude Code read
  or write a contract. Whispering's own folder is its truth on its computer
  (ADR-0894).
- **A cache is Markdown in Git.** It is the backup, what agents read, and
  what outlives the service. An index for queries, such as SQLite, is a
  `.local` file rebuilt from the Markdown.
- **A service app's actions write to its service.** `epicenter mail send`
  goes to Gmail, `epicenter notes edit` goes to `notes.epicenter.so`, and the
  app's `sync` then brings the change into the cache.
- **A service app lives where its sign-in does** (ADR-0870).

## Consequences

- No two copies are ever reconciled. A clash happens only at a truth, under
  that app's rule.
- Epicenter running Notes is one more service, as Gmail is; the home needs no
  second mechanism for it.
- An agent on the home reads every app the same way, as Markdown, whether the
  app's truth is its folder or a service.
- A service app cannot be written while its service is unreachable. Its cache
  still reads.

## Not yet

Each of these waits for a person who needs it.

- **A program delivering its records to a home through actions.** Actions
  accept JSON only (`packages/cli/src/http.ts:141`), so audio cannot travel,
  and no program needs it yet.
- **A generic offline outbox for actions.** Notes uses Yjs's own sync; no
  other app writes offline to a truth elsewhere.
- **Moving an app's truth between a home and a service.** Today that is an
  export and an import.
- **A published protocol for third parties.** `serve` already prints a
  contract as JSON Schema (`packages/cli/src/listing.ts:108`), unpromised.
- **Epicenter hosting any app other than Notes.**

## Considered alternatives

- **The home holds every app's truth.** Mail's truth is Gmail regardless, and
  people without an always-on computer get nothing.
- **A writable copy on both the home and a service.** Two writers need
  cross-site merging: the folder sync product ADR-0840 set aside.
- **A read-only mirror as its own noun.** A mirror of Notes and Mail's copy of
  Gmail are the same thing: a cache following a service.
- **SQLite as the cache.** Fast to query, but it fails the disappearance test
  and diffs poorly in Git; it stays the rebuilt index.

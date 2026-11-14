# 0897. Hosted Notes is a product beside Epicenter, and waits for a month of evidence

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) at "the folder sync product waits", for one product: a hosted Notes service for people who are not the one person, if the evidence below justifies it.
- **Relates:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) and [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (Yjs removed as the platform's store), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (a losing edit is kept), [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md) (each collection has one writer of record).
- **Unbuilt:** all of it.

## Context

The owner wants an Apple Notes-like app: every note on a phone offline, the
same note edited on two devices, for the owner and for customers, at
`notes.epicenter.so`.

The recorded evidence points the other way. ADR-0840 records that the owner
"rarely edit[s] on two computers in a week". The owner.s real notes are
`~/Code/vault`: about 3,400 pages, edited as files by the owner and by agents. They
have never been served through Epicenter.

A service for customers is accounts, storage, uptime, and a phone client for
people who are not the one person. ADR-0896 does not cover it: from an
Epicenter, `notes.epicenter.so` would be a service like Gmail.

The `@epicenter/workspace@0.3.0` tag holds earlier sync work: `packages/sync`
(the Yjs sync wire format) and `packages/server/src/room` (a room core with a
Cloudflare Durable Object adapter, an update log, and compaction). No package
depends on `yjs` today.

## Decision

**Hosted Notes is a product beside Epicenter, not an Epicenter app. It is
built only if a month of real use shows the need.**

1. **First, the month.** The vault is served from the owner's home as a
   folder app, read and edited from a phone through `serve`, without
   moving its history. The month records each time two devices edited one
   note before either saw the other's edit, and each time the phone could
   not reach the home when the owner wanted to write.
2. **A throwaway prototype may run during the month.** It starts no service,
   accounts, or Durable Object. It answers: two offline devices edit one note
   as a Yjs document per note and both edits survive; an agent's
   `notes.edit` lands as a minimal diff while a phone edits offline; front
   matter survives a round trip; an edit outlives a deletion.
3. **If the month shows real same-note collisions,** the service keeps each
   note as a Yjs document, built from the wire format and room core at the
   tag, and renders Markdown when a note changes. If it shows none, a note
   is plain Markdown, the later write wins, and the losing body is kept as a
   sibling note.
4. **Whatever is built carries its own disappearance clause.** Every client
   can export every note as Markdown with the service gone, because every
   client holds every note. A person's history starts when they first run
   the `notes` folder's pull on a computer they own; export alone has none.
   The product says so plainly.
5. **From an Epicenter, Notes is a cached collection** (ADR-0896). An agent
   on the home changes a note through an action that calls the service, as
   Mail's actions call Gmail. It never edits the pulled Markdown, and it
   cannot write while the service is unreachable. This is less than the
   vault gives today, and the owner chooses it knowingly.

## Consequences

- No Epicenter code handles Yjs.
- The owner's notes stay files the owner edits until the evidence says otherwise.
- If the service is built, customers get file over app without history
  unless they pull; Git pushed to a customer's own remote is the first
  addition if they ask, and needs Epicenter to hold a Git credential the
  vision currently refuses.

## Considered alternatives

- **Build hosted Notes now with Yjs.** Answers "can it merge" before "does it
  happen", against recorded evidence.
- **Notes as an Epicenter app whose truth is hosted.** Bent Layer 0 around one
  product and produced the app taxonomy ADR-0896 removed.
- **Push each customer's Markdown to a Git remote they name.** Holds
  customers' credentials and needs Git beside a Durable Object; a phone-only
  customer has no remote.
- **A three-way text merge.** Possible, since a device holding every note has
  the base; worth reconsidering if the month shows collisions but Yjs
  proves heavy.

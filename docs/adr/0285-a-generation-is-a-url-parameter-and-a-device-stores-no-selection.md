# 0285. A generation is a URL parameter, and a device stores no selection

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) removes generation identity from current opening and synchronization while preserving existing storage names.
- **Amends:** [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) at where the choice lives. Held-and-chosen is unchanged and every held generation is still fully live; what is withdrawn is the local ledger database, the stored selection, and the in-app switch.
- **Amends:** [ADR-0280](0280-a-browser-stores-durable-record-is-a-chain-of-updates-in-indexeddb-folded-on-idle.md) at the Web Lock. One database per generation makes the lock a per-generation lock, which is where `record.ts`'s one-writer assumption actually needs it.
- The route half was built and is now gone: `/device`, `/device/[generation]`,
  `/account`, and `/account/[generation]` existed in
  `apps/honeycrisp/src/routes/`, resolved the newest held generation, and
  redirected to the number. The local ledger database and the in-app switch this
  record withdrew were never built, which is what the original
  `Unbuilt: all of it` line meant and no longer says.
- **Amended by:** [ADR-0339](0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) at the URL. The generation is not a route parameter any more: `epicenter.data` resolves it, and both routes that carried it are deleted. What stands is the half this record is named for on the other side of the comma, that a device stores no selection.
- **Amended by:** [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) at the cache-first opener and generation-level bootstrap, and at the ADDRESS. The two lines below predate the storage epoch and put `local`/`account` before the data id; the scheme in ADR-0292 is the live one.

## Context

ADR-0281 made a generation an address and then, one paragraph later, gave a device a small ledger database to remember which address it had picked. That is a hidden, durable copy of a fact, and this design has spent its whole life deleting exactly that: the cursor, the outbox, `supersededBy`, and `current` were all remembered facts that something could have asked for instead.

An address's natural home in a web application is the URL.

## Decision

**The generation is an open parameter, carried in the URL, and nothing stores a selection.**

It is a **dynamic path segment**, not a query parameter, and Honeycrisp's
routes already have the shape it nests into: the realm is a segment today, so
the generation is the segment under it, and the URL mirrors the storage address
rather than merely referring to it.

```txt
  route                     storage
  /device/[generation]      epicenter/local/<dataId>/gen/<n>
  /account/[generation]     epicenter/account/<baseURL>/<principalId>/<dataId>/gen/<n>

  →  openAccount(definition, { baseURL, principalId, generation })
```

A path segment rather than `?gen=3` for one reason that decides it: **a missing
segment is a routing failure and a missing query parameter is silently the
wrong database.** Every link in the application would have to remember to carry
a query parameter, and forgetting one would resolve to the latest generation
and look like nothing at all.

- **Switching generation is a navigation.** The application reloads and opens a different IndexedDB database. There is no in-app switch, no state machine around one, and no live re-pointing of an open store.
- **Boot resolves the latest once and redirects, so the URL always carries a number.** Online, that is the ledger's browse list, which already exists. Offline, it is enumeration: `indexedDB.databases()`, filtered to this store's prefix, highest first. Firefox shipped `databases()` in 126, so every target browser enumerates.
- **A generation is complete when its application document is present**, checked by opening the candidate. This is the same trick the authority uses, and it means a mint interrupted halfway leaves a database that enumeration skips rather than a flag someone has to maintain.
- **The local realm has no ledger.** Allocation is `max(enumerated) + 1` under the Web Lock. Per-generation metadata, created-at and reason, lives in a reserved document *inside* the generation database, so it is dropped whole with the database it describes.
- **The Web Lock moves back onto the generation.** ADR-0281 lifted it to the ledger name because a drain held two generations at once; drains do not exist, and a compaction that reads one and writes another takes two locks. Two tabs on two different generations become legal and safe, because they are two disjoint databases.
- **The generation does not belong in the data definition.** `defineData({ id })` is compile-time and shared by every device and every account; a generation is per-device runtime state. It is an argument to the opener, beside `baseURL` and `principalId`.

## Consequences

- **A generation link must force a full document load.** SvelteKit reuses a `+page.svelte` instance across a param-only navigation, updating props rather than recreating the component, so a client-side navigation from `/account/2` to `/account/3` would leave a page holding an open database for the generation it is no longer showing. `data-sveltekit-reload` on the link is what makes "switching is a navigation" true rather than merely intended. This is the one attribute the whole read-once route shape depends on.
- The local ledger database, the stored selection, and the switch path all go. The pill keeps its inputs and loses its machinery: `selected` is the URL and `max(live)` is the browse list or the enumeration.
- **A deep link means the same thing everywhere.** Generation numbers are server-allocated and global, so a shared URL names one history rather than depending on what the receiving device happened to have selected.
- **What is refused, and it should be said out loud: "I live on generation 2" stops being durable.** A fresh launch resolves to the latest and redirects. An old generation is a place a person visits, not a home they configure. Somebody who wants to stay on one bookmarks it.
- Enumeration replaces a stored list, so a database written by a shape this code no longer opens is invisible rather than listed. That is the same property the storage naming already relies on.

## Considered alternatives

- **Keep the local ledger.** One more database, one more thing to keep consistent with the server's list, and a stored selection that a URL already carries.
- **Put the generation in the data definition.** Makes a per-device runtime fact a property of the application, so every device and account would share one, which is the opposite of the decision.

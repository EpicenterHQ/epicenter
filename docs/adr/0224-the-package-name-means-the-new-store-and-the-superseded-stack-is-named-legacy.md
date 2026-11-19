# 0224. The package name means the new store, and the superseded stack is named legacy

- **Status:** Accepted (first half stands; the `legacy` subpath it named was
  deleted by [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md))
- **Date:** 2026-08-08
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** ADR-0215,
  ADR-0223.
- **Half of this is spent.** `@epicenter/data` means the new store, which
  stands. `@epicenter/data/legacy` was a name for a stack that still had
  consumers; ADR-0227 removed the consumers and the subpath together, so a
  reference to `@epicenter/data/legacy` today is a straggler rather than a
  supported import.

## Context

`@epicenter/data` handed a developer `replica/`, `protocol/v1/` and
`sync-supervisor`. The store this branch exists to build was reachable only at
`@epicenter/data/store`, and its Bun opener was not exported at all. The front
door named the thing being replaced.

Leaving it was defensible only while nothing could open the new store. Once
Honeycrisp ran on it, the export was simply lying.

## Decision

**`.` is the store, the transport, and the vocabulary a Lens is written in.**
Runtime openers keep their own entry points, `./bun` and `./browser`, because a
Bun opener imports `bun:sqlite` and a browser opener imports a WASM build, and
neither belongs in a barrel the other has to load.

**The superseded stack moves whole to `@epicenter/data/legacy/*`, unchanged.**
Whispering, vocab, tab-manager and skills still run on it, so this is a rename
and a narrowing rather than a deletion. Every target module is the same file it
was, so no consumer's behaviour changes.

## Consequences

72 files change their import specifier and nothing changes meaning.

The name `legacy` is a deadline rather than a home. It is deliberately
unpleasant to type and deliberately says what it is, so a new consumer has to
decide to write it. When the last application moves, the directory goes.

A developer arriving at `@epicenter/data` now gets the thing being built. That
is the whole point, and it is worth stating that it was the LAST wave rather
than the first: pointing the front door at a store no application could open
would have been the same lie in the other direction.

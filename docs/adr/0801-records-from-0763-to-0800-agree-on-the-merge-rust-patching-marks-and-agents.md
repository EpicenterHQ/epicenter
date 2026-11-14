# 0801. Records from 0763 to 0800 agree on the merge, Rust's part, the marks, and agents

- **Status:** Superseded
- **Date:** 2026-11-05
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0763](0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md) at "Epicenter invents three things: names derived from a site, the merge rule `settle`, and the sync core": the second is the front-matter key merge; at "each of Whispering's four `#platform/*` seams becomes a capability's implementation": an app has no seams (ADR-0781); and at root 2, "never by calling each other": an agent running `epicenter mcp` is a person's tool running a command, not one Epicenter program calling another; [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at "Rust decides nothing about a note": Rust holds the front-matter primitive and key merge, twins of TypeScript's under one fixture, and nothing a contract means; [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at the two checks before a local repository: the iOS spike asks whether a native round finishes in the background, and no rquickjs spike or QuickJS remains; [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) at `epicenter set` writing "through the folder engine": it is a `patch` (ADR-0798); [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) at the browser's own storage: a web app keeps none (ADR-0786); [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) at the synced and waiting marks: they are ✓ and ◌, beside ADR-0789's ⚠; [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) at `<collection>_write`: it writes over the version `<collection>_get` returned, or over `'absent'` to create.
- **Relates:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) (the last such reconciliation), [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) through [ADR-0800](0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md).
- **Amended by:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at Rust holding the front-matter twin: it holds none.

## Context

A docs pass that rewrote `docs/vision.md` from ADR-0770 to ADR-0800 found
records that later ones overtook without amending: the doctrine still names
`settle` and Whispering's seams, ADR-0793 says Rust decides nothing about a
note while ADR-0795 to ADR-0797 put the key merge and field primitive in
Rust, ADR-0794's checks still weigh QuickJS after ADR-0795 removed the
callback that needed it, and a few lines name a mark, a write, or a storage
that later records changed.

## Decision

**What Epicenter invents is names derived from a site, the front-matter key
merge, and the sync core.**

**Rust holds the front-matter primitive and key merge as TypeScript's twin**,
held to one fixture, because a round merges by itself. Nothing in Rust reads a
contract, parses YAML, or decides what a field means.

**Before the core is linked into every app,** an iOS spike shows whether a
native round can finish while the app is in the background, and the founder
decides whether a local repository is a promise, judged against the
store-to-store prototype. Nothing remains to embed.

**An agent's tools are the person's tools.** An agent that starts
`epicenter mcp` runs a command as a person does; Epicenter's programs still
never call each other.

**The marks are ✓ synced, ◌ waiting, and ⚠ conflict.** `epicenter set` is a
patch. A web app keeps no storage of its own. An agent's
`<collection>_write` carries the version its `<collection>_get` returned, or
`'absent'` to create, and a stale write answers so.

## Consequences

- The doctrine's list of inventions matches what Epicenter builds.
- ADR-0763's rule for apps no longer names seams the code deleted.

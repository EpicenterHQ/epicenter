# 0787. Records that assumed a running engine or a build-time choice follow ADR-0750 and ADR-0781

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "after its first sync a folder is committed each round while the Epicenter app runs": a folder is committed at each round its app runs; [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "`append` stays on a file collection whose store has it": no store appends (ADR-0779); [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) at "The app and the engine read and write the same file": they do, under a lock held from a refresh's read to its write; [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) at "no refresh needs a lock across processes": true of an app, which is one process, not of the CLI; [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at "Epicenter writes the note once": the one write carries ADR-0750's sync instruction; [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at "the server keeps the TypeScript `settle`" and [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) at "the server settles it against `main`": `settle` runs in the core and in the page, and the server refuses a stale base (ADR-0773); [ADR-0765](0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md) at "the `tauri` export condition picks its implementation", [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at "the build picks the implementation", [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "which the build picks", and [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) at "the implementation the build picks": the package picks when it runs (ADR-0781); [ADR-0763](0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md) at root 1's "A folder's path derives from the app's site": a folder is found by its `AGENTS.md` under `~/Epicenter`, and nothing stores a location (ADR-0772); [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) at "the desktop app with Epicenter" and [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) at "a Mac with Epicenter quit does not sync": the installed app syncs its own folder; [ADR-0783](0783-a-secret-lives-in-the-apps-credentials-file-and-is-read-by-the-request-that-uses-it.md) at what happens to keychain entries: nothing reads them.
- **Relates:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (sync at a person's moments), [ADR-0781](0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md) (the package picks when it runs).
- **Amended by:** [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at the CLI and the Epicenter app sharing one credentials file: each program keeps its own.
- **Amended by:** [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at "The core runs it in a round": the core asks its host.
- **Amended by:** [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) at what the `AGENTS.md` Epicenter writes says: it also states the front-matter grammar.
- **Unbuilt:** the lock around a refresh of the CLI's and Epicenter's shared token file; the sync instruction in the `AGENTS.md` Epicenter writes.

## Context

ADR-0750 and ADR-0751 replaced the Epicenter app's background
`sync --watch` with rounds each program runs at a person's moments, and
ADR-0781 replaced the build's choice of a capability's implementation with
the package's choice when it runs. Records written after them on the same
two days still assumed the earlier world, and a sweep of ADR-0740 to
ADR-0786 found where.

## Decision

**History follows the app's rounds.** A folder is committed at each round
its app runs (ADR-0750); before its first sync it keeps no history
(ADR-0772). A key's losing value stays in history once a round committed
it, so two writes between rounds can lose one.

**A credential shared by processes is refreshed under a lock.** An app is
one process and refreshes alone (ADR-0785). The CLI is many: two agents can
run `epicenter sync` at once, and the native host is the same program. The
CLI and the Epicenter app keep sharing one file in Epicenter's AppData
(ADR-0732), and every refresh holds a file lock from reading the token to
writing the rotated one.

**The one `AGENTS.md` Epicenter writes says how agents sync.** The note is
written when Epicenter makes the folder and carries ADR-0750's instruction
from the start; a folder made before has none, and its agents' edits sync
at the app's next moment.

**`settle` runs where a write is made.** The core runs it in a round, and
the page runs the TypeScript `settle` before its write (ADR-0774). The
server merges nothing: it refuses a write over a stale base (ADR-0773).
The TypeScript tests in `packages/definition/src/merge` stay the suite both
pass.

**A capability's implementation is the package's choice when it runs**,
wherever a record said the build picks it (ADR-0781). The `test` export
condition stays: a test run is not a surface a person uses, and a run that
loses it fails rather than shipping.

**Doctrine root 1 finds folders by `AGENTS.md`.** No program stores a
location or keeps a registry of folders, because a folder is found by what
it says it is (ADR-0772), not by a path derived from the app's site.

**The installed app syncs its own folder**, wherever a record said
offline use with sync needs Epicenter.

**Keychain entries are left alone.** Nothing reads, imports, or removes
them, and an app says nothing about them after an upgrade: a person signs
in again and enters their keys again.

## Consequences

- The CLI's token refresh is the one place a lock guards a credential.
- Doctrine checks (ADR-0719, ADR-0763) and the next passes (the sync core,
  discovery, one build) read records that agree with each other.

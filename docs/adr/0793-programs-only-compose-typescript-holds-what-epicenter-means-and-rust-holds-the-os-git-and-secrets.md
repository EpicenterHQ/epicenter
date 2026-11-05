# 0793. Programs only compose: TypeScript holds what Epicenter means, and Rust holds the OS, Git, and secrets

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at "`settle` moves into the core" and "Two `settle` implementations exist": `settle` has one implementation, in TypeScript, and the core asks its host for it (ADR-0794); [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "`settle` has two implementations, TypeScript and Rust": it has one; [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at "The CLI and the Epicenter app keep sharing one file in Epicenter's AppData": the CLI is its own OAuth client with its own credentials file, and the library keeps its own; [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) at "The app and the engine read and write the same file": each reads its own; [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) at "The library asks `epicenter query --json --watch` for the names": the library builds the same tables in its own page, and neither runs nor carries the CLI.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (standards and places), [ADR-0763](0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md) (the doctrine), [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (packages are capabilities, formats, framework layers, and programs), [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) (a sign-in serves one program).
- **Amended by:** [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) at `settle` having one TypeScript implementation: bodies merge by Git's merge, and front matter by a key rule written once in each language under one fixture.
- **Unbuilt:** all of it: the CLI's own OAuth client and credentials file in place of the keychain (`packages/cli/src/secrets.ts`); the query's table builder as a TypeScript package given a SQLite handle, `bun:sqlite` in the CLI and sqlite-wasm in the library's page; the CLI's installer apart from the Epicenter app, and the library's offer to install it; deleting `apps/epicenter/src-tauri/src/cli.rs` and `synced_folders.rs`; the server's path rule in `packages/tauri-plugin-epicenter-folder/fixtures/path-rules.json`, and a path check at checkout.

## Context

Records kept assigning logic to programs: Epicenter syncs, the CLI holds the
account, the shell holds keys, the library runs the CLI. Each time a second
program needed the same thing, it was copied or a record was written about
who owns it, and later records swept the earlier ones (ADR-0787). `settle`
was planned in TypeScript and again in Rust under a parity suite; the CLI
keeps credentials in the keychain while the apps' shells keep them in a file;
the library's queries were to run in a second process beside a page that
already holds every note. An adversarial review of three independent
reviewers, each reading the code, agreed on the rule below.

Two languages cannot be reduced: a page runs JavaScript, and Git's object
store, the file system, and secrets kept from a page need native code.
`settle` depends on the note format, canonical YAML, and the contract's key
order (`packages/definition/src/merge/settle.ts`, `note/canonical.ts`); a
Rust port is about 1,900 lines held to byte parity, and the page would still
settle its own writes in TypeScript.

## Decision

**A program holds no logic of its own; it composes packages.** Each piece of
logic lives in one package, in the language every program that needs it can
run.

| Kind | Language | Pieces |
| --- | --- | --- |
| What Epicenter means | TypeScript | contracts, field helpers, validation, notes parsed and formatted, `settle`, conflict marks, the folder engine, query tables, discovery by `AGENTS.md` |
| What needs the OS, Git's object store, or a secret kept from a page | Rust | a round's Git work (commit, fetch, tree merge, LFS, checkout, push, lock), files with stamps and watching, an app's credentials file, audio, local models, shortcuts, paste |

Rust decides nothing about a note. Each authority enforces its own rules in
its own language: the shell's storage, the core's checkout, and the server's
write route each check paths, and a rule they share is one fixture each of
them reads.

**Every program is a composition of the same packages, differing in its
hands.**

```txt
desktop or phone app   the page composes capabilities in app.ts; the shell links what they need
web app                the page composes the same, over the repository store
epicenter CLI          Bun composes the engine, sync, and query; the core through Node-API
library app           an app over many folders, composing the engine, sync, and query
server                 the repository; it never merges (ADR-0773)
```

**The CLI is its own program.** It installs apart from any app, signs in as
its own OAuth client, and keeps its own credentials file, refreshed under a
lock among its own processes. The library offers to install it and neither
runs nor carries it. A program that needs a query composes the query
package and gives it SQLite.

## Consequences

- `settle` has one implementation, with no Rust port or parity suite.
- The Epicenter app drops the 75 MB CLI and its child processes; the CLI
  drops the keychain.
- A person who wants the command line and the library installs both and
  signs each in.
- The library's grant reaches every team repository it syncs, unlike an
  app's, which reaches its own.
- A record that places logic names a package, never a program.

## Considered alternatives

- **`settle` ported to Rust:** two implementations of the note format.
- **A Rust kernel compiled to WebAssembly for every program:** moves the note
  format out of the language contracts are written in, and adds weight and a
  wait to every page's first load.
- **The CLI loading the apps' Rust credentials through Node-API:** that code
  is built on Tauri types and refreshes without a lock, since an app is one
  process; two clients of one standard repeat nothing Epicenter invented.
- **The library bundling and running the CLI:** a second copy of every note in
  a second process, a version to keep in step, and a process boundary under
  every filter.

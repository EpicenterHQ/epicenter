# epicenter-core

The sync core every native Epicenter program links
([ADR-0751](../../docs/adr/0751-every-native-app-carries-one-sync-core.md)):
one sync round for a folder over libgit2, in-process, with Git LFS, first
contact, the note merge, and the round lock. No `git` or `git-lfs` program
runs.

```txt
src/            the Rust crate `epicenter-core`
napi/src/       the Node-API addon crate `epicenter-core-napi`
napi/index.ts   `@epicenter/core`: the addon, typed, with settle as its note merge
```

## `@epicenter/core`

The Bun-facing workspace package. It loads `napi/epicenter_core.node` with a
`require` of a literal relative path, so `bun build --compile` embeds the
addon in the executable, and it passes `settle` from
`@epicenter/definition/merge` to every round. The `epicenter` CLI
(`packages/cli`) is its program.

```sh
bun run --cwd packages/epicenter-core build   # cargo build --release, then copy the addon beside index.ts
bun run --cwd packages/epicenter-core test    # build, then the Bun tests in napi/test
bun run --cwd packages/cli compile            # build the addon, then compile the CLI with it embedded
```

A round never rejects for a stop: it resolves `synced`, `retry` (the
network, a held lock, a remote that kept moving), or `stopped` (a person or
agent must act), with `message` saying why.

## The crate

`cargo test` in this directory runs the round, transport, lock, and repack
suites against `git http-backend` behind a bearer token. The directory is a
Cargo workspace of its own, excluded from the root one, because the
Node-API binding must unwind on a panic and the root profile aborts.

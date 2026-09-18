# 0190. A build declares which Epicenter owns its data, not which window it runs in

- **Status:** Accepted
- **Date:** 2026-07-30
- **Amended by:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md) at the OPFS clause only, which is withdrawn: a store's durable record in a browser tab and in a Tauri WebView alike is IndexedDB, written directly, at the address [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md) spells. The keychain credential, and the decision that a build declares which Epicenter owns its data, stand. And by [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) at "an application gets a native capability file only when it calls native commands" and at the refusal of the trusted-app file "for symmetry": the host grants every native verb to every window, so no application has or lacks a capability file. The build-declares-ownership rule stands for the apps' own seams; [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) withdraws it for `@epicenter/app`, which selects at runtime.
- **Relates:** [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md) (Home lists and launches compiled applications; this record decides how one is built and where its data lives), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), [ADR-0165](0165-browser-origins-contain-independent-epicenter-replicas.md), [ADR-0177](0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md), [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md)

> **2026-09-05 amendment:** The `## Context` sentence below saying Honeycrisp's
> standalone bundle "owns its own OPFS storage" is stale, and only in its
> medium. A build that owns its own store owns an IndexedDB record in its own
> storage partition (`packages/data/src/store/browser.ts`, which holds the only
> persistence there is and states why there is no worker and no OPFS). Which
> Epicenter owns the data is still fixed at build time by the condition this
> record decides.

## Context

Whispering was the only compiled application, and for it two questions had one
answer: it runs in a Tauri WebView, and the desktop Epicenter host owns its
replica. So one `tauri` resolve condition answered both, and the host named
Whispering four separate times to serve it.

Honeycrisp breaks the coincidence. It already ships a standalone desktop bundle
that runs in a Tauri WebView and owns its own OPFS storage and its own keychain
credential. Compiling it for the host under the same condition would have made
"which Epicenter am I talking to" unanswerable, and the failure would have been
silent: it would still build, still start, and quietly keep notes where nothing
else can read them.

## Decision

An application build declares `epicenter-host` when the desktop Epicenter host
serves it and owns its replica, its credential, and its deployment choice.
`tauri` keeps its plain meaning, that the build runs in a Tauri WebView, and the
two are independent. A build that owns its own storage uses neither, whether it
is served by a browser or wrapped in its own bundle: a WebView is a storage
partition and origin pair like any other (ADR-0177), so the hosted web SPA and a
standalone bundle are the same case.

A compiled application is exactly a `dist/<id>` build the release declares. The
host loads every declared application's build and serves each below `/apps/<id>/`
through the resolver that already served admitted folders, so nothing about an
application is named more than once. A declared application that did not build
refuses the boot, because Home lists what the release declared and a 404 behind a
listed row is worse than failing loudly.

An application gets a native capability file only when it calls native commands.
Reaching Epicenter is same-origin HTTP on the loopback origin and needs no grant.

## Consequences

- The question "where does this build keep my data" has one answer, in the
  filename, fixed at build time. No build asks the DOM, and no build can be
  wrong about it later.
- Honeycrisp's rows and note documents live in the host-owned
  `epicenter.sqlite3`, so Home's tools read what the application just wrote with
  no second replica and no sync round trip between them. Its two Lenses stay
  separate release-local interpretations (ADR-0168), which is now a drift risk a
  test carries rather than an unstated hope.
- Admitting a third compiled application is a list entry, a build script, and a
  window-table row. It is not another asset field, resolver, or route handler.
- Whispering declares both conditions, because both are true of the one build
  Epicenter serves, and its seams split along the same line: replica,
  credential, deployment choice, blob bytes, and asset base are the host's;
  recording, clipboard, notification, and HTTP are Tauri's. It has no build where
  they come apart, so this changes nothing it emits. It changes what its files
  say they are, which is the point: one role, one spelling, repo-wide.
- Honeycrisp's standalone desktop bundle survives, so the same person can run two
  desktop Honeycrisps over two different databases. Nothing migrates between
  them and nothing pretends to. Retiring that bundle is a separate decision, and
  it owes an answer about the notes already in its WebView storage.
- An application that never calls a native command has no capability file at all.
  What was read as "the surface a trusted app reaches" was Whispering's own
  authority; this makes that visible without changing any grant.

## Considered alternatives

- **Reusing `tauri` for the hosted build.** Rejected: Honeycrisp's standalone
  bundle is a Tauri WebView that owns its own storage, so the condition would
  have to mean two opposite things in one package.
- **A runtime check for the host.** Rejected: the bundler already fixed the
  answer, and a second weaker copy of it in the DOM can disagree with the first.
- **Discovering compiled builds from the dist directory.** Rejected: it turns a
  missing build into a missing application instead of a failed boot, which is the
  one outcome a person cannot diagnose from Home.
- **Giving Honeycrisp the trusted-app capability file for symmetry.** Rejected:
  it grants HTTP egress and recording commands to a window that asks for
  neither, and "for symmetry" is how a capability file becomes a default.
- **Retiring the standalone Honeycrisp bundle in the same change.** Rejected
  here, not on the merits: it strands notes already in that bundle's storage, so
  it needs an answer about them first.

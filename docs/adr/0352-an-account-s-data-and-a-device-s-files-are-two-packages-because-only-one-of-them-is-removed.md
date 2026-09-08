# 0352. An account's data and a device's files are two packages, because only one of them is removed

- **Status:** Accepted
- **Date:** 2026-09-06
- **Amends:** [ADR-0339](0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) at its mechanism. "An application creates one epicenter" stands and is what this record extends; `EpicenterBinding`, `EpicenterBindingFactory`, the `binding` option on `createEpicenter`, and the sentence calling the factory "the contract every seam leaf annotates against" are withdrawn. The `Epicenter<never>` overload this mechanism produced, which let Local Mail hold files and secrets without a store, is withdrawn with them: that type is now `Device`.
- **Relates:** [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) (what an app-owned file is), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (a secret is a labelled credential), [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md) (the replica address carries the principal), [ADR-0351](0351-local-data-removal-is-an-explicit-sign-out-choice.md) (what removal takes), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md)

- **Amended by:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at account-only declared tables and device-only named SQLite: sessions expose tables and scoped SQL files; secrets retain their device lifetime.

## Context

`@epicenter/app` held two unrelated things behind one handle: a data session,
which opens one person's replica, and named SQLite files plus secrets, which the
runtime owns. One constructor took both, and the second half arrived through a
`#platform/binding` seam that every application declared.

Three of the four applications that composed a handle never called the second
half. Honeycrisp and Whispering each declared the seam, shipped two leaf files,
listed the condition in `package.json`, and ran a test asserting which leaf each
condition picks. Vocab did not even have a decision to make and still paid: it
shipped one unconditioned binding file whose own comment said "It uses neither
capability today". All three pulled an OPFS SQLite worker and
`@sqlite.org/sqlite-wasm` into the bundle graph to satisfy a constructor
argument none of them read. `apps/local-mail` is the only application that opens
a file or keeps a secret.

The cost was not only bundles. ADR-0351 decides that a person may remove this
application's local data for one account, and ADR-0348 gives a replica an
address that carries the principal. Neither a SQLite file nor a keychain entry
has a principal: a file is a device cache an application opens before anyone
signs in, and a keychain entry is how an account is reached at all. So removal
must take one and not the other, and a handle that offered both as peers made
that distinction invisible at exactly the surface where it decides what gets
deleted.

## Decision

**Two packages, split on whose the bytes are and where they live.**

| | `@epicenter/data` | `@epicenter/device` |
| --- | --- | --- |
| whose | an account's | this machine's |
| scoped by | app and principal | app |
| varies by runtime | no | yes |
| removed by "remove local data" | yes | no |

`@epicenter/app` composes the first into a session. `@epicenter/device` is the
second, and the name is the axis rather than a prefix: `app-storage` reads as a
part of `app` when it is a sibling, and it is worse than that here, because a
replica IS storage and the interesting question is whose.

**`Device` is the type, and the application id is an argument, not a member.**
`createBrowserDevice({ appId })` and `createDesktopDevice({ appId })` return
`{ sqlite: { open, delete }, secrets }`. Both narrow the id where it is
supplied, so a bad one is refused at construction rather than arriving at the
host as a rejected request against an application that never existed.

**There is one seam and one application holds it.** `#platform/device` selects
the runtime, and only `apps/local-mail` declares it. An application that opens no
file and keeps no secret declares no storage seam, which is what removes the
worker from three bundles.

**`EpicenterBindingFactory` is deleted rather than renamed.** It was a function
of `appId` so that a handle and a binding could not disagree about which
application they scoped. With one object there is nothing to disagree with.

## Consequences

- **Removal has an obvious target.** Invariant: a copy belongs to an app and a
  principal; a file belongs to an app and a device. The packages say which is
  which, so the exit work in ADR-0351 cannot reach the wrong one by accident.
- **Three applications stop shipping a SQLite worker they never called**, along
  with the seam declaration and two leaves Honeycrisp and Whispering each
  carried, and the one leaf Vocab carried.
- **The device-seam assertion is written where the seam now is.** A dropped
  `epicenter-host` leaf sends the host-served build to OPFS and tab memory while
  still building and starting. Honeycrisp's and Whispering's selection tests
  survive without their binding arms, and `apps/local-mail/ui` gains the one
  that covers this seam.
- **`Device` varies by runtime and `@epicenter/app` no longer does.** The
  session package has no platform seam under it and must not grow one: the store
  is client-owned in every runtime (ADR-0226, ADR-0227).
- **The wire renamed with the package.** `/api/app-storage` is `/api/device`.
  The host serves it and the page calls it, and they ship together.
- **Blobs do not join this package, and do not join the handle either.** ADR-0349
  proposed `EpicenterBinding` gaining a `blobs` member; that type is gone, and
  the reason it wanted one does not survive. Blob bytes are principal-scoped,
  which makes them `@epicenter/data`'s kind of thing and the exit coordinator's
  business, while their storage varies by runtime, which is the app's own
  `#platform/blobs` seam. ADR-0349 is amended at that paragraph, and which
  object carries the blob verbs is reopened rather than answered.

## Considered alternatives

- **Keep one handle and one seam.** Refused. It made three applications carry a
  runtime seam for a capability they never used, and it put account data and
  device data on one object at the surface that decides what removal deletes.
- **`@epicenter/app-storage`.** Refused on the name. `app` / `app-shell` /
  `app-storage` groups three unrelated things under one prefix, and `X-storage`
  reads as a part of `X` rather than a sibling.
- **A `blobs` member on the binding, per ADR-0349.** Refused above.
- **Split the type but keep one package with two subpaths.** Refused. The
  subpaths would still drag `@epicenter/sqlite`, `@sqlite.org/sqlite-wasm`, and a
  Playwright evidence harness into the dependency tree of every application that
  opens a store, which is the cost the split exists to remove.
- **One constructor taking a runtime, `createDevice({ runtime })`.** Refused. It
  puts both transports in one module graph, which returns the OPFS worker to the
  desktop build and the host transport to the web one. The runtime is the import
  path, and the seam test proves it per condition.

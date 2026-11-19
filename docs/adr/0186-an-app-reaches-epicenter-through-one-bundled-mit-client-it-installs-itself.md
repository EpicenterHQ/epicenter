# 0186. An app reaches Epicenter through one bundled MIT client it installs itself

- **Status:** Accepted
- **Date:** 2026-07-28
- **Superseded by:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md): the third-party installed-app plane is refused for now, so the bundled client this record exists to define is deleted with it. `packages/lens`, the inert vocabulary this record's amendment moved the contract into, survives.
- **Amends:** [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) at the delivery and namespace boundary: it settles how an app obtains the handle, which ADR-0181 left open, and adds `recording` to the initial capability set. The handle's shape, its refusal of optional namespaces, and its transcription rules are unchanged. Also [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at one bounded clause of the native command surface: recording and transcription reach every app window through the app-window capability file, so they no longer stay host-only or bound to Whispering. The admission boundary, the full-trust ceremony, and the refusal of per-app permissions and prompts are unchanged.
- **Amended by:** [ADR-0187](0187-a-bound-handle-reports-staleness-tables-can-name-rows-values-cannot.md), which settles the `data` half of what this record deferred; and [ADR-0211](0211-an-installed-app-runs-only-inside-epicenter-so-its-client-stops-asking.md), which withdraws the dual-mode promise below and deletes `HostUnavailable`, because an installed app is served by a host and runs nowhere else
- **Relates:** ADR-0180, [ADR-0184](0184-one-host-recorder-progressively-stages-each-claimable-recording-until-its-owner-stops-or-cancels-it.md)

## Context

ADR-0181 settled the shape of the application handle and said nothing about how
an app gets one. Both were open, and the delivery question turned out to be the
one that decides whether the shape is reachable at all.

Host-served ESM looked right: Epicenter knows its own runtime, so serving
`/epicenter/sdk.js` would let the host keep the client and the host in step. It
does not survive contact with a build tool. Vite tries to resolve root-absolute
imports at dev and at build, so every app author would need externalization
config for a module the host claims to provide for free, which is the opposite
of what host-serving was supposed to buy. The premise underneath it was also
wrong: where a script is served has no effect on Tauri's access control, which
derives its identity from the window label and document origin. The host gains
nothing by owning the delivery.

Meanwhile the capability the product actually leads with is not in ADR-0181's
list. ADR-0184 rebuilt the host recorder around a claimable recording that
survives its own capture, and only Whispering could reach it. An app that can
transcribe but cannot record can do nothing end to end.

## Decision

**An app reaches Epicenter by installing an ordinary package.**
`@epicenter/app` is published, MIT, and bundled by the app's own build like any
other dependency. Epicenter serves no client module, injects no global,
rewrites no application HTML, publishes no import map, and requires no
plugin, alias, resolve condition, or externalization from an app's build.

**It ships compiled output.** Every other Epicenter package publishes raw
TypeScript, which is correct while the consumers are this repository's own
bundlers. This one is consumed by toolchains we do not control, so it ships
`.js` and `.d.ts` and does not make its type checking a stranger's problem.

**It speaks the host's published transport.** The client calls `invoke` and
`listen` from `@tauri-apps/api`, the same public API the host's own generated
bindings use, rather than reimplementing them against `__TAURI_INTERNALS__`. It
reads that global for one purpose only: `invoke` dereferences it, so its
presence is exactly the question "would this call reach a host". Detecting the
transport is the client's job and never the application's.

**`recording` joins the handle**, beside `transcription`, as a stable product
capability with its own invariants. It is the second namespace, not a category:

```ts
epicenter.recording.start();
epicenter.recording.current();
epicenter.recording.stop(audioBlobId);
epicenter.recording.cancel(audioBlobId);
epicenter.recording.onEnded(handler);
```

`start` records from the system default microphone and reports which one
opened. There is no device enumeration, no device selection, no level stream,
no long-form mode, and no capture rate: those are ADR-0184's refusals and this
record does not reopen them. `onEnded` is an app-level subscription rather than
a per-recording one, so it is installed before anything is recording and no
ending can fall into a gap; it stays best-effort, and `current().endedReason`
remains the durable recovery path exactly as ADR-0184 requires.

**Environment differences are typed values.** An operation outside an Epicenter
host answers `HostUnavailable` (withdrawn by ADR-0211: there is no outside);
an operation a window was never granted answers
`CapabilityUnavailable`. Neither is a missing namespace, an optional method, or
a rejected promise. An unrecognized failure becomes that operation's `*Failed`
variant with its cause attached, never an "unavailable": unavailability is a
claim about the system, and making it the landing place for anything unknown
would make the claim worthless.

**The client's surface is the product boundary, not the crate's.** It names the
host commands it calls by hand rather than generating them, because a generator
exports whatever the crate happens to register. The app-window capability grants
exactly those commands and no others, and that equality is tested in both
directions.

**No protocol version and no negotiation.** The existing Rust command surface is
the compatibility boundary until a real incompatible generation exists.

### Deliberately not decided here

How `data` and `blobs` reach an app. ADR-0181 names both as namespaces of the
same handle, and this record neither delivers them nor decides that they arrive
the same way. They are the interesting case: recording and transcription are
thin wrappers over host commands, while a local-first replica is a substantial
runtime that this client deliberately does not depend on.

> **Amended by ADR-0187.** `data` is now decided and delivered. The answer
> preserved this record's constraint rather than relaxing it: the client speaks
> the host's small JSON wire vocabulary over the same origin and does not depend
> on the replica runtime. What an app declares its contract with moved into a
> separate inert, compiled, MIT vocabulary package, so a shared contract can be
> imported by two apps without either of them, or the contract itself, depending
> on this client. `blobs` remains undecided.

## Consequences

- An app author runs one install and one import. Nothing about the
  `@epicenter/app` client appears in their build configuration, which is what
  makes "write an Epicenter app" a normal web development task. The app's
  finished static files still use relative URLs because the catalog serves them
  below `/apps/<id>/` (ADR-0179).
- The same import compiles and runs in an ordinary browser tab, so an app can
  be developed and tested outside the desktop host and degrade honestly inside
  it.
- Epicenter loses the ability to update an installed app's client by updating
  the host. A client and a host now version independently, which is the cost of
  not owning delivery, and the reason the Rust command surface is the
  compatibility boundary rather than a negotiated protocol.
- A published MIT package is permissive forever. `@epicenter/app` is a product
  boundary we are choosing to give away, and its entire dependency closure must
  stay MIT-compatible.
- The client is written against the host's protocol rather than shared with
  Whispering's implementation. Two clients now speak the same commands, and the
  drift test is what keeps them honest rather than a shared module, because the
  app is AGPL and the client is MIT.
- Every installed app can now record and transcribe. That is a real widening of
  the third source of authority ADR-0179 enumerates, and it withdraws that
  record's statement that specialized native commands stay host-only or bound
  to Whispering. The trust model underneath is unchanged and is what makes the
  widening admissible: admission is the protection, and an admitted app runs as
  Epicenter.
- The first emitting package in this repository. The build step is small and
  the convention is now split: source-only for internal packages, compiled for
  the one we hand to strangers.

## Considered alternatives

- **Host-served ESM at `/epicenter/sdk.js`.** Rejected: app builds try to
  resolve root-absolute imports, so it forces externalization config on every
  consumer, and it buys no authority because Tauri's access control does not
  care where a script came from.
- **Inject `globalThis.epicenter`.** Rejected: it is untyped at the import
  boundary, invisible to a bundler, and turns a missing host into a missing
  global that every app has to guard.
- **Generate the client from `tauri-specta` like Whispering's bindings.**
  Rejected: it would export whatever the crate registers, making API admission
  a side effect of registration. It would also copy the crate's own
  documentation into an MIT package, which is a relicensing act.
- **Reuse Whispering's recorder service.** Rejected for the same license
  reason, and because its shape is Whispering's (device pickers, level meters,
  per-recording objects) rather than the narrow one an app needs.
- **Bundle `@tauri-apps/api` to reach zero runtime dependencies.** Rejected: it
  would either vendor a copy that goes stale or push us onto
  `__TAURI_INTERNALS__`, trading a published contract for a private one to save
  one small permissive dependency.
- **An `openEpicenter()` factory.** Rejected: there is no connection, no
  session, and no configuration behind the handle, so an opener would only make
  every app write a line that does nothing.
- **Expose microphone permission query and request.** Rejected for this slice:
  the OS grant belongs to the Epicenter application, not to an app, and
  ADR-0179 refuses per-app device prompts. A denial surfaces as a typed
  `MicrophoneAccessDenied` from `start`, and the recovery is in system
  settings.
- **Report the host's device-acquisition union.** Rejected: a client that never
  names a device can only ever receive one arm of it, so the union would be
  surface an app could read and never act on. Only the microphone's name
  survives.

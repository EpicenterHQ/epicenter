# App composition greenfield

**Date**: 2026-09-12
**Status**: Draft
**Owner**: Braden Wong
**Branch**: braden-w/app-schema-derive-export-import
**Grows from**: ADR-0388, ADR-0389, ADR-0390, ADR-0391
**Superseded by**: `specs/20260912T112824-app-hub-and-whispering-transcription-collapse.md`

## One sentence

An application declares its id and data once; the build selects every
implementation; the open call decides the App's type; shared code takes
capabilities, never the handle; the platform is reached by direct import.

## How to read this spec

Read first: One sentence, Current state, Target shape, Waves, Verification.
Read if changing the direction: Open questions, Rejected shapes.

## Current state

- `@epicenter/app/clipboard` exists as the first platform module (ADR-0387,
  ADR-0388). Whispering's text service no longer has clipboard methods.
- `App<T>` is `LocalApp<T> | AccountApp<T>`, discriminated by `library`; a
  local App has no `account` or `retirement` (ADR-0389). `AppAi.account`
  carries its identity and app-shell takes `ai: AppAi` (ADR-0390).
- `defineApplication` accepts `runtime`, `ai`, `settingsKey`. Only Whispering
  passes `runtime`; all three apps pass `settingsKey`. The package's host AI
  leaf supplies the native inference transport, so no app passes `ai`.
- The default runtime cannot flip to host blobs and recording until the
  `honeycrisp` and `mail` windows hold the trusted app-window capability:
  desktop recording's `close()` invokes `current_recording` on every acquired
  App, and those windows lack that permission.
- No standard app declares a blob field. Their host-build blob stores are
  IndexedDB and empty.
- Whispering's `services` barrel holds analytics, text, download, local
  shortcuts, and sound.

## Target shape

```ts
import { defineApplication } from '@epicenter/app';
import { clipboard } from '@epicenter/app/clipboard';

const application = defineApplication({ appId, definition });
const personal = application.openPersonal(account); // AccountApp<T>
const local = application.openLocal();              // LocalApp<T>

pickInference({ ai: personal.ai });                 // a capability, not the App
await clipboard.writeText(text);                    // the platform, no App
```

Membership rule (ADR-0388): on the App if it captures an open-time fact or
close must drain it; otherwise a direct import selected by the build.

## Waves

Each wave is independently shippable and verified before the next starts.
Waves for ADR-0389 and ADR-0390 have shipped and are deleted from this list.

1. **The build selects everything.** `#platform/runtime` seam; the host AI
   leaf supplies the native inference transport; delete `runtime`, `ai`,
   `settingsKey`, `ApplicationRuntime`, `AppBlobFactory`, the `/browser` and
   `/epicenter-host` exports, and Whispering's `#platform/runtime` and
   `#platform/ai` seams. Ships with the prefix migration. (ADR-0391)
2. **Platform modules.** Download, sound, OS notification, platform
   information, and the opener move to `@epicenter/app/<x>` using the same
   `createX(source)` normalization shape the clipboard uses. (ADR-0388)
3. **Docs.** Rewrite `docs/CONTEXT.md`'s App composition section, add a
   "capability" entry, and reconcile ADR-0304's desktop layout with the blob
   layout the host writes.

## Open questions

Each is a product or durable-string decision the evidence cannot settle.

- **Wave 1, storage prefix migration.** Three apps change prefix. The
  desktop catalog dedupes imports by `${appId}:${prefix}`, so a renamed
  prefix re-imports and throws on any field conflict. Decide whether the
  migration rewrites the catalog's import list or the desktop host, still at
  version 0.0.1 with no release, is treated as having no installed base.
- **Wave 1, test doubles.** Eight tests substitute sqlite and blobs through
  `runtime`. Decide between a `#platform/runtime` test leaf, a seam-level
  `mock.module` (the shape `bootstrap-failure.test.ts` already uses), or
  opening the store directly.
- **Any wave, capability windows.** `honeycrisp` and `mail` are real
  window labels that match neither `app-*` nor `whispering`, so the trusted
  app-window capability (HTTP egress, recording commands, clipboard) does not
  reach them. Decide whether they join that capability's windows or stay
  outside it until they need a native capability.
- **Later, replica surface.** `sync` is declared on every data document and
  `retirement` is produced by the store opener's closure from five internal
  values. Deciding whether replicas get their own surface in `@epicenter/data`
  would let `app.account` become a namespace and change ADR-0389's arms.
- **Optional application copying.** ADR-0399 leaves cross-library copying to
  applications over safe storage primitives. No copy feature, identity-preserving
  import, or Add workflow is required by these platform waves. Sign-in does
  not move Local data.
- **Later, analytics.** It captures no identity, but its host leaf is a
  product telemetry plugin and its browser leaf always errors. Generalize
  only when a second app wants it.

## Rejected shapes

Recorded so future sessions do not re-derive them.

- `app.clipboard` on the handle (ADR-0387).
- A shared `openCore` whose result two openers spread and extend: throws on
  every account open because the handle is the opening store and its
  `persistence` getter asserts readiness; splits close and ready ownership;
  cannot bind account inference after construction (ADR-0389).
- One handle spanning local, personal, and shared (ADR-0389).
- Blobs as a platform module: `createAppBlobs` drains in-flight operations
  and playback URLs at close and its remote half captured the account's
  fetch. The factory keyed by app and replica already exists one level down
  (ADR-0349, ADR-0388).
- Splitting `acquireAppData` or the store's `local` flag: moves one branch
  up or forks a large function to delete one boolean (ADR-0389).
- Making `Account.authorityId` required: it already is; the guard in
  `openApp` is dead code.
- Renaming the package to `@epicenter/api` (ADR-0388).
- Calling platform modules "device modules": `@epicenter/device` holds App
  capabilities, so the word points at the wrong family (ADR-0388).

## Verification

- Shipped: `packages/app-shell` typechecks with no `Pick<App` under it;
  `grep -n "choice\." packages/app/src/open.ts` hits only `captureReplica`;
  a local App has no `retirement` property; `tsc` rejects passing a
  `LocalApp` where an `AccountApp` is required.
- Wave 1: `grep -rn "ApplicationRuntime\|settingsKey" apps packages` returns
  nothing; a Whispering host build still exposes `app.ai.runtime`; a
  Honeycrisp host build with a test blob field writes under the host data
  root.
- Wave 2: Whispering's `services` barrel has no download or sound entry;
  `packages/app/package.json` lists one seam per platform module.

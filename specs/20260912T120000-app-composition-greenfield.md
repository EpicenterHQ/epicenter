# App composition greenfield

**Date**: 2026-09-12
**Status**: Draft
**Owner**: Braden Wong
**Branch**: braden-w/app-schema-derive-export-import
**Grows from**: ADR-0388, ADR-0389, ADR-0390, ADR-0391, ADR-0402, ADR-0403
**Superseded by**: `specs/20260912T112824-app-hub-and-whispering-transcription-collapse.md` for the App's shape (ADR-0392's two scopes). The platform-selection, capability, and platform-module waves below are not covered there and remain live here.

## Opening boundary checkpoint: 2026-09-18

ADR-0407 implements the platform-free `defineApp` declaration, separate `/open`
entrypoint, private composition, and removal of public runtime/AI overrides.
Whispering's runtime seam and per-target runtime exports are removed. Resource
selection still uses package build conditions. The runtime selector in ADR-0403,
the host capability grant, and additional platform modules below remain proposed
work; this checkpoint does not execute them or migrate storage prefixes.

## One sentence

An application declares its id and data once; the package selects every
implementation at runtime from the presence of the host; shared code takes
capabilities, never the handle; the platform is reached by direct import; and
the host grants every native verb to every window.

## How to read this spec

Read first: One sentence, Current state, Target shape, Waves, Verification.
Read if changing the direction: Open questions, Rejected shapes.

## Current state

- `@epicenter/app/clipboard` exists as the first platform module (ADR-0387,
  ADR-0388). Whispering's text service no longer has clipboard methods.
- `App<T>` is `LocalApp<T> | AccountApp<T>`, discriminated by `library`
  (ADR-0389). ADR-0392 proposes one `open(account)` with `app.device` and
  `app.account` scopes; the superseding spec owns that change and nothing
  below depends on which shape lands.
- `defineApplication` accepts `runtime`, `ai`, `settingsKey`. Only Whispering
  passes `runtime`; all three apps pass `settingsKey`. The package's host AI
  leaf supplies the native inference transport, so no app passes `ai`.
- The package picks its host leaves through three `#platform/*` entries keyed
  by the `epicenter-host` condition, read by the consuming app's bundler.
  ADR-0403 replaces that with a runtime check inside the package. Vocab sets
  no condition, so the desktop already runs it over the browser leaves.
- The desktop host grants native verbs per window label across fourteen
  capability files, twelve Rust tests, and one TypeScript test. `honeycrisp` and `mail` match no
  shared file, so the clipboard module already fails in those windows and the
  default runtime cannot flip to desktop recording. ADR-0402 replaces the
  fourteen files with one constant grant to every window.
- No standard app declares a blob field. Their host-build blob stores are
  IndexedDB and empty.
- Whispering's `services` barrel holds analytics, text, download, local
  shortcuts, and sound.

## Target shape

```ts
import { defineApp } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import { clipboard } from '@epicenter/app/clipboard';
import { notification } from '@epicenter/app/notification';

const application = defineApp({ id: appId, kv, tables });
const app = openApp(application, account);              // shape per ADR-0392

pickInference({ connections: app.device.connections }); // a capability, not the App
await clipboard.writeText(text);                    // the platform, no App
await notification.send('Review due', '12 cards');  // same import in a tab and in the host
```

Inside the package, every platform-dependent public file is the selector
(ADR-0403):

```ts
// packages/app/src/notification.ts
import { isTauri } from '@tauri-apps/api/core';
import { notification as browser } from './notification/browser.js';
import { notification as host } from './notification/epicenter-host.js';
export const notification = isTauri() ? host : browser;
```

A developer on the package runs one `vite build`, deploys the folder to the
web, and installs the same folder into the desktop with a manifest beside it.
Nothing about the package appears in their build configuration.

Membership rule (ADR-0388): on the App if it captures an open-time fact or
close must drain it; otherwise a direct import selected by the package.

## Waves

Each wave is independently shippable and verified before the next starts.
Waves for ADR-0389 and ADR-0390 have shipped and are deleted from this list.

1. **The capability is a host constant.** Replace the fourteen files under
   `apps/epicenter/src-tauri/capabilities/` with two, `windows: ["*"]`,
   every `allow-*` identifier the generated schema knows, the two scoped
   scoped groups (`http:*`, `opener:*`) at full scope, loopback as the only
   remote URL, both Tauri configs selecting the new file. Delete the twelve
   Rust tests that read capability files (eleven in `lib.rs`, one in
   `application-close.rs`), the `app-*`-glob label test, the
   `APP_WINDOW_CAPABILITIES` and `PUBLIC_CLIENT_COMMANDS` helpers, and
   `apps/epicenter/src/mail-authorization.test.ts`; write the one test that
   equates the file with the generated schema. Verify by `cargo test` and a dev
   launch in which Whispering records, Home administers models, Mail opens
   Google's consent screen, and Honeycrisp copies text. In the same commit,
   rewrite the comments that describe per-label authority:
   `apps/epicenter/src-tauri/src/lib.rs` near lines 95, 461, 533, 541, 553,
   and 1678; `apps/epicenter/src/applications.ts:13`;
   `apps/epicenter/src/server.ts:1220`; and the clipboard permission sentence
   in `packages/app/README.md`. (ADR-0402)
2. **The package selects at runtime.** Replace the three `#platform/*`
   entries in `packages/app/package.json` with `isTauri()` selectors in the
   public files; rewrite `platform-selection.test.ts` to assert every public
   platform file names both leaves; delete the package's
   `tsconfig.epicenter-host.json` and the second `tsc` in its `typecheck`
   script; drop the `epicenter-host` condition from
   `packages/app/scripts/shared-ai-catalog.native.mjs`. The apps' Vite
   conditions stay for their own seams. No weight gate: the host leaf is
   plain TypeScript over `fetch` and a WebSocket. In the same commit, rewrite
   the comments that describe build selection: `packages/app/src/clipboard.ts`,
   `packages/app/src/browser.ts:86`,
   `packages/app/src/ai-connections.epicenter-host.ts:278`, the header of
   `platform-selection.test.ts`, and the four "for the build" sentences in
   `packages/app/README.md`. (ADR-0403)
3. **Resource selection completed under build conditions.** ADR-0407 removes
   public `runtime`, `ai`, and per-target exports, and Whispering's runtime
   seam. Private composition still has resource contracts. Revisit a prefix
   migration only with evidence of a concrete persisted namespace change.
4. **Platform modules.** Platform information, OS notification, the opener,
   and download move to `@epicenter/app/<x>` in the clipboard's shape with
   the runtime selector, in that order. Sound stays in Whispering: it has no
   platform split and carries Whispering's own cues. The opener exposes
   `openPath` and reveal only. Download takes a filename and extension; the
   audio-type mapping stays in Whispering. Notification returns a Result;
   Whispering's report layer decides to ignore it. (ADR-0388)
5. **Docs.** Rewrite `docs/CONTEXT.md`'s App composition section and its
   `#platform/*` glossary line, add a "capability" entry, and reconcile
   ADR-0304's desktop layout with the blob layout the host writes.

Wave 1 and wave 2 are independent of each other and of the rest. Wave 3
depends on both. Wave 4 depends on wave 2.

## Open questions

Each is a product or durable-string decision the evidence cannot settle.

- **Wave 3, storage prefix.** Honeycrisp never writes AI connections, so it
  has nothing to migrate. On the desktop host the new prefix holds no bytes,
  so no import runs and the catalog is untouched; do not rename on the host.
  The only installed base is the Whispering browser build. Decide whether it
  has users with saved connections; if yes, the browser leaf renames
  `whispering.app-ai-connections` and `whispering.app-ai-selections` to the
  app id once, guarded by "destination absent".
- **Wave 3, test doubles.** Three files substitute sqlite and blobs through
  `runtime`: three shared helpers and about two dozen tests, forty-four call
  sites. With the runtime selector they mock the leaf module the selector
  imports, through one shared helper beside the tests. A `test` condition in
  `package.json` is refused: the import map is production surface.
- **Wave 4, download on the host.** Desktop download is broken today:
  Whispering's leaf imports `@tauri-apps/plugin-fs`, but the host registers
  no fs plugin and the generated schema has no `fs:*` identifier. The
  implementation must choose between `plugin-fs` and a host command that
  takes the dialog's path. If it uses `plugin-fs`, add the plugin to
  `Cargo.toml`, `lib.rs`, and the host's `package.json`; after wave 1 the
  schema test names the new permission identifiers. A host command needs no
  filesystem plugin. Neither mechanism is selected by this spec.
- **Optional application copying.** ADR-0399 leaves cross-library copying to
  applications over safe storage primitives. No copy feature, identity-preserving
  import, or Add workflow is required by these platform waves. Sign-in does
  not move Local data.
- **Later, analytics.** It captures no identity, but its host leaf is a
  product telemetry plugin and its browser leaf always errors. Generalize
  only when a second app wants it.
- **Later, the apps' own seams.** Whispering, Honeycrisp, and Vocab keep
  `#platform/auth` and `#platform/instance` for credential ownership. After
  ADR-0227 the same `isTauri()` fact answers those too. Collapsing them is a
  separate decision per app.

## Rejected shapes

Recorded so future sessions do not re-derive them.

- `app.clipboard` on the handle (ADR-0387).
- A shared `openCore` whose result two openers spread and extend: throws on
  every account open because the handle is the opening store and its
  `persistence` getter asserts readiness; splits close and ready ownership;
  cannot bind account inference after construction (ADR-0389).
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
- Adding `honeycrisp` and `mail` to the shared capability file: answers one
  window and keeps the mechanism that asks again per window and per verb
  (ADR-0402).
- A capability file derived from the package's host leaves by a test that
  extracts `invoke` names and plugin commands: a truthful manifest nobody
  consumes, paid for with a derivation into each plugin's build output
  (ADR-0402).
- A Vite plugin, a second export per target, or an `epicenter build` command
  to set the condition for a developer's build: each keeps a promise the
  package can simply not make (ADR-0403, ADR-0186).
- Sound as a platform module: one file, no build split, Whispering's assets
  (ADR-0388 amended).

## Verification

- Shipped: `packages/app-shell` typechecks with no `Pick<App` under it;
  `grep -n "choice\." packages/app/src/open.ts` hits only `captureReplica`.
- Wave 1: `ls apps/epicenter/src-tauri/capabilities` lists two files; the
  one Rust test passes; Honeycrisp copies text in the desktop.
- Wave 2: `grep -n '"#platform' packages/app/package.json` returns nothing;
  `packages/app/tsconfig.epicenter-host.json` does not exist; a Vocab build
  with no condition opens host SQLite and secrets inside the desktop.
- Wave 3: `grep -rn "ApplicationRuntime\|settingsKey" apps packages` returns
  nothing; a Whispering host build still exposes `app.ai.runtime`; a
  Honeycrisp host build with a test blob field writes under the host data
  root.
- Wave 4: Whispering's `services` barrel has no download entry; each new
  public platform file names both leaves.

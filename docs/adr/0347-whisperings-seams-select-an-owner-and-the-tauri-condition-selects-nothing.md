# 0347. Whispering's seams select an owner, and the tauri condition selects nothing

- **Status:** Proposed
- **Date:** 2026-09-04
- **Built.** The `tauri` key is gone from every `imports` entry, every tsconfig, and every vite config; `#platform/base-path` is deleted; and `apps/whispering/src/lib/platform-selection.test.ts` reads the declarations. The last line, `apps/whispering/vite.config.ts` activating `tauri` beside `epicenter-host`, came out with the `tauri` option in `@epicenter/vite-config`.
- **Relates:** [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) (the two conditions answer different questions), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (storage is not a seam), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (hosted web is refused, and a native capability seam collapses to its `tauri` leaf), [ADR-0345](0345-the-root-layout-is-chrome-and-the-callback-decides-what-may-live-above-a-page.md) (the boot shape Whispering now shares with every other app)

## Context

ADR-0227 refused the hosted web runtime and said a native capability seam
collapses to its `tauri` leaf. Commit `920057bb61` did that for fourteen
seams: each became a plain path alias to one module, and the browser leaves
went. `apps/whispering/AGENTS.md` then said the rest of the seam "collapses to
one leaf when it is rebuilt", because Whispering has no build where
`epicenter-host` and `tauri` come apart.

The rebuild is done, and that sentence was wrong twice. The `tauri` axis had
already collapsed: no `imports` entry in Whispering names a `tauri` leaf, no
package in the repository exports a `tauri` condition, so the condition the
Epicenter build and `tsconfig.desktop.json` both activated selected nothing.
And the seams that remained were never on that axis. Auth, binding, blobs, and
base path split on who owns a thing the page needs: the Epicenter host brokers
a credential, holds a keychain and files below its data root, and streams
recording bytes from its filesystem; a page without a host obtains its own
credential by OAuth redirect, keeps tab-lifetime secrets and OPFS files, and
holds recording bytes in IndexedDB. That is the axis ADR-0190 named
`epicenter-host`, and Honeycrisp and Local Mail split their own seams on it.

The `default` leaf has one consumer, `bun dev:whispering`, which runs `vite
dev` in a browser tab. It matters because it is the only hot reload loop
Whispering has: the desktop host runs `bun run build` before `tauri dev` and
serves the built assets, so every UI change inside the host is a rebuild.

## Decision

**Whispering's `#platform/*` seams split on one axis, `epicenter-host` against
`default`.** A seam exists when the host owns the thing behind it and the page
has its own owner for the same thing: a credential, a keychain and files,
recording bytes. That is three seams, `#platform/auth`, `#platform/binding`,
and `#platform/blobs`, and nothing else is one. A module that only runs in the
Epicenter build is a plain path alias with no condition, which is what the
fourteen already are.

**The `tauri` condition is retired from Whispering.** No `imports` entry names
it and no tsconfig activates it. The host build is checked by
`tsconfig.epicenter-host.json`, named for the one condition it activates, as
Local Mail's is. A file that calls native commands keeps its `.tauri.ts` name:
the suffix says what the module reaches, and the rule that native reach lives
in `$lib/tauri.tauri.ts` reads it. It is no longer a leaf anything selects.

**The `default` leaf is the browser development loop, and it is kept for
that.** It is not a hosted product, which ADR-0227 refused and this record
does not reopen, and it is not a second runtime: it is the same page over a
store the page owns, which every build is (ADR-0226). `tsconfig.json` checks
it, so a browser leaf that drifts from its contract fails the same typecheck
the host leaf does.

**Base path is not a seam.** `svelte.config.js` already sets `paths.base` from
the same environment flag, so SvelteKit's `resolve` from `$app/paths` carries
the prefix into every link, navigation, window URL, and asset base.
`#platform/base-path` and the `whisperingPath` helper over it are deleted;
routes call `resolve` as Honeycrisp's do.

## Consequences

- The seam map is three entries, each with both keys, and
  `apps/whispering/src/lib/platform-selection.test.ts` asserts exactly that:
  every conditional seam names both leaves, every leaf exists, and no seam
  names `tauri`. A dropped host leaf falls back to `default` silently, which is
  the hazard the platform-seams skill names; the test is what makes it loud.
- `bun run typecheck` still runs twice, once per condition, and the second
  config is named for what it checks.
- `bun dev:whispering` keeps working as it does today, with browser auth,
  tab-lifetime binding, and IndexedDB blobs. The SQLite worker the browser
  store needs is a shared concern in `@epicenter/vite-config`, not a
  Whispering seam.
- ADR-0190's sentence that Whispering "declares both conditions" describes the
  build as it was. This record narrows it to one condition for Whispering and
  leaves the rest of ADR-0190 standing.

## Considered alternatives

- **Delete the `default` leaves and make every seam a plain alias.** Rejected.
  It would leave `vite dev` unable to run outside the host, since the host
  leaves read a bootstrap element only the host injects, and the host serves
  built assets. The cost is three browser leaves and one extra svelte-check
  pass; what it buys is the only fast iteration loop the app has.
- **Keep the `tauri` condition activated for symmetry with the vite config.**
  Rejected. A condition nothing declares a leaf for is a claim that a build
  chooses something, and the test that reads the declarations would have to
  exempt it. ADR-0190's reason for naming the conditions apart was that
  Honeycrisp needed both; nothing in Whispering does.
- **Rename the fourteen `.tauri.ts` modules now that no condition selects
  them.** Rejected as churn: the suffix still says which modules reach native
  commands, and every importer would change for a name that says less.

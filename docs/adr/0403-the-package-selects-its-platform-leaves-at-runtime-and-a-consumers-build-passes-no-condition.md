# 0403. The package selects its platform leaves at runtime, and a consumer's build passes no condition

- **Status:** Accepted
- **Date:** 2026-09-12
- **Amends:** [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) at the selector only: a platform module is "imported directly and selected by the build" becomes "imported directly and selected by the package"; the membership rule, the family name, and the two-leaf shape stand. [ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md) at the selector only: "a `#platform/*` seam inside `@epicenter/app` selects every implementation" becomes a runtime choice inside the package; the deletion of `runtime`, `ai`, and `settingsKey`, the host blob layout, and the whole-declaration rule stand. [ADR-0387](0387-the-clipboard-is-a-platform-module-beside-the-app-not-a-capability-on-it.md) at "selected for the build by a `#platform/clipboard` seam". [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) at its built-line claim that "nothing observable" in a WebView tells it apart from a browser tab: `isTauri()` is observable in every window Tauri creates, and Home already relies on it.
- **Relates:** [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md) (superseded for scope by ADR-0227, never on merit: "no plugin, alias, resolve condition, or externalization from an app's build" is the rule this record restores), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) (why the condition was an ownership declaration; after ADR-0227 the two questions have one answer), [ADR-0347](0347-whisperings-seams-select-an-owner-and-the-tauri-condition-selects-nothing.md) (the app-level seams this record leaves alone), [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) (the developer this record is for deploys their own build), [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) (why a host leaf works in every window)

- **Implementation:** Runtime and clipboard selection implemented on 2026-09-18.

## Context

A consuming application's build previously selected App services through the
`epicenter-host` condition. Omitting it silently selected browser services even
inside the desktop host. Vocab and Skills omitted that condition. Under the
current product model, the only supported Tauri shell is the Epicenter host,
which exposes both native IPC and its same-origin broker routes.

## Decision

**The package selects its default services from the running environment. App
callers supply a definition and optional account or explicit runtime.**

```ts
function defaultRuntime(): AppRuntime {
  return isTauri() ? hostRuntime : browserRuntime;
}
// Within openApp:
const runtime = options.runtime ?? defaultRuntime();
```

Detection happens when opening an App. Explicit runtime injection bypasses it.
Both bindings already own module-level service objects; no additional cache is
needed. Clipboard selects its browser or host leaf independently with the same
platform check. It captures no App or account and remains outside AppRuntime.

App receives complete capabilities. Shared document and blob implementations
receive an IndexedDB factory and matching key-range constructor beneath that
boundary. Documents remain in client-owned IndexedDB in both environments.
SQL, blobs, secrets, recording, and AI use their selected service implementations.

Remove the package's `#platform/resources` and `#platform/clipboard` maps and
redundant host-only typecheck configuration. Direct imports bring both leaves
into the normal typecheck. Keep consumer app conditions that select their own
authentication and UI seams. Environment detection grants no authority, and a
broken host service does not silently fall back to browser storage. App builds
that select broker authentication run in the host WebView; ordinary browser
development uses the app's browser auth build. This selector does not make a
broker-authenticated app build standalone.

## Consequences

Application callsites stay `openApp(definition, { account })`; tests supply
`{ runtime: createMemoryRuntime() }`. Importing both implementations performs no
storage or network acquisition. Bundles contain both platform implementations.
A representative openApp-plus-clipboard browser build grew by 21,377 raw JavaScript
bytes, 5,951 bytes gzipped. SvelteKit SSR/client build and Chromium/WebKit App
lifecycle evidence pass with the same selector. The native catalog acceptance
test builds without a package condition and proves host catalog updates,
credential persistence, SSE reconnect, process restart, and cleanup in real
Tauri windows.

The user authorized a clean break for existing Vocab configuration. Desktop
Vocab now reads the host AI catalog. Its old origin-local custom connections and
selected IDs are not migrated; unmatched selections become unavailable. Existing
local records are not erased. App documents keep their existing addresses and
format. No compatibility reader, migration, or automatic browser fallback is
part of this decision.

## Considered alternatives

- Build conditions or a Vite plugin retain consumer configuration and silently
  select the wrong service when omitted.
- Separate public browser and host openers give callers a choice the environment
  already determines and split the shared App API.
- A cached selector adds first-use state around existing service singletons.
- Choosing each storage primitive in openApp exposes implementation details;
  the App boundary needs capabilities, while shared algorithms accept primitives.
- Migrating old browser AI catalogs preserves a transition the user explicitly
  declined for this greenfield change.

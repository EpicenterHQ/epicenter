# 0413. AppBoot owns the working page lifetime

- **Status:** Accepted
- **Date:** 2026-09-19
- **Amended by:** [ADR-0423](0423-app-resources-open-as-independent-handles.md) replaces mandatory AppBoot auth/definition acquisition with product-owned resource composition; boot UI may render its opening promise.
- **Amended by:** [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md) replaces intact App forwarding with ready shared handles in typed Svelte context; context distribution does not own resource teardown.
- **Amends:** [ADR-0411](0411-honeycrisp-displays-data-from-one-app.md) at boot and departure composition.
- **Amended by:** [ADR-0415](0415-runtime-replacement-ends-application-sessions.md) replaces aggregate product draining with page-owned roots and full departure; temporary operation cleanup and immediate retirement fencing remain.

## Decision

The mounted AppBoot component captures `auth.getState().account`, calls
`openApp` with the application's inert definition, and renders the ready App.
The page passes the plain auth client and definition. It receives the intact
App in a snippet and chooses which nested data handle to display.

Auth is a document singleton with an explicit `getState()` snapshot method.
The Svelte adapter adds a reactive `.state` getter for UI that tracks identity.
Opening belongs to the component instance: imports, preloads, sign-in, and
callbacks acquire no App. A module-owned opening would outlive its rendering
owner and make acquisition an import side effect.

AppBoot owns rendering, native closure, sign-out navigation, and UI shutdown.
Its private page lifetime uses Svelte state directly. There is no public
controller, listener API, or framework subscription adapter for this lifetime.

Each root UI with asynchronous producers calls `registerAppCleanup` once,
synchronously during initialization, after its producers exist. The narrow
context carries only cleanup registration, never an App or data handle. The
optional `preflight()` can refuse deliberate departure; the required `close()`
stops admission and drains admitted work. A second registration throws. The
registration has no unregister operation: its plain closures remain available
until the AppBoot lifetime ends. Pages do not pass component handles back into
AppBoot, and root UI components do not independently start the same cleanup
from `onDestroy`. AppBoot calls their drain once.

Deliberate closure consults preflight, blurs focused input, removes rendered UI,
awaits the producer drain, and closes the App before authentication changes or
navigation. Honeycrisp's editor teardown flushes synchronously; it needs no
asynchronous cleanup registration. `tick()` flushes Svelte updates, not
arbitrary asynchronous teardown. Native close during opening waits for the
mounted root UI's preflight.

Unmount and retirement interrupt an unanswered preflight and suppress pending
departure actions. They skip deliberate blur commits. An interrupted opening
cannot later launch preflight. Unmount during opening closes the eventual App.
Failed cleanup keeps unsafe ownership and requires document teardown. An
already-closed page offers recovery instead of an indefinite closing spinner.
Browser reload is recovery, not an awaited persistence guarantee. Opening
failures have one renderer, the await block; native close still refuses an
opening failure rather than assuming resources were safely released.

AppBoot requires an auth client and an explicit sign-in destination for local
startup. Signed-in pages expose sign-out through the same close owner. Every
browser app exports its actual auth client for one build-configured server.
Desktop windows receive Account capabilities; the host retains credentials.
No server-selection client or common startup wrapper is required.

## Consequences

Honeycrisp keeps the same App across Local and Personal navigation. It passes
`app.device` and `app.account.personal` directly. ADR-0412's scope and admission
model is unchanged; cross-tab admission remains inside `openApp`. A new mount
while a prior App still owns its claim fails admission; reload is recovery,
not a promise of seamless remount during cleanup.

Whispering, Vocab, and Local Mail use the same boot owner. Their mounted shells
own their asynchronous producers and release operation registrations after
those producers drain. A later mount must not reuse a closed workflow.

## Considered alternatives

- Passing auth, captured account, opening, and a controller separately: distributes
  one lifetime across several owners and permits inconsistent inputs.
- A module opening singleton: imports could acquire resources before rendering.
- Page-level blur and tick registration: every page repeats framework teardown
  mechanics that belong to the component rendering the UI.
- Automatic replacement after retirement: silently changes the working
  account or data. The stopped page instead requires explicit recovery.

- Component-handle round trip through `bind:this`, page state, and a `ui` prop:
  required binding-timing knowledge and retention after Svelte cleared the
  binding. Synchronous registration gives the lifetime its drain directly.
- A callback passed through an extra snippet argument and page prop: makes a
  page forward cleanup it does not own. The single lifecycle context keeps App
  props explicit without adding an object containing App aliases and callbacks.
- Multiple cleanup registrants or remount replacement: unnecessary for the fixed
  root UI lifetime. Duplicate registration fails; development remounts can reload.

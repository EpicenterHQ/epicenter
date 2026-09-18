# 0413. AppBoot owns the working page lifetime

- **Status:** Accepted
- **Date:** 2026-09-19
- **Amends:** [ADR-0411](0411-honeycrisp-displays-data-from-one-app.md) at boot and departure composition.

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

AppBoot constructs one departure owner and owns rendering, native closure,
sign-out navigation, and generic UI shutdown ordering. Applications with
asynchronous producers pass their actual mounted component as `ui`. Its
optional `preflight()` can refuse deliberate departure; its idempotent `close()`
stops admission and drains admitted work. AppBoot retains this component while
Svelte removes it, so clearing `bind:this` cannot discard the pending drain.
It blurs the active element, removes rendered UI, awaits the drain, closes the
App, and only then permits authentication changes or navigation.

Unmount and retirement cannot be vetoed. They suppress pending departure
actions, including when retirement happens during asynchronous cleanup.
Unmount during opening closes the eventual App. Failed cleanup keeps unsafe
ownership and requires document teardown. Browser reload is recovery, not an
awaited persistence guarantee. Opening failures have one owner, the await
block that renders the opening promise; departure does not duplicate them.

Honeycrisp fixes its browser issuer and exports the actual auth client.
Applications that offer runtime server selection retain BrowserAuth because
it performs that selection. Desktop windows receive Account capabilities;
the host retains credentials. No common startup wrapper is required.

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

- Passing auth, captured account, opening, and departure separately: distributes
  one lifetime across several owners and permits inconsistent inputs.
- A module opening singleton: imports could acquire resources before rendering.
- Page-level blur and tick registration: every page repeats framework teardown
  mechanics that belong to the component rendering the UI.
- Automatic replacement after retirement: silently changes the working
  account or data. The stopped page instead requires explicit recovery.

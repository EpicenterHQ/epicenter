# 0411. Honeycrisp displays data from one App

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amends:** [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) for Honeycrisp's page composition and view navigation.

- **Amended by:** [ADR-0413](0413-app-boot-owns-the-working-page-lifetime.md) for shared boot ownership.

## Decision

Honeycrisp opens one App for the working page's lifetime. Its matched notes
route mounts AppBoot, which captures one Account and calls `openApp` in its
component instance script. A stable promise supplies the ready App to rendering. Importing or
preloading routes acquires no App; sign-in and callback routes own none.

`/personal` displays `app.account.personal`; `/local` displays `app.device`.
Both render the same Notes component with the actual nested data handle.
Changing the route parameter preserves the App and remounts the notes view.
The outgoing editor finishes its pending writes while the App remains open.
There is no saved selection, library object, layout-to-page App context, or
second application controller exposing replacement table handles.

The App exposes tables, KV, and capabilities. Notes components use those
handles directly through Svelte's reactive data adapter. Repeated calls to
`fromData` reuse one projection per raw data identity. Domain operations that
coordinate rows or editor subscriptions remain explicit functions. Local and
Personal are display choices, not acquisition options. Shared has no
Honeycrisp view; the App still acquires data applicable to its Account.

The browser deployment fixes its authentication service at build time.
Honeycrisp offers sign-in, not runtime server selection. A self-host build
supplies the matching issuer configuration as well as its URL. Hosted desktop
windows continue to receive the host's Account capability; they do not hold
server credentials. Other applications retain their own connection policy.

Deliberate departure drains producers and unmounts editors before closing the
App, changing authentication, and navigating to a fresh document. Retirement
during cleanup prevents a pending authentication action. Failed cleanup keeps
unsafe ownership until teardown. Unmounting during opening closes the App
when acquisition settles. Browser unload remains best effort, not an awaited
persistence guarantee.

## Consequences

The default destination remains Personal. Signed-out Local works; signed-out
Personal offers sign-in. View navigation neither copies data nor reopens it.
Same-owner credential refresh preserves the captured Account and App.

App ownership is enforced across documents internally by `openApp`; creating
one App in a component cannot prevent another tab from opening the same
resources. Ownership is released only after successful resource cleanup.

The storage engine still owns persistence and replication. Its internal
storage terminology does not introduce another application-domain handle.
Addressing names the data scope; the public App data handle needs no redundant
scope label because its location already identifies it.

## Considered alternatives

- A dynamically imported opening singleton: route imports could acquire
  resources and copied import state duplicated the promise's result.
- Separate leaf pages beneath an App provider: required context solely to
  transport a value the owning page can pass directly.
- Reload on Local/Personal navigation: would require orderly departure for
  data already available on the same App.
- A second Honeycrisp controller with its own tables: obscured the actual
  App handles and distributed a parallel API through context.
- Runtime server selection: added persisted choices, invalid selections, and
  transition paths that this deployment does not need.

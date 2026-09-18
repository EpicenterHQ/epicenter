# 0369. An application page owns one library and changing it ends the page

- **Status:** Accepted
- **Date:** 2026-09-08
- **Amended by:** [ADR-0411](0411-honeycrisp-displays-data-from-one-app.md) for Honeycrisp: Local/Personal route navigation retains one App, and component instantiation replaces the dynamically imported opening singleton. Account/server close-before-replacement remains.
- **Amended by:** [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) at defining a library solely by account identity or local ownership: Personal and Shared are distinct libraries for the same signed-in person, while fixed page ownership and close-before-replacement remain.
- **Amended by:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) at "one library": a page owns one auth generation and holds the device store and the account's libraries at once. Close-before-replacement on an account change stands.
- **Amends:** [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at application lifetime: same-document account session replacement is withdrawn. Credential refusal and sync status remain separate from library selection.
- **Implementation:** Fixed page bootstrap and deliberate departure are implemented across the three store applications. Acceptance evidence and remaining native/browser checks are tracked in the execution spec.

## Context

The user chose to give up transient UI preservation across library changes.
`AppBoot` currently observes auth, chooses a destination, drains the current
session, and keys a replacement component on its Account. That coordination
exists because one page can become another library's application.

The storage layer already captures ownership at construction. Its document
owns readiness, operation admission, draining, and close. SQL and blobs retain
the captured identity. Fixing page ownership extends that model to its caller.

## Decision

**An application page captures one primary library and never replaces it.**

A library is the app's data selected by its app ID and `AccountIdentity | null`.
Account identity includes the authority and principal. Bootstrap captures the
actual Account capability for an account library. Credential refresh does not
change the library. Application routes and panels borrow the same opened App.
There is no public Library wrapper, current-app selector, forwarding facade,
or session replacement manager.

Plain TypeScript composes the raw auth client and the App. The shared opener
receives an explicit Account; it does not select one from ambient auth. Svelte
adapts auth and data for display and supplies framework-owned producer cleanup.

The narrowest application boot boundary outside the authentication callback
opens the App. A module export may share that concrete handle within the
application document after selection. Callback, auxiliary route, and route-preload imports
must not open it. The mounted application route dynamically imports the opening
module; module identity then preserves its concrete App for this document. A singleton is per document, not per desktop process.
Explicit transfers may acquire a separately captured source library without
replacing the primary App; their lifetimes must settle before departure.

**A deliberate library change closes the application before changing identity.**

```text
request departure
  -> stop UI producers and submit buffered edits
  -> await the document's close and physical resource release
  -> change authentication or server selection
  -> hard navigation
  -> new application document captures its library
```

One departure owns this sequence. Duplicate requests cannot publish competing
destinations. Failed close prevents the deliberate identity change and
navigation. A preflight refusal such as active recording leaves the controls
needed to resolve it usable. A document whose close has begun is never reopened;
terminal failures present recovery without pretending its App is usable.
If selection fails after close, any return to the application uses a fresh page.

The desktop host owns departure across all affected application windows and
waits for their close acknowledgments before replacing its account or server.
A child window must not retire its Account ahead of that host barrier.

**Unexpected retirement stops network access immediately and never retargets the page.**

Remote revocation cannot wait for local cleanup. The page closes locally and
enters a terminal state without adopting another identity or falling back to a
local library in the same document. Same-owner refresh and recoverable credential
refusal do not themselves reload the page. This decision adds no cross-tab
logout propagation protocol.

## Consequences

`AppBoot` loses reactive destination selection, keyed account replacement,
and arbitration between replacement sessions. Replaceable session components
can collapse into page ownership where their remaining producer cleanup fits.
Loading, open failure, explicit departure, and native close acknowledgment remain.

Search state, selection, and other transient UI reset on library change.
Within-library SPA navigation remains available. Authentication callbacks are
bootstrap documents with no library; they hand off to a fresh application page.

Reload is not an awaited drain. Crash and uncontrolled refresh rely on committed
data recovery. Native recording can survive WebView reload and still needs
explicit close or recovery. Successful close preserves its local durability
contract; it does not guarantee that all data reached the remote server.

Storage claims, captured transport, and physical close remain necessary.
Whole-library erasure still requires complete inventory and exclusion of every
producer. Page ownership does not make removal safe or enable its UI.

## Considered alternatives

- Replace the current App within one page: preserves transient UI the product
  no longer promises and requires replacement coordination.
- Reload from an auth subscriber: observes retirement too late to drain work
  with the old capability and cannot await cleanup through page destruction.
- Open an eager singleton from shared root imports: can acquire data while
  running an authentication callback or auxiliary route.
- Reload on every credential event: conflates transport status with library
  identity and risks reload loops on recoverable refusal.

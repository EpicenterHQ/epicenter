# 0374. The host selects one account and replacement restarts its applications

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Consolidating sign-in selection and credential ownership into one owner. The host supports Cloud and instance selection with restart, cancels a pending sign-in without discarding the active account, and in development returns through its own loopback callback (`apps/epicenter/src/desktop-auth-authority.ts`, `routes.ts`); that dev-only callback is build configuration, not a second production route.

## Context

`createDesktopAuthAuthority` restores one server choice and credential. App
windows receive a captured Account through `createDesktopBrokerAuth`. Browser
apps use `createBrowserAuth` to select Cloud or an instance for their document.

Fixing the desktop server at build time would remove selection machinery but
require self-hosters to rebuild the desktop application. A stock installation
can support self-hosting while keeping one server fixed for every running App.
The server belongs to the host's sign-in choice, and account replacement ends
the running applications.

## Decision

**A stock Epicenter installation has one active account, selected through Cloud sign-in or a custom server URL and token.**

Epicenter Cloud is the default. Connecting to a custom server replaces the
active choice; it does not create a second active slot. The host stores one
selected destination and its scoped credential. A new installation with no
selection offers Cloud sign-in. A returning installation restores its saved
choice, including a selected instance awaiting token reentry.

A missing selection permits the Cloud default. An invalid saved selection
requires deliberate recovery and cannot restore another cached account as a
fallback. Existing data and safely scoped credential cells remain intact.

The host supplies the captured Account to every app window. An SPA does not
choose another server or receive its token. Browser apps own the equivalent
selection for their document. No server list, credential wallet, per-app account
routing, or simultaneous Cloud-and-instance session is introduced.

One active Account is a runtime boundary: one host process or one browser
document. A browser tab does not retarget when another tab changes saved
selection. A new document reconstructs its Account from the current selection;
it never restores the previous document's App or departure state.

**An account or server replacement closes application work before retiring the old Account and restarts before opening the new one.**

[ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md)
owns producer shutdown and App closure. Desktop waits for affected windows and
blocks new app admission during departure. Authentication verifies the candidate,
drains old credential work, and persists the next startup choice. Relaunch or
full document navigation supplies the new Account to newly opened Apps.
Verification and persistence remain cancellable; a stale attempt cannot install
a later choice. Failure to close prevents replacement.

The exact candidate-verification timing may follow the existing no-library
sign-in screen. A saved new identity never makes an old window use it, including
when relaunch fails. Failed authentication or persistence provides recovery
without pretending an already closed App can resume in the same document.

Choosing Cloud may first save Cloud as the next destination and restart into
its sign-in surface, then authenticate and leave that surface normally. No
library opens in an intermediate authentication document. Exactly one restart
per complete sign-in is not a promise; no second dormant auth owner is required
just to remove a navigation.

**Credential renewal does not replace the account.**

Cloud's current session policy is a 30-day sliding expiry with renewal eligible
after one day. The client has no separate refresh-token exchange. Instance
tokens have no automatic expiry and remain valid until changed by the operator.
Token policy remains owned by the auth implementation and server configuration.

Routine session renewal requires no restart. Core uninterrupted same-person
reauthentication preserves the Account. Visible sign-in flows may still leave
the page or relaunch the host; preserving an Account inside a runtime does not
promise that runtime survives a redirect. Sign-out followed by sign-in never
revives an old Account. An unexpected principal change retires the old Account
without retargeting its App.

**Auth observations report credential state and retirement without opening another library.**

| Fact | Owner |
| --- | --- |
| Next startup server and credential | Host sign-in selection, or browser document selection |
| Running App's Account or local library | App startup, captured once |
| Refusal and recovery | Auth state; UI reflects it |
| Retirement | Auth immediately rejects transport; the application closes locally |
| Sync connectivity and progress | The opened store's sync implementation |

Auth's inactive `Connection`/`ConnectionStatus` and their no-op subscriptions
disappear. `fromAuth` retains auth-state observation. Actual store sync status
remains. Cloud account management is a supported action of the selected auth
method; UI does not infer it from durable namespace strings.

**Credentials and data retain the server identity they belong to.**

Account identity remains `{ authorityId, principalId }`; `baseURL` remains the
network destination. Preserve Cloud's `epicenter-api` authority bytes and the
existing normalized-origin encoding for instances. Independent instances using
principal `instance` keep separate local libraries. Switching leaves previous
local data intact and never migrates or uploads it implicitly.

Saved credentials are scoped to their authentication method and server origin.
Startup cannot combine a saved token with another URL from an environment
override. Missing, corrupt, mismatched, or unscoped credentials cannot publish
cached identity or authorize traffic, including remote revocation to the wrong
server. Credential scoping must not depend on rebuilding or reinstalling.

## Consequences

One sign-in choice supports Cloud and self-hosting in the stock desktop app.
People change servers through one managed departure and restart, without a
manual sequence of logout, configuration edits, and reinstalling.

Server selection, persistence, candidate verification, and cancellation remain
real work. They cannot all be deleted. The collapse removes duplicated selection
ownership, inert auth state, capability guessing in UI, and App retargeting.
Browser storage and native queued writes retain their platform-specific rules.

Two servers cannot be active together. Supporting that later would require an
explicit decision about which account each app window and library belongs to.
It is not implied by offering two ways to sign in.

## Considered alternatives

- Fix the host server at build time: makes ordinary desktop self-hosting require
  rebuilding the application.
- Keep simultaneous Cloud and custom-server slots: requires library selection
  and per-window account routing beyond the one-active-account product.
- Change server in the running App: violates its captured storage and transport
  ownership and requires replacing its producers and UI state in place.
- Reload on every auth event: interrupts routine renewal and recoverable
  credential states without providing an awaited close barrier.
- Remove auth observation: leaves refusal and unexpected retirement invisible
  to UI and the application close owner.

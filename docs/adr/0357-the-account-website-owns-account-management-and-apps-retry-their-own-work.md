# 0357. The account website owns account management and apps retry their own work

- **Status:** Proposed
- **Date:** 2026-09-07
- **Unbuilt:** Release verification of live-provider checkout and system-browser opening from a packaged desktop build.

## Context

`apps/api/ui` already serves the hosted account and billing dashboard.
`apps/vocab/src/routes/components/ConversationView.svelte` opens `/dashboard`
when a person needs to upgrade. The shared account popover supplies identity,
sign-out, and app-owned local-data removal.

Expanding account management into every app, or making the Epicenter main
window an intermediate billing destination, would distribute checkout,
navigation, and account-management lifetimes across otherwise independent
SPAs. A person who needs credits would gain another stop before purchasing.

The useful workflow is smaller: preserve the interrupted work, open the account
website, then let the person retry. A purchase need not become a transaction
coordinated between the website and the originating app.

## Decision

**The hosted account website owns account-management flows for browser and desktop users.**
The destination is the dashboard in `apps/api/ui`. It owns credit purchases,
plan changes, payment management, account-wide usage exploration, and sign-in
method management. Checkout returns to that website. Desktop apps open the
system browser directly; they do not route through the Epicenter main window
or embed the dashboard. The main window may show identity and the same link.
This concerns Epicenter Cloud; self-hosted connections do not acquire Cloud
billing controls.

**Apps show account information only where it helps their own workflow.**
An app may display its account identity and credit balance, explain an
insufficient-credit response, and offer Add credits and Retry. A displayed
balance is a cached snapshot. It neither authorizes a request nor prevents
Retry. The server decides whether the actual operation can proceed. Sign-out
and device-data removal remain with their existing owners.

**Returning from account management refreshes information without coordinating the purchase.**
An app displaying a balance fetches it on initial observation and refreshes it
when the app returns to the foreground. TanStack Query is the existing apps'
observation mechanism; independent Vite SPAs need not adopt it. Exact cache
durations and platform focus wiring belong to implementation.

There is no balance polling interval, cross-window shared cache, or
purchase-completion callback to the originating app. This refusal concerns
app-to-website coordination, not payment-provider webhooks or authentication
callbacks owned by the website. Retry submits the original operation again
and receives the server's current answer. It works without a full app reload
and without waiting for a balance refresh. Opening account management never
automatically resubmits work.

**A targeted account-management link must detect a different signed-in account.**
The originating app opens the account server's dashboard URL with an
`expectedPrincipal` query parameter. The URL origin selects the server. The
website compares the expected principal with its authenticated account
before allowing the targeted flow to continue. A mismatch asks the person to
sign into the intended account. The context grants no authority, transfers no
credential, and never silently switches accounts. A direct website visit
manages the website's signed-in account. `createAccountManagementUrl` in
`packages/auth/src/account-management.ts` builds these links.

## Consequences

App authors integrate a link and their own retry behavior. They do not import
a dashboard runtime or implement payment orchestration. The website keeps its
own account-bound requests and cache; this decision does not remove its
lifetime isolation.

A person switches to the browser to manage their account and explicitly
retries interrupted work afterward. A displayed balance can lag a purchase or
usage from another app. The next operation remains authoritative even when
focus refresh fails or payment processing has not finished.

Implementation is complete when Add credits opens the intended website flow,
a mismatched account cannot accidentally receive that purchase, returning
refreshes a visible balance, and Retry reaches the server despite a stale
zero balance. No purchase callback or full-page reload is needed to continue.

## Implementation and verification

The website keeps `/dashboard` for Credits, `/dashboard/usage` for analytics,
and `/dashboard/account` for profile and sign-in methods. Credit purchases sit
beside the balance. Failed plan previews prevent confirmation and offer Retry.

`createAccountManagementUrl` in `packages/auth` builds links with
`expectedPrincipal`. The dashboard layout rejects mismatches before mounting
its consumers. Tab-local return navigation preserves the destination through
sign-in, including the failure link. Checkout and portal return URLs preserve
the same target. The target is a hint; the authenticated Account still owns
all requests.

The shared account popover offers Manage account before an operation fails.
It opens Account settings in the browser and stays available when recording
disables sign-out. Whispering's insufficient-credit notices and Vocab's upgrade
action open Credits instead. Existing transcription Retry submits work without
a balance precheck.
The desktop intercepts new-window requests for exact hosted account routes
and opens the system browser while denying an embedded popup. Other window
navigation remains restricted.

Local verification uses `packages/auth/smoke/dashboard.browser.mjs`: real
Chromium and Better Auth sessions with disposable memory data and local billing
fixtures. It covers target continuity, mismatch refusal, immediate visibility
and window-focus refresh, query retry, preview failure, simulated purchase
return, portal return-URL forwarding, populated usage, passkeys, and page-disposal regressions. Native
URL validation and app credit-error tests cover opening policy and preserved
work. Desktop/mobile screenshots and a manual local Brave walkthrough verify
the website. No production payment or shared database was used. Packaged native
opening and a real transcription retry after real checkout remain release
smokes; the local website fixture does not prove those integrations.

With `ACCOUNT_POPOVER_SMOKE=1`, the same smoke mounts the real shared menu and
hosted auth client on another origin. It verifies authenticated profile loading,
the recording lock, opening Account settings without an opener, hosted sign-in,
account mismatch refusal, and preservation of an editable draft in the source
document. The fixture replaces the application's data store, not its account
menu or authentication.

## Considered alternatives

- Embed account management in every SPA: makes independent apps participate in
  billing UI and browser authentication flows.
- Put billing in the Epicenter main window: adds a desktop destination before
  the website that already owns the purchase.
- Poll for balance changes or notify apps after checkout: couples purchase
  completion to app lifetimes when a fresh operation already answers whether
  work can proceed.
- Automatically resume interrupted work: navigation does not establish that a
  purchase succeeded or that the person still wants the operation performed.
- Silently align browser and app sessions: creates credential-transfer and
  account-switching behavior where an explicit mismatch check suffices.

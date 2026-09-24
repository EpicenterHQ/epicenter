# 0374. The host selects one account and replacement restarts its applications

- **Status:** Proposed
- **Date:** 2026-09-08

## Context

The host owns one credential for its build-configured server. App windows
receive a captured Account through the desktop broker. Replacing the credential
must not let an old window borrow a new person's identity.

## Decision

One host process holds one boot Account. Deliberate sign-in or sign-out waits
for application producers and stores to close. The native close barrier blocks
new windows during departure. A first sign-in or different-person replacement
persists the credential for relaunch; it does not replace the boot Account.
A failed relaunch leaves old windows unable to use the replacement identity.

Cancellation drains credential writes and rollback before reopening app
admission. If the original Account was already retired, recovery requires a
fresh process. Otherwise same-person repair preserves it. Reopening admission
allows new windows; it does not restore closed windows.

Core uninterrupted same-person reauthentication preserves Account identity.
Sign-out followed by sign-in never revives an old Account. Unexpected retirement
rejects network access and closes application work locally without choosing a
successor or local fallback.

The server comes from trusted build configuration. Saved credentials must match
its origin and authentication method before startup publishes cached identity
or sends any request, including revocation. The host offers no server switch.

## Consequences

Credential replacement and application replacement share one awaited departure.
Browser documents preserve the same captured-Account rule through full navigation.
Authentication state remains observable; store sync owns connectivity and progress.
The host owns credentials and relays traffic, but owns no application data.

## Considered alternatives

- Replace the Account under running windows: changes transport identity while
  the application still owns its previous person's storage.
- Relaunch on every auth event: interrupts same-person repair and routine renewal.
- Return from cancellation before rollback: permits reopened windows to use
  credentials that a pending native write can still replace.
- Restore server choice from the credential envelope: makes saved data choose
  the deployment instead of merely validating credentials for it.

# 0433. Capture opens one account-backed inbox

- **Status:** Proposed
- **Date:** 2026-09-23
- **Implementation:** The signed-in web app and two-table Capture cutover are implemented in the current checkout. Whispering text promotion remains later work.

## Context

Capture needs a web view where a person can continue saved thoughts across
devices. Offering a separate device-only inbox would introduce two destinations
and a later transfer decision before the first release has a complete workflow.

## Decision

Require sign-in for Capture's first release. Open one Personal store
with definition ID `so.epicenter.capture`. A returning account can use
its existing local cache offline; first acquisition needs the service. Failure
to acquire the account store never creates an empty substitute inbox.

The first Capture interface is a web app. Whispering's desktop workbench remains
local and can explicitly promote selected text into the same account's Capture
store. Capture does not need its own native application in this release.

A small private, AGPL package at `packages/capture` owns the inert definition and
Capture operations shared by the web app and Whispering. Products acquire their
own resources. The package does not own credentials, sign-in, UI, or audio.

Whispering acquires the Capture destination only for this feature, using a fixed
Account. Missing sign-in or destination failure leaves recording and dictation
usable. An Add to Capture attempt freezes the visible text and the recording's
`recordedAt`, and creates a root capture. That capture's `capturedAt` is the
recording time; a capture typed directly in Capture uses its own creation time.
Whispering copies no audio, requires no source link, and does not choose a parent.
Retries retain the original attempt and any returned capture ID; they do not
create a second capture. An ambiguous attempt without an ID requires inspection,
not automatic resubmission. This recovery guarantee is scoped to the live page;
restart-safe automatic promotion is outside the first release.

Account departure fences work. A different account opens a fresh application
document; retained handles never retarget. Add to Capture replaces Whispering's
Personal recording copy path in a clean break. No migration or legacy read and
export workflow for Whispering Personal recordings is required. The existing
Capture `entries` rows need their own cutover decision before the two-table
definition replaces them.

## Consequences

A person must sign in before their first Capture. There is no anonymous inbox,
Local-to-Personal migration, or account destination picker inside Capture.
Offline use requires an already acquired cache and a usable captured Account;
this does not promise fresh offline authentication.

Store opening currently enforces exclusive ownership. A web Capture origin and
desktop Whispering can have separate replicas; same-origin duplicate owners
must show an explicit already-open state. The implementation must prove its
actual origins and claims before shipping promotion. It must not bypass locks.

## Considered alternatives

- Device-only Capture: delays sign-in but adds a second dataset and transfer semantics.
- A native Capture application in the first release: adds packaging and simultaneous native store ownership without being needed for the web product.
- Reuse Whispering's Personal recording table: couples kept writing to the recording lifecycle and audio storage.
- Automatically save every transcript: changes the explicit selection of thoughts into a recording archive.

The product model remains in [the Capture and thought record](0432-captures-hold-ordered-thoughts-beneath-a-dated-timeline.md).

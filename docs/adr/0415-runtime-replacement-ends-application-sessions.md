# 0415. Runtime replacement ends application sessions

- **Status:** Proposed
- **Date:** 2026-09-19
- **Unbuilt:** Page-owned product startup without aggregate rollback/close; proof of departure and native ownership before removing caller disposal.
- **Amends:** [ADR-0410](0410-an-app-is-returned-ready-and-page-teardown-owns-recovery.md) at product composition rollback: successful page-owned acquisitions may remain until document replacement; individual failed acquisitions still own safe cleanup.
- **Amends:** [ADR-0413](0413-app-boot-owns-the-working-page-lifetime.md) at departure ownership, UI cleanup registration, and recovery rendering.
- **Amends:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) at desktop identity transitions and same-person reauthentication.

## Context

Before this change, `createDesktopAuthAuthority` captured one boot Account but
used mutable `createSessionAuth` installation for later credentials. It closed
application windows before sign-in, then resumed, recovered, or restarted.
`ApplicationClose` in Rust waited for each window's cleanup acknowledgement.

`AppBoot` separately owned `createPageLifetime`, `registerAppCleanup`, UI
preflight, producer draining, and closing screens. That preserved pending work
at controlled exits even though browser reload and installed desktop window
closure could already interrupt it.

Local persistence happens during use. The user approved one warning before an
explicit account change, authorizing interruption of pending edits, an entire
active recording, and explicit-save drafts. This also covers work started while
sign-in is pending. No per-window veto or second confirmation remains.

## Decision

**One desktop process uses one boot Account and never installs a successor.**

The configured server remains a build/boot input. A successful explicit sign-in,
including same-person reauthentication, prepares verified credentials for the
next process and restarts Epicenter. Sign-out clears credentials and restarts.
Restart terminates the native host, its Bun sidecar, and its WebViews. Quitting
instead of restarting has the same ownership boundary but is not a second mode
to implement.

**Credential persistence finishes before process termination.**

The desktop authority owns one sign-in attempt and a terminal transition gate.
Cancellation before transition acceptance leaves its credential cell unchanged.
After acceptance, the authority disposes its old auth owner and writes the
next credential directly behind any already queued old-owner writes. It cannot
resume working or publish the successor to old windows. A failed credential
write reports failure and may already have changed storage; no rollback is
promised. A failed restart leaves a retired process with manual restart recovery.
No window may veto an accepted transition.

A retired boot Account, including retirement during background verification,
makes the process require restart. A retired host serves a restart-required document instead of injecting its old
boot identity into newly opened pages. Deliberate browser sign-out owns its
navigation: retirement notifications cannot interrupt credential clearing and
the bounded revocation attempt.

Existing bounded server revocation remains separate from local credential
clearing. Exiting with an unobserved revocation request is not a replacement for
that behavior. A successful local transition does not certify server revocation.

**One page captures one account context, and account replacement ends the page.**

Here “page” is shorthand for the browser/WebView lifetime, not an application
primitive. In application architecture explanations, reserve “document” for a
store's Yjs data document and explicitly qualify browser/WebView lifetimes.
An application can open several stores; each structured store holds one data
document. An auxiliary overlay can forward messages without opening a store.

The captured account context may be signed out. This is the application
operating rule, not a global account restriction in the resource SDK.

A page may open several stores and namespaces, including Local and Personal
together. There is no SDK library owner. Name concrete handles `local` and
`personal`, and the selected recordings destination `store`. Existing `library`
identifiers are migration work, not the target vocabulary; durable keys stay put.
Switching a view or selecting an already-open store does not inherently require
reload. Each handle retains its captured destination.

**Root resources belong to the page; temporary operations retain shorter lifetimes.**

Acquire root resources once from explicit page startup. Ordinary component or
route changes do not reacquire or close them. Importing a module still acquires
nothing. Retain `close()` for shorter-lived consumers, explicit release, and
resource-internal cleanup; a root page does not need an aggregate close owner.

Required startup failure is terminal for that document. A reload retries startup.
Earlier successful root acquisitions may remain until replacement, provided no
active capture or other temporary work is left running behind the failure
screen. The resource whose own opening fails still owns safe partial acquisition
cleanup. Do not add same-document reopen, takeover, or close-retry paths.

Optional inference and catalog acquisition must not block recording or document
use. A failed optional acquisition stays a feature failure; retrying acquisition
may require reload. A failed request or model discovery can be retried through
an existing usable handle. Absence, failure, and an empty model list stay distinct.

A recording, playback URL, request body, temporary preview, and operation
subscription can end while their page stays alive. They still stop, cancel, or
release explicitly. Page ownership removes aggregate product teardown, not
within-page cleanup or cross-window storage admission.

**Departure must actually end the old working page.**

The mounted product captures its required account and opens its chosen resource
handles. Sign-in/callback and recovery documents open no primary product
resources. Ordinary navigation that retains those handles, such as Honeycrisp
Local/Personal navigation, remains inside the document.
Exits from its lifetime use full navigation rather than an awaited UI drain.
A stopped screen is not document destruction. Browser authentication work that
can stall or reject belongs in a resource-free departure document when this
allows the old working page to end first. Preserve required credential clearing
and bounded server revocation in that destination. Desktop process restart
retains the credential-persistence ordering specified above.

Until replacement is proven, retain one immediate work fence and the stopping
needed to prevent active capture or privileged work behind an inert page. Do not
delete those protections merely because code requested navigation. A cancelled
browser sign-in may return to a fresh working page rather than preserving its
old transient state. Desktop sign-in cancellation before acceptance retains its
existing policy.

The explicit-store target permits several independently opened stores inside
that session. Independent store closure does not promise that handles survive
a document replacement or desktop restart. Local data retains its device-owned
address across account changes; a new session opens new handles.

Agent Pull, live-store SQL queries, and Push route to an identified running store
owner. The CLI does not acquire a second persistent replica. If that owner is
unavailable, the operation refuses; preparing edits in an existing working copy
requires no running owner. Restart does not wait for Push, so interrupted Push
recovery belongs to the working-copy engine.

Unexpected retirement of the required page or account context fences access
immediately and replaces the document with an inert recovery destination.
Optional inference retirement stays local to that feature. That destination opens nothing until the person
chooses to reopen. A navigation request is not proof of document destruction:
the old UI becomes inert while replacement is pending, and failures must not
re-enable the retired product. Browser history restoration cannot resurrect a
retired session.

**Resources outside a document are released by their owning host.**

Native recorder cleanup follows document/window loss. SQLite socket loss closes
the host's connection resources. Process shutdown ends remaining process-owned
resources. Old native session identities must not affect a successor document.
Recheck methods observe state; they do not replace host retirement. Remote
server work may also finish after page loss, and reload does not undo it.
Resource `close()`, individual acquisition rollback, storage transactions, account
fences, and component-local disposals remain where they have callers independent
of departure. Application-level drain promises do not gate navigation or restart.

## Consequences

The native close/resume protocol and page departure controller are removed.
Product boot retains explicit opening, rendering, and minimal replacement/failure
handling. Delete product handle arrays, aggregate close promises, sibling-signal
fan-in, and repeated late-acquisition cleanup only after the page boundary owns
their former obligations. Opening an optional resource cannot make its retirement
a reason to retire unrelated stores.
Applications no longer register asynchronous departure cleanup with it.

Already committed data remains recoverable. Pending writes, explicit-save
drafts, and unsaved recordings may be interrupted according to the warning
policy. A saved audio file can outlive a missing database row if the page ends
between those writes. This decision introduces neither a recovery queue nor a
new recording format.

Cancelled desktop sign-in before acceptance does not close working windows. Successful
sign-in closes them through process restart, including same-person sign-in.
Browser authentication remains document-based; desktop policy does not remove
the shared authentication library's browser installation and cancellation logic.

## Considered alternatives

- Keep restart after mutable live account installation: preserves the mismatch
  between a captured boot Account and a mutable auth owner.
- Remove window acknowledgements but retain page drains: deletes the protocol
  while leaving the page's separate shutdown state machine.
- Add fixed grace periods: delays departure without guaranteeing completion.
- Automatically reopen on retirement: risks repeated failure and silently
  starts another working session.
- Add a second authentication framework or crash-recovery service: moves the
  complexity instead of removing the waived guarantee.

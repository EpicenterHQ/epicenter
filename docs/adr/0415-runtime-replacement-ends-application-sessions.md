# 0415. Runtime replacement ends application sessions

- **Status:** Proposed
- **Date:** 2026-09-19
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

**One application document owns one session, and departure replaces the document.**

The mounted product captures its required account and opens its chosen resource
handles. Sign-in/callback and recovery documents open no primary product
resources. Ordinary navigation that retains those handles, such as Honeycrisp
Local/Personal navigation, remains inside the document.
Exits from its lifetime use full navigation rather than an awaited UI drain.

The explicit-store target permits several independently opened stores inside
that session. Independent store closure does not promise that handles survive
a document replacement or desktop restart. Local data retains its device-owned
address across account changes; a new session opens new handles.

Agent Pull, live-store SQL queries, and Push route to an identified running store
owner. The CLI does not acquire a second persistent replica. If that owner is
unavailable, the operation refuses; preparing edits in an existing working copy
requires no running owner. Restart does not wait for Push, so interrupted Push
recovery belongs to the working-copy engine.

Unexpected retirement fences access immediately and replaces the document with
an inert recovery destination. That destination opens nothing until the person
chooses to reopen. A navigation request is not proof of document destruction:
the old UI becomes inert while replacement is pending, and failures must not
re-enable the retired product. Browser history restoration cannot resurrect a
retired session.

**Resources outside a document are released by their owning host.**

Native recorder cleanup follows document/window loss. SQLite socket loss closes
the host's connection resources. Process shutdown ends remaining process-owned
resources. Resource `close()`, acquisition rollback, storage transactions, account
fences, and component-local disposals remain where they have callers independent
of departure. Application-level drain promises do not gate navigation or restart.

## Consequences

The native close/resume protocol and page departure controller are removed.
Product boot retains opening, rendering, and minimal replacement/failure handling.
Applications no longer register asynchronous departure cleanup with it.

Already committed data remains recoverable. Pending writes, explicit-save
drafts, and unsaved recordings may be interrupted according to the warning
policy. A saved audio file can outlive a missing database row if the page ends
between those writes. This decision introduces neither a recovery queue nor a
new recording format.

Cancelled sign-in before acceptance does not close working windows. Successful
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

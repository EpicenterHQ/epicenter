# 0083. `apps/email` is refused; Local Mail is the only Gmail client

- **Status:** Accepted
- **Date:** 2026-06-30

## Context

<!-- doc-path-check: ignore-next-line -->
`specs/20260606T114052-email-client-architecture.md` proposed a hosted-only, server-proxy webmail SPA: the browser never talks to Gmail, the Cloudflare Worker holds tokens and proxies every call, no local storage, no self-host mode. It was drafted before Local Mail (ADR-0081/ADR-0082) existed, and Local Mail's spec explicitly framed the two as coexisting, "the way `local-books` and a hypothetical hosted books UI would." That framing was carried as an open question, not a settled one: `apps/email`'s only real justification is no-install/mobile reach (a native Tauri app cannot ship to iOS/Android); every other reason (a "quick thin client", an "onramp") is weaker, and nobody had stated no-install reach as a committed product requirement. `apps/email` was never implemented past the spec; its only artifact is an unused Google OAuth Web-app client (`GOOGLE_MAIL_CLIENT_ID`/`GOOGLE_MAIL_CLIENT_SECRET` in Infisical), referenced nowhere in code.

## Decision

`apps/email` is refused. Local Mail (`apps/local-mail`, ADR-0081/ADR-0082) is the only Gmail client Epicenter builds. If no-install/mobile Gmail reach ever becomes a committed requirement, it is designed fresh at that time against whatever Local Mail has become, not resurrected from this spec.

## Consequences

<!-- doc-path-check: ignore-next-line -->
- `specs/20260606T114052-email-client-architecture.md` is deleted. It was never committed, so nothing in git history recovers it; its "UI Shape" layout and Gmail-scope/CASA research were carried into the Local Mail parent spec's Appendix, which has itself since been deleted (its work landed). Recover that body with `git show 68eb619e1f:specs/20260630T150000-local-mail-tauri-cdc-mirror.md`.
- The Google Cloud OAuth Web-app client behind `GOOGLE_MAIL_CLIENT_ID`/`GOOGLE_MAIL_CLIENT_SECRET` has no remaining purpose; it should be revoked in Google Cloud Console and the two secrets removed from Infisical `/api`, pending confirmation (a live external credential and a shared secret store, not a local git-reversible change).
- Local Mail's own Gmail OAuth client (spec open question 5) is a separate, new Desktop-app-type client in the same "Epicenter Mail" Cloud project (same consent-screen posture and scope sensitivity), not a reuse of the Web-app client this ADR retires.
- Local Mail's spec and handoff no longer need to justify their existence against a sibling app; the "Relation to `apps/email`" framing and the corresponding handoff open question are removed.

## Considered alternatives

- **Keep both, resolve later.** Rejected: leaving the question open let a spec sit un-built with live-but-unused Google credentials attached to it, which is exactly the kind of drift `docs/spec-history.md`'s hygiene gate exists to catch. Deciding now costs one ADR; deferring costs an indefinitely orphaned OAuth client and a spec nobody is executing.
- **Reuse `GOOGLE_MAIL_CLIENT_ID` as Local Mail's Desktop client instead of retiring it.** Rejected: it is a Web-app-type client tied to a fixed, pre-registered redirect URI (`localhost:8787/api/mail/accounts/connect/callback`). Local Mail's native, long-lived process needs the loopback-any-port exemption Google reserves for Desktop-app-type clients, which is a different client type, not a redirect-URI edit.

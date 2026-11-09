# 0070. Self-host adds no new ownership or auth mode: single-user is a preset, and only the credential source varies

- **Status:** Superseded
- **Superseded by:** [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md)
- **Date:** 2026-06-24
<!-- doc-path-check: ignore-next-line -->
- **Relates:** [ADR-0068](0068-privacy-is-a-deployment-not-a-product-feature.md) and [ADR-0069](0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) (self-host runs the star; this says self-host needs no new mode to do it), [ADR-0057](0057-assistant-markdown-renders-as-a-shared-component-tree-not-a-sanitized-html-string.md)/[ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) (the per-concern injection seams, of which `resolveUser` is one), [ADR-0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md) (auth owns the session endpoint); the recommended default credential source and the build waves live in `specs/20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md`.

> **Superseded by [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), then amended by [ADR-0092](0092-identity-is-the-partition.md).** Its load-bearing finding carries forward: single-user-ness is not a third ownership mode, and auth stays one total gate. What 0075 supersedes is this ADR's framing of self-host as the hosted star minus billing, selecting `solo`/`shared` presets that feed `personal()` and a first-boot bearer. ADR-0092 later deletes the ownership seam itself: the instance bearer resolves the literal `instance` principal, and that principal id is the partition key.

## Context

Self-host raised pressure for a third "sovereign" single-user ownership mode and for a no-auth path on a trusted home network. The server already exposes two orthogonal seams: `OwnershipRule` (`personal` keys data by `owners/<userId>/`, `shared` pins `owners/shared/` behind an `admit` predicate) decides the partition, and `resolveUser` decides how a request becomes an identity. A grill found single-user-ness is a property of neither seam as a new kind. The partition-count probe is decisive: `personal` with one registered user yields exactly one partition, and `shared` with one user also yields exactly one partition, because a key is either derived-per-identity or pinned-to-a-constant and that is the complete space. Separately, the only shipped credential source is Google OAuth (email/password is disabled), so a self-hoster must register a Google OAuth app to log into their own box, a cloud dependency that contradicts self-host.

## Decision

Self-host introduces no new ownership mode and no new auth gate. It composes from the two seams that already exist.

- **Partition stays exactly two: `personal` or `shared`.** "Single-user" / "sovereign" is a **preset** composition (for example `shared` with an admit-always predicate, or `personal` with one account), exposed as a factory beside `personal()` / `shared()` only if ergonomics warrant, and **never** a third `OwnershipRule.kind`. A new kind would have to either re-derive the key per identity (that is `personal`) or pin it to a constant (that is `shared`); it has no distinct partition behavior to contribute. Single-owner is an emergent count, not a topology.

- **Auth stays one total gate.** Every data route requires `resolveUser` to resolve a user; there is **no no-auth fork**, because removing the choke point grows a null-user branch through every owner-scoped route and `admit` predicate, which is where authorization bugs live. What varies per deployment is the **credential source** that feeds `resolveUser`, not whether the gate exists. Self-host gets a credential source that needs no third-party OAuth.

## Consequences

- **The Google-OAuth-to-reach-your-own-box wart is fixed by adding a local credential source, not by removing auth.** The spec's recommended default is a single-user bearer token printed at first boot (the minimal credential that still yields a real authenticated user, leaving the gate and the `personal` partition untouched). The specific default lives in the spec, not here, so it can be tuned without amending this decision.
- **Escape hatches compose at the same seam, all as `resolveUser` providers:** a reverse-proxy header for multi-user or SSO homelabs (the Gitea `X-WEBAUTH-USER` pattern), opt-in email/password for a browser login without a proxy, and the existing fixed-owner dev resolver kept quarantined behind a localhost guard for demos only.
- **Per-intent default is a spec concern, not a mode:** solo homelab uses the bearer token, family/multi-user puts their own IdP behind a reverse proxy, and a public shared wiki uses required auth plus the `shared` partition's `admit` predicate (the first-user-admin, lock-signups norm that Immich, Gitea, and Plausible converge on).
- **Orthogonality holds and is the whole point:** intent picks a credential source, the partition seam independently picks ownership, and single-user-ness is neither. The 401 gate, the partition switch, and every owner-scoped route never learn that "self-host" or "single user" exists.
- **What this forecloses:** a `sovereign` `OwnershipRule.kind` (fake symmetry that splits one concept across an axis that does not own it), and a no-auth code path (a duplicated security-critical gate for a difference that lives entirely in one resolver).

## Considered alternatives

- **A third `sovereign` ownership kind.** Rejected: zero distinct partition behavior; both existing kinds already collapse to one partition when there is one user.
- **A no-auth path for the trusted LAN.** Rejected as a mode: it removes the choke point. The same effect is available as the quarantined fixed-owner `resolveUser` provider behind a hard localhost guard, which keeps the gate total.
- **Re-enable email/password as the self-host default.** Rejected as the default (it needs a mail sender for reset and carries takeover risk), kept as an opt-in provider for the no-proxy browser-login case.

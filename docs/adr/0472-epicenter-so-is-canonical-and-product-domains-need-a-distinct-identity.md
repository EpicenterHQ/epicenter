# 0472. Epicenter.so is canonical, and product domains need a distinct identity

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [Product articulation](0470-epicenter-helps-people-make-software-that-is-unmistakably-theirs.md) and [publisher identity](0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md).
- **Unbuilt:** hosted personal addresses and custom-domain bindings; this record does not select their suffix.

## Context

Epicenter needs one address people can remember as its product home. Registering
another extension for every possible app adds renewal costs and fragments that
identity. A music player or mail client can belong to Epicenter without needing
a separate registrable domain.

The Ark has a different intended identity: a writing and social home. That
purpose warrants its own product address rather than making it a generic app
hosting domain.

## Decision

**Epicenter's canonical product address is `https://epicenter.so`.**
`epicenter.software` is a redirect-only alias. Its root and `www` redirect to
HTTPS on `epicenter.so` with a permanent 301, retaining the path and query string.
The alias hosts no separate product or account system.

**A separate product domain needs a distinct product identity.** A feature name
or a possible future app is insufficient. `music.epicenter.so` is a possible
address for an Epicenter music app; its existence does not require retaining
`epicenter.audio`. Publisher-owned apps may instead use their publisher's domain.

**The Ark keeps `theark.so` as its writing and social product home.** A person's
public home may combine published pieces, short posts, and social activity.
This direction does not make The Ark the host for unrelated personal apps.
Its profile routes and custom-domain support require their own implementation.

The free personal hosting suffix remains undecided. Purchasing the software
alias does not select it. Product addresses, hosted app addresses, and data
identifiers have different jobs.

## Consequences

Links and product metadata use `epicenter.so`. Redirect aliases preserve old or
alternate entry points without creating another product to maintain. Renewal
choices follow actual product use rather than speculative feature categories.

As of September 30, 2026, `epicenter.software` is registered and its root and
`www` redirects have been verified over HTTP and HTTPS. Cloudflare terminates
TLS and runs the redirect; its proxied DNS records use the documented
`192.0.2.1` placeholder. Auto-renewal for `epicenter.audio` is disabled; its
current registration expires July 11, 2027. These are operational observations,
not promises that every other registration should be retired.

## Considered alternatives

- Give each app an Epicenter domain with a category extension. This creates
  renewal obligations before a separate identity or product exists.
- Make `epicenter.software` canonical. The existing product and service addresses
  already use `epicenter.so`; the alias communicates the category without a move.
- Use The Ark for personal software hosting. This conflicts with its writing
  and social purpose.

## References

- [Cloudflare redirect-only domain setup](https://developers.cloudflare.com/fundamentals/manage-domains/redirect-domain/).

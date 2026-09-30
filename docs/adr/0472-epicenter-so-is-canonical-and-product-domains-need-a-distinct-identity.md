# 0472. Epicenter.so is canonical, and product domains need a distinct identity

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [Product articulation](0470-epicenter-helps-people-make-software-that-is-unmistakably-theirs.md) and [publisher identity](0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md).
- **Unbuilt:** hosted personal addresses and custom-domain bindings; ADR-0473 records their intended address model.

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
The following domains are aliases for the canonical product address:

| Domain | Web behavior | Email behavior |
| --- | --- | --- |
| `epicenter.software` | Root and `www` redirect to `https://epicenter.so` | Unchanged |
| `epicenter.md` | Root and `www` redirect to `https://epicenter.so` | Existing email DNS is preserved |
| `getepicenter.com` | Root and `www` redirect to `https://epicenter.so` | Existing email routing and DNS are preserved |

Each alias returns a permanent 301 over HTTP and HTTPS, retaining the path and
query string. The aliases host no separate product or account system. A web
redirect does not retire a domain's email use.

**A separate product domain needs a distinct product identity.** A feature name
or a possible future app is insufficient. `music.epicenter.so` is a possible
address for an Epicenter music app; its existence does not require retaining
`epicenter.audio`. Publisher-owned apps may instead use their publisher's domain.

**The Ark keeps `theark.so` as its writing and social product home.** A person's
public home may combine published pieces, short posts, and social activity.
This direction does not make The Ark the host for unrelated personal apps.
Its profile routes and custom-domain support require their own implementation.

ADR-0473 records the intended personal addresses at `username.epicenter.so` and
app addresses at `myapp.username.epicenter.so`, subject to a safe hosting design
before launch. Purchasing the software alias does not select a hosting suffix.
Product addresses, hosted app addresses, and data identifiers have different jobs.

## Consequences

Links and product metadata use `epicenter.so`. Redirect aliases preserve old or
alternate entry points without creating another product to maintain. Renewal
choices follow actual product use rather than speculative feature categories.

As of October 1, 2026, all three aliases have verified root and `www` redirects
over HTTP and HTTPS, including path and query preservation. Cloudflare
terminates TLS and runs the redirects. The web DNS records are proxied;
redirect-only A records use the documented `192.0.2.1` placeholder.
`epicenter.md` retains its existing proxied root CNAME. The redirect setup
preserved existing email records on `epicenter.md` and `getepicenter.com`.

Cloudflare's dashboard owns the alias rules. The repository's
[domain audit](../../ops/README.md) checks selected zone settings and public
email records without changing them. It does not provision redirects or
promise automatic repair. Operators verify redirects after intentional changes.

Auto-renewal for `epicenter.audio` is disabled; its current registration expires
July 11, 2027. These are operational observations, not promises that every other
registration should be retired.

## Considered alternatives

- Give each app an Epicenter domain with a category extension. This creates
  renewal obligations before a separate identity or product exists.
- Make `epicenter.software` canonical. The existing product and service addresses
  already use `epicenter.so`; the alias communicates the category without a move.
- Use The Ark for personal software hosting. This conflicts with its writing
  and social purpose.

## References

- [Cloudflare redirect-only domain setup](https://developers.cloudflare.com/fundamentals/manage-domains/redirect-domain/).

# 0473. Personal app hosting keeps addresses separate from data identity

- **Status:** Proposed
- **Date:** 2026-09-30
- **Amends:** [ADR-0335](0335-a-person-is-an-origin-and-an-app-is-a-path-under-it.md) at mandatory app paths, shared browser state, and the required hosting suffix. Isolation from other people's code remains necessary.
- **Relates:** [Independent applications](0449-epicenter-connects-independent-applications-through-personal-data.md), [publisher identity](0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md), and [portable folder scopes](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md).
- **Unbuilt:** all personal bundle hosting, username allocation, certificates, custom-domain bindings, and authenticated cross-origin data access.

## Context

ADR-0335 gave one person one origin and put every app at a path beneath it.
Independent apps may have separate deployments, publishers, and browser
lifecycles. Sharing a person's data does not require sharing browser storage,
service workers, or a session credential. Different component libraries alone
do not require different origins.

A person's home address helps them find their apps. It does not identify the
saved data or imply that the home and its contents are public.

## Decision

**Treat a personal home, an app deployment, and a data folder as separate
concepts.** A home can link to independently hosted apps. A free address and an
optional custom domain are ways to reach a deployment. Neither replaces account
scope or a stable data definition ID.

The intended shape supports a personal home and app subdomains:

```text
braden.<hosting-domain>            personal home
music.braden.<hosting-domain>      independent music app
bradenwong.com                     optional custom home
music.bradenwong.com               optional custom app address
```

These are examples, not allocated addresses. The hosting suffix remains open.
Apps may also be published at a publisher's domain and used by multiple people
with their own data. Serving an app bundle publicly does not publish its users'
files.

**App IDs identify software; data definition IDs identify data contracts.**
They may match by convention. Compatible apps may use the same data definition,
and one app may use several definitions. A reverse-domain identifier is a stable
name chosen by its publisher, not proof of domain control or an access grant.
Account scope distinguishes different people's data using the same definition.
A URL change must not silently rename those identifiers.

**Shared data access must be explicit and authenticated.** Separate app origins
have separate browser storage, permissions, and service workers. Moving a URL
does not move existing browser data. The hosting design must specify access,
credential issuance, and any storage migration before launch. Visiting another
person's app must never give its origin the visitor's account credential.

The proposed amendment withdraws ADR-0335's mandatory app paths and shared
browser state. A separate registrable hosting domain is a candidate isolation
strategy; a particular extension or Public Suffix List entry is not selected
here. The replacement must establish isolation between people and protect
vendor authentication before any user code is served.

## Consequences

The next hosting design must settle the suffix, username ownership and reuse,
origin isolation, authenticated data access, and custom-domain ownership checks.
It must also prove certificate provisioning: an ordinary wildcard covers one
label, so `*.example.com` does not cover `music.braden.example.com`.

Public materials can describe this direction as planned. They must not offer
free addresses, custom domains, or shared browser folders as available features.
This record does not change the current app storage layout or auth origin list.

## Considered alternatives

- Require all of a person's apps to share one origin. This couples independent
  deployments to the same browser state and service-worker namespace.
- Derive data identity from the current URL. Moving a deployment would appear
  to create new data, and compatible apps could not retain a common contract.
- Require everyone to purchase a domain. A free default address should let a
  person start before paying for or configuring DNS.

## References

- [Cloudflare Universal SSL hostname limits](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

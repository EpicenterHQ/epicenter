# 0473. Personal app hosting keeps addresses separate from data identity

- **Status:** Proposed
- **Date:** 2026-09-30
- **Amends:** [ADR-0335](0335-a-person-is-an-origin-and-an-app-is-a-path-under-it.md) at mandatory app paths, shared browser state, blanket trust between apps, and the required hosting suffix. Independently published apps have separate origins.
- **Amends:** [ADR-0246](0246-an-app-is-named-by-its-full-reverse-domain-id-everywhere-including-the-ones-epicenter-ships.md) at public hosted addresses: readable hostname labels may resolve full app IDs; internal host routes, deep links, and on-disk IDs keep the full identifier.
- **Relates:** [Independent applications](0449-epicenter-connects-independent-applications-through-personal-data.md).
- **Unbuilt:** all personal bundle hosting, username allocation, certificates, custom-domain bindings, and authenticated cross-origin data access.

## Context

Epicenter helps people make, remix, and publish independent applications over
portable data. A maker can also be the first user, but publishing software does
not make the maker the owner of everyone else's data.

App paths under one personal origin suit a collection of mutually trusted tools.
They do not match the intended publishing model: Alice can remix Whispering,
release her version independently, and let other people use it with their own
folders. Her app needs a separate identity and execution boundary even when it
understands the same files as Braden's app.

The desktop host lists applications by ID and title in
`apps/epicenter/src/applications.ts` and serves built assets through
`apps/epicenter/src/server.ts`. This separates the app index from app builds;
it does not implement personal browser hosting or cross-origin folder access.

## Decision

**A maker's default home is `<handle>.epicenter.so`, and independently published
apps run at `<app>.<handle>.epicenter.so`.**

| Address | Purpose | Application ID |
| --- | --- | --- |
| `alice.epicenter.so` | Alice's home and index of her published apps | No app ID implied |
| `whispering.alice.epicenter.so` | Alice's independently published Whispering remix | `so.epicenter.alice.whispering` |
| `whispering.bradenwong.com` | Braden's publisher-domain home for Whispering | `com.bradenwong.whispering` |

A publisher-owned domain can present an app through the same app-subdomain
convention. The publisher address serves software or its public product home;
it does not identify the person currently using it. Braden and Bob can both use
Alice's published app with separate account-scoped data.

**Each independently published browser app has its own origin.** The maker's
index links to apps rather than running all their code on its origin. Separate
origins keep apps' browser storage and execution contexts distinct; portable
folder access connects apps through explicit authorization instead of shared
ambient browser state. Arbitrary app code receives no vendor-wide or
visitor-wide account credential merely because someone opens its URL.

**Application IDs use stable publisher-qualified reverse-domain names.** An
Epicenter publisher namespace can use `so.epicenter.alice`; a publisher with
an owned domain can use `com.bradenwong`. Their apps add a final name such as
`whispering`. These are durable identifiers, not repeated computations from
the current URL. Changing a handle, serving domain, or hostname label must not
rename the app or existing data. Domain-like spelling is neither proof of domain
control nor an access grant.

Hosted publisher namespaces must stay bound to the same publisher. A handle
change preserves existing IDs; handle reuse must never transfer an old
publisher namespace. Hostname bindings must also protect visitors' existing
origin-scoped data and permissions before any address can be reassigned.
Public hostname labels resolve full app IDs; internal host routes, deep links,
and on-disk identifiers retain their full-ID contracts.

**An app defaults to one portable folder bearing its app ID, and can explicitly
open other compatible folders.** Tables and settings stay inside the folder;
table segmentation alone does not create suffix IDs such as a speech-specific
folder. Local or account scope identifies whose dataset is opened.

| Application ID | Opened folder ID | Relationship |
| --- | --- | --- |
| `com.bradenwong.whispering` | `com.bradenwong.whispering` | Braden's app uses its default folder |
| `so.epicenter.alice.whispering` | `com.bradenwong.whispering` | Alice's compatible remix uses the existing folder |
| `so.epicenter.alice.whispering` | `so.epicenter.alice.whispering` | Alice's remix uses its own dataset |

The person using the app selects and authorizes the folder. Naming a compatible
folder ID alone grants no access. Reusing a folder must preserve its format and
source data through the folder's read and write contract.

**Copying into a remix's own folder creates an independent dataset.** An explicit
copy preserves the source and creates destination files under the destination
scope. Copy compatible authored content; use an explicit conversion when the
formats differ. A copy does not establish ongoing synchronization or transfer
credentials and private device state. Reusing the same source folder and
creating a copy are separate choices, not automatic effects of remixing code.

The intended `epicenter.so` suffix still requires a verified hosting and
authentication isolation design. Separate app origins alone do not settle
parent-domain cookies, vendor authentication, or safe person-controlled hosting.
Revisit the serving suffix before launch if those guarantees require a separate
registrable domain or Public Suffix List treatment.

This record selects publisher app subdomains. Personal-domain private workspaces,
custom-domain alias and migration behavior, and The Ark's publication domains
or domain-based social handles remain separate decisions.

## Consequences

The public address and durable app namespace express the same publisher/app
relationship without making the current URL the owner of saved data. A remix
has its own deployment and ID while remaining able to use compatible existing
files. Publishing a remix does not publish the maker's or its users' data.

Each app can have its own release schedule, browser cache, service worker, and
local storage. A new deployment adds a hostname and certificate coverage rather
than only a path. Ordinary `*.epicenter.so` coverage does not cover
`whispering.alice.epicenter.so`; deeper certificate provisioning is required.
A deployed SPA build can serve many users without per-user copies of its assets.

The browser does not automatically share IndexedDB across app origins, even if
two apps declare the same folder ID. Browser folder selection, authorization,
and transfer must establish the portable-data promise explicitly. A custom
address or handle change also needs preservation of existing local-only work.
Several users of one published app need account-scoped data separation; its
publisher hostname supplies no user isolation.

Hosting remains unbuilt. Before launch, prove namespace and hostname lifetime,
certificate provisioning, authentication boundaries, compatible folder access,
explicit copying, and local-data preservation. The product proof is Alice
remixing an app, reopening existing data through it, then making an independent
copy that survives reopening without changing the source.

## Considered alternatives

- `alice.epicenter.so/whispering`: cheaper routing for mutually trusted tools,
  but independently authored apps share one browser origin. Connecting portable
  data should not require collapsing their execution boundaries.
- `epicenter.so/alice/whispering`: shares a browser origin across publishers
  and puts their executable code beside the vendor application.
- Give every remix a new data format and require copying: prevents replacing
  an interface while retaining compatible existing files.
- Require a remix to retain the original app ID: confuses independent software
  identity with compatibility with the original folder.
- Give every table a reverse-domain folder ID: restores segmentation that one
  portable app folder no longer needs.

## References

- [Browser origins and paths](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).
- [IndexedDB origin boundaries](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API).
- [Cloudflare Universal SSL hostname limits](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

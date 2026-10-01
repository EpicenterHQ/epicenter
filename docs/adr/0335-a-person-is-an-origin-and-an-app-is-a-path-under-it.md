# 0335. A person is an origin, and an app is a path under it

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amended by:** [ADR-0473](0473-personal-app-hosting-keeps-addresses-separate-from-data-identity.md), proposed: revisits mandatory app paths and the hosting-domain requirement. The original decision remains below as history; the replacement hosting design is unbuilt.
- **Amends:** [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) at its web line. "The origin the bundle was served from IS the deployment" is withdrawn for "the bundle, at its origin and its path, is the deployment," because one person's origin carries several apps that may name different authorities. It also inherits ADR-0326's dangling gate: that record deferred desktop self-host "until the install plane ships," and the plane it meant was [ADR-0305](0305-the-third-party-app-catalog-is-a-future-epicenter-deployment-plane.md)'s. ADR-0334 superseded that record, so the deploy verb described here is the plane, and the gate now points at this.
- **Relates:** [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) (why no boundary is needed between one person's apps), [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) (the app segment this makes mandatory), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (the single-principal instance)
- **Unbuilt:** all of it. No user bundle hosting exists: `apps/api` serves one SPA from a static binding and declares no R2 bucket. There is no deploy verb on either deployment.

## Context

[ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md)
decided that a deployed app is a trusted app, and that the isolation between one
person's apps is nominal. That answers what happens *inside* a person's own
estate. It says nothing about what separates one person's estate from another's,
and the browser answers that question with the origin whether a design does or
not.

The tempting shape is one origin for everything, with a path per person and per
app. It fails on one ordinary act: sharing a link. Origin-scoped storage is not
path-scoped, so a person who opens somebody else's app URL is running that
person's code beside their own apps' replicas, and beside the bearer that
ADR-0326 moved into origin-scoped storage. One click is a full account takeover,
and no product policy prevents it, because a URL that resolves is a URL that
runs.

## Decision

**A person is an origin. An app is a path under it.**

```txt
  braden.epicenter.app/board      one deployment
  braden.epicenter.app/todos      another
  braden.epicenter.app/           the person's own index
```

**The apps under one person's origin share everything, on purpose.** One
storage bucket, one session, one set of permission grants. That is ADR-0334
applied at the right scope: they are all this person's, deployed by this person,
and a boundary between them would be the lock with no door ADR-0201 refused.

**Nobody else's code is ever on a person's origin.** That is the property the
subdomain buys, and it is the only isolation this design asks the browser for.

**User content lives on its own registrable domain, listed in the Public Suffix
List.** Not `epicenter.so`. The vendor plane, the marketing site, the Cloud
dashboard, and their session stay where they are, and deployed code never shares
an origin with them. Without the PSL entry a person could set a
`Domain=.epicenter.app` cookie that reaches every other person's origin, so the
entry is load-bearing rather than hygiene, and its propagation rides browser
releases, so it precedes a launch rather than accompanying one.

**A self-hosted instance is this shape with one person on it.** Its origin
serves its own apps, and the property holds by construction because the only
deployer is the only principal (ADR-0075). An operator who begins hosting other
people's apps on that origin has recreated the shared-origin hazard, knowingly.

## Consequences

- **The store address must carry the app segment**, which ADR-0324 now does. Two
  of one person's apps naming one data id would otherwise compose one browser
  address: sequentially they interleave two histories in one record, and
  concurrently the second is refused by a lock named after the address. ADR-0304
  pre-authorized exactly this fix.
- **One origin is one eviction bucket.** Browser storage pressure evicts a whole
  origin, so it can take every app a person has at once, and ADR-0325 leaves a
  browser deployment unable to export. Ask for `navigator.storage.persist()`,
  and say plainly that the durable copy is the desktop. This is a durability
  cost, and "deploying is the consent" does not answer it.
- **Reserve the root and refuse nesting.** A service worker's scope is its path,
  so an app deployed at `/` would control every navigation on that person's
  origin. The root belongs to the person's index, one app never nests under
  another's path, and `/.well-known/` is the platform's. None of this can be
  retrofitted after somebody ships at `/`.
- **A username is an origin, permanently.** Reserve the names an origin cannot
  safely be (`www`, `api`, `admin`, `mail`, `cdn`, and the platform's own), and
  never recycle one: a recycled name hands its new owner every visitor's
  origin-keyed state and every permission grant the previous owner was given.
- **A permission is granted to the person, not to the app.** Notifications, the
  camera, and geolocation are origin-scoped, so one grant covers everything that
  person has deployed. That is ADR-0334 applied consistently, and it will still
  surprise somebody.
- One wildcard certificate covers one label, so `*.epicenter.app` covers this
  shape and nothing deeper. A per-app subdomain would need a wildcard per person
  and would bring a certificate authority's rate limit into the signup path.
- The URL reads as what it is, and inherits a mental model people already hold
  from GitHub Pages: the subdomain is the person, the path is the thing.

## Considered alternatives

- **`epicenter.so/<user>/<app>`.** Rejected. Deployed code would share an origin
  with the Cloud dashboard's session, and a cookie `Path` is not a boundary, so
  an app could act as the person in the dashboard. ADR-0326 already closed this
  door by observing that ADR-0118's one-origin decision "never contemplated code
  installed from a URL."
- **`epicenter.app/<user>/<app>`, one origin for everyone.** Rejected, and this
  is the one that looks fine until it does not. Storage is origin-scoped, so
  opening somebody's shared link runs their code beside every replica and every
  credential the visitor holds on that origin. It also means one person's XSS is
  everyone's. Refusing to support shared links is not a mitigation, because the
  browser does not enforce product policy.
- **`<app>.<user>.epicenter.app`, an origin per app.** Rejected. It buys a
  boundary ADR-0334 declares unnecessary, and it costs a wildcard per person
  through ACME DNS challenges or per-hostname certificate pricing. Two-label
  subdomains also read as phishing to people trained to check them.

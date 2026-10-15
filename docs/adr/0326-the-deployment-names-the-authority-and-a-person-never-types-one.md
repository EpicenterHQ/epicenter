# 0326. The deployment names the authority, and a person never types one

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md) at what the host holds: one connection per authority named by an installed bundle, **derived** from what is installed rather than stored. Its refusal of a saved-connection registry, generated profile ids, and a credential wallet stands, and is honoured more literally than before: nothing is remembered.
- **Amends:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) at its delivery mechanism. OAuth stays hosted-only and a custom instance still requires a token; the token stops arriving through a settings modal a person pastes into.
- **Amended by:** [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) at this record's two third-party clauses, both withdrawn: that a self-claimed app id is "not sufficient for third-party code," and that admitting such code needs an isolation boundary. No boundary is coming; deploying is the consent. Everything else here stands.
- **Amended by:** [ADR-0335](0335-a-person-is-an-origin-and-an-app-is-a-path-under-it.md) at this record's web line: "the origin the bundle was served from IS the deployment" becomes "the bundle, at its origin and its path, is the deployment," because one person's origin carries several apps. That record also re-derives this one's "desktop self-host is refused until the install plane ships," whose plane was ADR-0305's and is now the deploy verb ADR-0335 describes.
- **Amended by:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the ADR-0071 clause that OAuth stays hosted-only and a custom instance still requires a token. A self-hosted build names its own origin as the authorization server it signs in to; everything else here stands.
- **Relates:** [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (the one origin this leaves in place, for first-party apps only), [ADR-0305](0305-the-third-party-app-catalog-is-a-future-epicenter-deployment-plane.md) (the plane this presumes), [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) (an app is a directory)
- **Unbuilt:** all of it, and one part is gated. The derived connection set and the deletions below are reachable now. App-id-as-deployment presumes the install plane ADR-0305 defers, and presumes desktop stores having moved to `apps/<app-id>/data/` per ADR-0324; until both, it names an end state rather than a shipping shape.
- **Supersedes:** [ADR-0263](0263-a-connection-is-one-server-at-a-time-and-a-replica-is-derived-from-it.md), which restated the connection contract this record replaces. Selecting a server at runtime, switching without export, and the server URL as storage identity are all withdrawn.

## Context

[ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md)
refuses in-place rebinding. That leaves a question it does not answer: where does
the authority's URL come from in the first place?

Today it is a runtime setting. The auth package's instance-setting module (since deleted by this record) keeps a
`{ baseURL, token }` override in `localStorage`, and
`apps/self-host/README.md` documents pasting one as *the* self-host flow. A
setting is the wrong shape for a fact that, after ADR-0325, can never change.

## Decision

**The authority is a property of the deployment, and no runtime surface selects
one.**

```txt
  web        the origin the bundle was served from IS the deployment
  desktop    the app id the bundle was installed under IS the deployment
```

A self-hoster does not point an installed app at their box. They deploy the app,
and their deployment names their authority. On the web that is their origin; on
desktop, once the install plane exists, that is a distinct app id
(`com.example.honeycrisp` rather than `so.epicenter.honeycrisp`), which under
ADR-0314 is a distinct directory holding a distinct bundle and distinct data.

**The connection set is derived, never stored.** The host reads the distinct
authorities named by installed bundles. In a standard install every first-party
app names the same one, so "one connection, one sign-in" survives as a theorem
rather than a rule, and the set grows only by exactly the authorities a person
chose to install.

**A definition never names a URL.** `authority: 'epicenter'` means "this
deployment's authority," which is why the same definition can run under many
deployments unchanged.

**What can be asserted, and what must be checked.** A fact can be made structural
exactly when the party that names the address knows the fact at naming time. The
origin is known at deploy time, the app id at build time, the generation at import
time. **A principal is asserted by a remote party at first sign-in, after local
data can already exist**, so it is the one identity here that can only be
stamped, never addressed. That is the boundary of the method, not a gap in it.

## Consequences

- Deleted, and now actually deleted: the auth package's instance-setting module
  and its test, Honeycrisp's `instance.ts` and its `epicenter-host` leaf, the
  `#platform/instance` seam, and `packages/app-shell`'s instance-settings modal.
  With them go `decodeInstance`'s corrupt-record fallback, the
  "half-configured record reads as hosted" rule, the runtime enforcement of
  ADR-0071, and write-then-reload.
- The token survives and moves where it belongs. `{ baseURL, token }` conflated a
  locator with a credential: the locator becomes a deployment fact, and the token
  becomes sign-in state in `persisted-auth-storage`. Token authentication
  (`instance-token.ts`, `instance-token-auth.ts`,
  `instance-credential-authority.ts`) is unchanged; only how the token arrives
  changes.
- **Desktop self-host is refused until the install plane ships.** A self-hoster
  uses their browser deployment, which works today. This kills the desktop
  asymmetry by refusal rather than by machinery, and it is available immediately.
- If a self-host instance serves its own SPA, `TRUSTED_BROWSER_ORIGINS` shrinks to
  nothing on that path: a CORS allowlist becomes a same-origin impossibility. That
  is a consequence available to whoever takes it, not a decision this record
  makes, and it has a cost: a person moving from a separately-hosted SPA to an
  instance-served one lands on a different origin and therefore a different local
  store, so their data moves by ADR-0325's export and import.
- On desktop the app id is **a coordinate, not a boundary**. ADR-0118 is explicit
  that ids "separate data logically, not as a sandbox or security boundary," and
  the `appId` in a storage request is self-claimed. That is sufficient for
  preventing accidental cross-authority mixing between cooperating first-party
  builds. It is **not** sufficient for third-party code, and nothing in this
  record should be read as making it so.
- ADR-0118's one-origin decision stands, and its scope should be read narrowly:
  it decided that *every release-bundled first-party SPA* is fully trusted on one
  origin. It never contemplated code installed from a URL. Admitting such code
  needs an isolation boundary this record does not provide and ADR-0305 has not
  yet decided.

## Considered alternatives

- **Hard-code the base URL and keep everything else.** Rejected on its own. The
  authority is `(base URL, principal)`, and signing in as a different principal at
  the same server is also a rebinding, so baking the URL alone leaves the hazard
  intact. It also degrades self-hosting for nothing while ADR-0071's token still
  has to reach the client somehow.
- **Keep a runtime instance setting and make rebinding destructive.** Rejected by
  ADR-0325; this record removes the surface that would have made it reachable.
- **Let the desktop host be an authority.** Rejected.
  [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md)
  refuses a host-owned data plane and ADR-0227 widened that refusal. Two further
  reasons specific to this record: an authority supervised by the desktop app dies
  on Quit, but an authority is what a person's *other* devices converge through;
  and a loopback URL is a poor durable identity to stamp into every device's
  database. "My laptop is my authority" is available as the self-host instance
  running as a second program on that machine, selected by its own URL.
- **Serve every deployment's SPA from its authority's origin**, so
  `window.location.origin` is always correct and no constant is baked at all.
  Rejected as out of scope: it is the logical endpoint of this record, and it
  trades a product-facing URL structure for a build constant. Named here so a
  later reader knows it was seen.

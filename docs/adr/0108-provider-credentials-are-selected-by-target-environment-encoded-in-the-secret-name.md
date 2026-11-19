# 0108. Third-party provider credentials are selected by the app's target-environment, which is encoded in the secret name and resolved by one injected helper

- **Status:** Accepted
- **Date:** 2026-07-03
- **Relates:** [ADR-0069](0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) (the `{baseUrl, token?}` service floor and injected-resolver posture), ADR-0075 and [ADR-0092](0092-identity-is-the-partition.md) (the principal bearer is a different job from a provider credential; see the boundary note below)

## Context

Several Epicenter apps authenticate to a third-party provider that has both a
non-production account and a production account: QuickBooks in `apps/local-books`
(Intuit's Development vs Production keysets), Plaid in the planned finance app
(sandbox / development / production), and more to come.
Two orthogonal axes get conflated at the point where a credential is read:

- **Vault environment:** which secret store holds the value. Locally this is the
  Infisical environment chosen out-of-band by whoever runs `infisical run
  --env=dev|staging|prod`. On a hosted Worker it is the Wrangler secret set.
- **Provider environment:** which external account a credential authenticates to
  (QB `sandbox` vs `production`; a dev vs a prod OAuth client). This is a
  property of the credential itself, and the app selects it with a flag
  (local-books' `--qb-env`).

Today the secret name is **unqualified** (`QB_CLIENT_ID`, `GMAIL_CLIENT_ID`), the
same name lives in more than one vault environment holding different values, and
the app reads it with no tie to its provider-environment flag. Two knobs must
agree and nothing enforces it. On 2026-07-03 this failed in production QA:
`infisical run --env=prod` injected Intuit's Production `QB_CLIENT_ID` while the
app ran `--qb-env sandbox`; Intuit rejected the OAuth callback with an opaque
"invalid redirect_uri" (localhost is registered only under the Development
keyset), which read as a redirect misconfiguration, not a wrong-key problem. The
class is latent in every app that follows the same unqualified-name pattern.

## Decision

A third-party provider credential is selected by exactly one knob, the app's
**provider-environment** (target), and that selection is carried in the secret's
**name**, never in which vault environment happened to inject it. Three rules:

1. **Name encodes the provider environment, for the roles that actually vary.**
   A role whose value differs per account is `${PREFIX}_${ENVIRONMENT}_${ROLE}` in
   `UPPER_SNAKE` (`QB_SANDBOX_CLIENT_ID`, `QB_PRODUCTION_CLIENT_SECRET`,
   `PLAID_SANDBOX_SECRET`). A role whose value is shared across accounts stays
   `${PREFIX}_${ROLE}` (`PLAID_CLIENT_ID`: one client id, a secret per
   environment). The provider's `spec` declares which roles are shared vs
   per-environment, so the convention follows the provider's real shape rather
   than forcing a fake symmetry. The old undifferentiated unqualified form (a
   per-account value under `${PREFIX}_${ROLE}`) is retired. **Which vault environment
   stores a given qualified name is an orthogonal access-control choice, not a
   selector:** an operator MAY keep the production credential in the `prod` vault
   env and the sandbox credential in the `dev` vault env for RBAC, or put both in
   one env for a single-injection deploy (a Worker's flat binding set). Because
   the name is qualified, every placement is safe; the vault env never disambiguates.

2. **One injected resolver.** A single pure-TS helper,
   `resolveProviderCredentials(spec, environment, read?)`, builds the qualified
   names from a small per-provider `spec`, reads them through an injected
   `read: (name) => string | undefined` source (default `process.env`, so a
   hosted Worker passes `(n) => env[n]` and nothing else changes), and either
   returns a typed record or throws a message naming the exact missing qualified
   variables. It lives in `@epicenter/constants` (AGPL, already a `local-books`
   dependency, zero runtime deps, `bun build --compile`-safe). The shared package
   owns only the mechanism (the resolver, the `ProviderCredentialSpec` type); each
   app owns its own `spec` (`QB_SPEC` in `local-books`). There is no central
   provider registry: a spec is app-local code,
   not shared config, so no package accretes knowledge of every app's providers.

3. **The minted token carries and asserts its provider environment.** When an
   app mints an OAuth token it tags the persisted token with the environment it
   was minted for, and every later use asserts the tag equals the requested
   environment, refusing loudly on mismatch. `local-books` already records this
   tag (`TokenSet.environment`) but does not assert it; this ADR makes the
   assertion mandatory, the same shape as `local-mail`'s existing `clientIdUsed`
   drift guard. This token tag is the only credential-provenance check: no
   parallel `*_ENVIRONMENT` vault secret is introduced, because a tag stored
   beside a mispasted value catches nothing it isn't equally likely to get wrong.

4. **Provider environment is chosen once, at connect, and persisted, not passed
   per command.** The account/realm records its environment at connect/auth time
   (beside the client identity a token already records), and every later command
   reads it from that record and asserts it. The selection flag (`--qb-env`) is
   the connect-time chooser and disambiguator (required only when more than one
   environment's credentials are present), never a per-run mode knob.

The app's only portable interface to any secret backend is the flat
`name -> value` map that Infisical, a `.env` file, Docker secrets, systemd,
Kubernetes secrets, and Wrangler bindings all project into at process start.
Selection therefore rides on the variable name (rule 1), the one thing every
backend carries identically; it never rides on a backend concept the app cannot
portably observe, such as "which Infisical environment injected this."

Rules 1 and 2 make the incident's class (knob mismatch) impossible by
construction: the flag picks the name, so the wrong vault environment can no
longer substitute the wrong account's key. Rules 3 and 4 are defense-in-depth
for a different, rarer mistake (a wrong value stored under a correct name, or a
token minted for one environment reused against another). That content mistake
is made hard and loud, not impossible: closing it fully would need a provider
probe or attested credential, heavier than the whole convention.

**Qualify when a provider has more than one environment.** A provider with a
single environment declares a single-element `environments` and MAY keep an
unqualified name; the moment its `spec.environments` grows past one, the resolver
reads only qualified names and fails loudly on an unqualified leftover, so the
ambiguous form cannot survive the growth.

**Boundary: this is not the principal bearer.** Provider credentials
(QuickBooks, Gmail, Plaid) authenticate an app to an external service. They are a
distinct concern from Epicenter's own partition authentication, which is the one
`ResolvePrincipal` seam and the operator-supplied instance bearer (ADR-0075,
ADR-0092). This ADR does not touch principals, `{baseUrl, token?}` service
connections, or storage partition keys, and adds no in-app privacy or credential
tier surface (ADR-0068).

## Consequences

- The knob-mismatch failure becomes unrepresentable: the provider-environment
  flag alone determines which key is read, independent of vault environment and
  deploy host.
- Secret names roughly double per provider (both accounts stored under distinct
  names). The "the vault env I injected from picks the account" coupling is
  deleted: a flag/vault disagreement now surfaces as an immediate, self-describing
  "Missing `${PREFIX}_${ENV}_...`" error at resolution time, instead of an opaque
  provider-side rejection several calls later. Where each qualified name is stored
  stays the operator's access-control choice (see Decision rule 1). A migration
  renames the existing values in place before the unqualified reads are removed;
  it need not move any secret between vault environments.
- The `:local` / `:remote` script-suffix (blast radius) convention shifts its
  signal from the vault environment to the provider environment: a script that
  touches the production provider account is the production-blast-radius script,
  whatever vault env it draws from. Provider-target scripts are named for the
  account they touch (`auth:sandbox`, `auth:production`).
- The deploy axis (local Infisical vs hosted Wrangler vs CI) folds into the one
  injected `read` source; it is not a second resolver and not a credential axis,
  matching ADR-0075's "runtime is a deployment detail, not a product axis."
- Error messages point at the qualified name and the injection path, so a
  missing key is self-describing instead of surfacing as a provider-side
  redirect error three calls later.
- `.env.example` lists every canonical qualified name grouped by provider and
  environment, and is generated from the specs so it cannot drift from the
  resolver. It becomes the operator-facing documentation of the sandbox/dev/prod
  axis, with empty values and a "set only the environments you run" note. This is
  the same file for a contributor, a self-hoster, and the hosted deploy; only the
  subset each fills in differs.
- The convention assumes a small, closed set of provider environments (two or
  three). A provider with per-tenant or unbounded credentials would fall outside
  it and need a runtime lookup table; that is the named boundary, not a
  requirement to build the table now.
- Cost: one shared helper plus a one-line `spec` per provider, and a token-tag
  assertion each app must add. `local-books` and `local-mail` both qualify now
  (two environments each); `local-mail` also gains a persisted per-account
  environment and its first `infisical`-wrapped scripts.

## Considered alternatives

- **Per-app manifest mapping each (target, role) to an explicit variable name.**
  More ceremony than the naming convention buys for two-role OAuth providers; the
  tiny typed `spec` already gives the resolver enough to produce good errors.
  Rejected as the primary mechanism, kept as the degenerate case of the spec.
- **Map the provider environment to an Infisical environment or folder** (read
  sandbox creds from `--env=dev`, prod from `--env=prod`). Re-couples resolution
  to Infisical, so it cannot work on a hosted Worker whose secrets are a flat
  binding set, and it keeps names unqualified and therefore still ambiguous.
  Rejected.
- **Probe the provider to detect the credential's environment.** No cheap
  universal probe exists; the opaque redirect rejection in the incident *was* the
  probe. The token-tag assertion (rule 3) gives the loud local check without a
  network round-trip. Rejected as primary; superseded by rule 3.
- **Drop the single-environment exemption** (force qualified names even for a
  provider with one account). Kept the exemption instead, because a genuinely
  single-account provider gains nothing from an env segment. Note this is a
  narrow case: `local-mail` now uses one BYO Google OAuth Desktop client
  (`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`), so it falls under this exemption.
  `local-books` remains a two-environment provider and keeps qualified names.

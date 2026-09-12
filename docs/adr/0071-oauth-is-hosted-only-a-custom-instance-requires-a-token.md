# 0071. OAuth is hosted-only; a custom instance requires a token

- **Status:** Accepted
- **Implementation amendment (2026-09-07):** [ADR-0354](0354-hosted-applications-authenticate-with-better-auth-session-bearers.md) replaces Epicenter's hosted OAuth-provider/grant layer with direct Better Auth session bearers. Better Auth still performs social-provider OAuth. The hosted-only login boundary and self-hosted static-token decision remain; the three-client split below is historical.
- **Date:** 2026-06-25
- **Amended by:** [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) at the delivery mechanism, replacing the persisted destination setting with deployment configuration; [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) at the hosted-only sign-in restriction, introducing named-user self-hosted sessions without selecting a provider.
- **Relates:** [ADR-0070](0070-self-host-adds-no-new-ownership-or-auth-mode.md) (self-host's credential source is the first-boot bearer; this sharpens it at the client), [ADR-0069](0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) (the star is the deployment; the instance setting picks which star), [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) (the bearer is attached only to the origin that signed in), [ADR-0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md) (auth owns `/api/session`), [ADR-0092](0092-identity-is-the-partition.md) (custom instance tokens resolve the `instance` principal).

## Context

A prebuilt browser/desktop client picks which Epicenter star to talk to through a persisted instance setting (`{ baseURL, token? }`). The first cut let a no-token instance run OAuth against whatever base URL was set, so a self-hoster could point the client at their own origin and complete the hosted OAuth flow there. That made OAuth a per-instance flow: every app derived the OAuth issuer, resource, and redirect from the instance base URL and shipped a launcher-by-base-URL factory. It also contradicted ADR-0070, which already decided that self-host's credential source is a single-user bearer token printed at first boot, not a Google OAuth app registered against your own box (the "wart" ADR-0070 was written to remove). The forcing question: is OAuth a per-instance capability, or only the hosted star's?

## Decision

OAuth is the hosted star's, only. The prebuilt clients run the Google OAuth flow against the hosted Epicenter origin and nowhere else. A self-hosted instance authenticates with the static bearer token its box minted, so a non-hosted base URL requires a token. The persisted instance is therefore a clean two-state value: the hosted default carries no token, and any override carries both a base URL and a token.

The OAuth launcher is built once from each app's hosted constants (issuer, resource, redirect URI), never from the instance base URL. The single client-side choke point `createAppAuthClient(instance, options)` recomputes the credential model from the instance at construction, mirroring `createMachineAuthClient` on the node side: a `token` selects the instance-token client, its absence selects the hosted OAuth client. There is no persisted credential-mode tag.

## Consequences

- **The per-instance OAuth machinery is deleted.** No app derives an OAuth issuer, resource, or redirect from the instance base URL; the launcher-by-base-URL factory is gone. Every app builds one hosted-constant launcher and passes the persisted instance plus that launcher to `createAppAuthClient`. The hand-repeated `instance.token ? createInstanceTokenAuth(...) : createOAuthAppAuth(...)` ternary collapses into that one resolver across fuji, opensidian, vocab, honeycrisp, and the tab-manager extension.
- **The client now matches ADR-0070.** Self-host's credential is the first-boot bearer the box prints; the operator pastes it into the instance setting. The instance settings modal requires the token (its old "leave the token blank to sign in with OAuth against this origin" affordance is removed), and a hand-edited custom URL with no token reads as the hosted default rather than a wedged half-configuration.
- **The three credential clients stay distinct runtime objects** (OAuth PKCE with refresh, static instance token, same-origin cookie). Only the OAuth-vs-token choice is unified, behind the resolver, recomputed from the instance; this is not a discriminated persisted union.
- **What this forecloses:** running per-instance OAuth (Google or any OIDC) from a prebuilt client against a self-hosted origin. A self-hoster who wants browser sign-in without a pasted token uses ADR-0070's escape hatches (a reverse-proxy header or an IdP behind their own deployment), not a per-instance OAuth issuer baked into the shipped client.

## Considered alternatives

- **Keep per-instance OAuth (OAuth against the self-hosted origin).** Rejected: it requires the self-hoster to register a Google OAuth app for their own box, the exact cloud dependency ADR-0070 names a wart, and it forces every prebuilt client to derive issuer/resource/redirect from the instance and ship a launcher factory. The 10 percent of self-hosters who would run full Google OAuth on their own box do not justify that permanent second OAuth shape in every client.
- **A persisted credential-mode discriminator (`kind: 'oauth' | 'token'`).** Rejected as fake symmetry: the credential model is a function of whether a token is present, recomputed at construction, not a stored tag. A persisted mode would let the tag and the token disagree.

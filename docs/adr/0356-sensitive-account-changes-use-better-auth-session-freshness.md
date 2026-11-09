# 0356. Sensitive account changes use Better Auth session freshness

- **Status:** Proposed
- **Date:** 2026-09-07
- **Unbuilt:** the freshness gate on the authorization server's own account pages with its session cookie alone, which replaces the bearer-and-cookie gate built for client session bearers ([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)).

## Context

Epicenter needs Google/GitHub sign-in, optional passkeys, and multiple linked
providers. Requiring a passkey during signup would make ordinary onboarding
depend on another credential. Freezing the original provider would remove the
ability to link accounts that the product needs.

The direct-session replacement initially required proof of the person's last
authentication, independent of a new Epicenter session. That is a stronger
promise than the current implementation makes. In installed Better Auth
1.6.23, successful social sign-in creates a new session. Its freshness
middleware checks `session.createdAt`. An existing provider SSO session can
complete that sign-in without another password or biometric interaction.
[Better Auth documents freshness as session age](https://better-auth.com/docs/concepts/session-management#session-freshness).

Before this replacement, the login-change hook extended the default session-age
check to linking and passkey deletion, and account deletion repeated its
24-hour threshold. Neither mechanism established fresh human interaction.
The replacement uses one 600-second policy without making that stronger claim.

An additional proof would require email confirmation for people without
passkeys, provider-specific authentication-age verification, or a mandatory
initial credential. Those mechanisms would become another product workflow,
including delivery failures, enrollment, and recovery.

Under [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)
no app, CLI, agent, or third-party client holds a session. They hold access
tokens that no account-management route accepts. The authorization server's
session cookie, `HttpOnly` and host-only on `api.epicenter.so`, works only on
its own pages: sign-in, consent, device approval, and account management.

## Decision

**A Better Auth sign-in completed within ten minutes authorizes sensitive account changes for that principal.**

Set `session.freshAge` to 600 seconds in the shared auth configuration. The
same value governs Epicenter's additional login-change guards and account
deletion. A session must also be active in the server database. Age exactly
equal to the limit is stale. The ten-minute window shortens the former
24-hour opportunity for a stolen fresh session, at the cost of signing in
again when returning to account settings.

"Sign-in" means a completed Better Auth social or passkey authentication.
Google/GitHub may accept their existing SSO session. Epicenter accepts that
decision without requiring evidence of a new password, biometric, or email
challenge. Merely visiting the hosted sign-in page with an existing Epicenter
cookie does not count as another sign-in.

| Operation | Required session behavior |
| --- | --- |
| Explicitly add or remove a provider; register or delete a passkey | Check live session freshness and the initiating principal before authorizing the mutation or ceremony |
| Delete the account | Check live session freshness and the invoking Account's principal before starting deletion |
| Approve an OAuth grant or a device code with the session | Changes nothing about the session's freshness; the grant's tokens never reach account management |
| Renew the session | Extend expiry without changing `createdAt` |
| Complete another actual sign-in | Establish a new freshness timestamp, including when the provider uses SSO |

Freshness is separate from remembered-login duration. A session can keep
reading and syncing data after its account-management window ends.

**Every account-management operation stays bound to the principal that initiated it.**

Account management runs on the authorization server's pages with its session
cookie. Each request carries the expected principal captured when the page
loaded, and the server compares it with the live session principal before
authorizing a side effect, so a sign-in as another person in another tab
cannot retarget the operation. The expected principal is an identity check,
not a secret or an additional factor. Missing or mismatched identity fails.
Protected callback state retains the original operation's principal.

Implicit same-email linking during social sign-in is a separate entry path,
not an account-settings request. Better Auth may link the incoming provider
before creating the session, without an existing captured Account. Preserve
the current provider-ownership, trusted-provider, and verified-email policy
for that path. Do not impose an existing-session requirement that would break
ordinary sign-in. Test implicit linking separately from explicit management.

Revoked-session checks bypass the cookie cache. Database failure remains a server failure.

Social linking is authorized at initiation and completes within Better Auth's
bounded provider-state lifetime. Sign-out does not promise to undo an operation
already authorized on the server. A late callback cannot select a successor
Account or redirect the operation to a different principal. Passkey challenge
ownership and the library's verification-time guards remain enforced.

**Passkeys stay optional and provider linking remains available.**

Preserve provider ownership, verified-email, account-linking, WebAuthn, CSRF,
and origin checks. Do not add email codes, mandatory enrollment, recovery
credentials, or a separate verified-human-authentication timestamp for this
replacement. Optional passkeys do not raise the minimum assurance of every
other sign-in method.

**Personal-device use is a trust assumption, not a server-enforced invariant.**

Epicenter expects people to control their device and operating-system account.
Browser SPAs and the dashboard require no installation, and the server cannot
prove device ownership. Client registration approves applications, not the
devices or people running them. This assumption never bypasses authentication,
callback checks, or account isolation.

## Consequences

Ordinary sign-in remains sufficient for signup and account recovery through an
existing provider. Adding the first passkey uses the same recent-session rule
as adding another provider. There is no special initial-enrollment phase.

The accepted exposure is the session cookie itself. A stolen fresh cookie can
authorize sensitive changes remotely, including linking an attacker-controlled
provider, registering a passkey, or deleting the account. A stolen access
token, refresh token, or device code cannot: no account-management route
accepts one, and a device grant creates no session.

An attacker holding only a stale session cannot regain freshness by renewal
or client-session issuance. Someone also controlling the provider's browser
session may complete another sign-in. Ten minutes limits the first exposure;
it does not bound the second. Additional provider links create additional
ways to regain account access. Stronger reauthentication would reduce these
risks; [OWASP recommends it for sensitive features](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features).

The freshness decision avoids additional proof machinery. The gate checks the
live session, expected principal, expiry, and age before sensitive handlers.

Revisit this policy if stronger account-change assurance, shared/public-device
use, or protection against fresh-session theft becomes a product requirement.
Do not add dormant proof hooks in advance of that decision.

## Implementation and verification

The gate built for client session bearers uses Better Auth's public session
API with the explicit bearer when one was supplied, otherwise the hosted
cookie, with refresh and cookie caching disabled, and requires the expected
principal and an age strictly below 600 seconds. Real-route tests cover stale,
fresh, boundary-age, mixed-credential, wrong-principal, and
infrastructure-failure requests; implicit same-email linking is tested
separately. Under ADR-0549 the bearer branch and the mixed-credential cases go,
and the cookie branch remains. Live provider SSO and physical authenticators
remain untested. Account deletion still lacks a store-authority erasure step.

## Considered alternatives

- Require a passkey during signup. Adds mandatory enrollment and creates a
  recovery problem when all passkeys are lost.
- Allow passkey enrollment only at signup. Needs a protected initial-binding
  phase and leaves people who skip it without a universal additional factor.
- Freeze the original social provider. Removes linking capability the product
  needs and leaves account deletion's stronger proof requirement unresolved.
- Confirm sensitive actions by email or existing passkey. Preserves the
  features, but adds delivery, challenge, and recovery workflows. Choose it
  if stronger assurance becomes worth those costs.
- Verify provider authentication-age claims. Requires provider-specific
  facilities and an answer for providers without equivalent evidence.
- Give client sessions weaker account-management authority through session
  provenance. [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) removes sessions from clients instead.
- Disable freshness or reset it at grant approval. Lets an old credential authorize
  new login methods indefinitely and defeats the remaining session-age guard.

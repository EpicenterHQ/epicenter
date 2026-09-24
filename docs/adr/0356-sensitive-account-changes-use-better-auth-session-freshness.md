# 0356. Sensitive account changes use Better Auth session freshness

- **Status:** Proposed
- **Date:** 2026-09-07
- **Implementation:** Shared freshness, principal binding, and independent issuance are implemented locally. Verification and limits are recorded below; proposal status is unchanged.

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
including delivery failures, enrollment, and recovery. They are not needed to
replace the application's OAuth grants with session bearers.

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
| Issue an independent app session from a hosted session | Preserve the source `createdAt`; a new row does not reset freshness |
| Renew a session through resource traffic | Extend expiry without changing `createdAt` |
| Complete another actual sign-in | Establish a new freshness timestamp, including when the provider uses SSO |

Freshness is separate from remembered-login duration. A session can keep
reading and syncing data after its account-management window ends.

**Every account-management operation stays bound to the principal that initiated it.**

An operation through `Account.fetch` uses its captured session bearer, with no
ambient-cookie fallback. Hosted provider/passkey ceremonies may retain browser
cookies. Those requests carry the expected principal captured from the
initiating Account, and the server compares it with the live session principal
before authorizing a side effect. The expected principal is an identity check,
not a secret or an additional factor. Missing or mismatched identity fails.
Protected callback state retains the original operation's principal.

Implicit same-email linking during social sign-in is a separate entry path,
not an account-settings request. Better Auth may link the incoming provider
before creating the session, without an existing captured Account. Preserve
the current provider-ownership, trusted-provider, and verified-email policy
for that path. Do not impose an existing-session requirement that would break
ordinary sign-in. Test implicit linking separately from explicit management.

Establish the credential and principal before reading a session in freshness
hooks. Better Auth's global before-hook runs before its bearer-plugin hook;
caching a cookie session there can select the wrong principal. Revoked-session
checks bypass the cookie cache. Database failure remains a server failure.

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
prove device ownership. Origin allowlisting approves applications, not the
devices or people running them. This assumption never bypasses authentication,
callback checks, or account isolation.

## Consequences

Ordinary sign-in remains sufficient for signup and account recovery through an
existing provider. Adding the first passkey uses the same recent-session rule
as adding another provider. There is no special initial-enrollment phase.

The accepted exposure extends beyond an unlocked personal device. A stolen
fresh client-session bearer can authorize sensitive changes remotely, including
linking an attacker-controlled provider, registering a passkey, or deleting
the account. In Better Auth 1.6.23 the signed session bearer also works as the
session-cookie value. Rejecting Authorization headers or calling a route
"cookie-only" does not isolate it from someone holding that credential.
Origin checks constrain browsers; a native attacker can construct headers.

An attacker holding only a stale session cannot regain freshness by renewal
or client-session issuance. Someone also controlling the provider's browser
session may complete another sign-in. Ten minutes limits the first exposure;
it does not bound the second. Additional provider links create additional
ways to regain account access. Stronger reauthentication would reduce these
risks; [OWASP recommends it for sensitive features](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features).

The freshness decision avoids additional proof machinery. The implementation
checks live sessions, expected principal, expiry, and age before sensitive
handlers. The separate OAuth-provider replacement deletes grants, refresh
rotation, registrations, discovery, and the cookie-dashboard resource client.
It retains the protected handoff, independent revocation, captured Account
lifetimes, and a server-enforced socket authorization bound.

Revisit this policy if stronger account-change assurance, shared/public-device
use, or protection against fresh-session theft becomes a product requirement.
Untrusted or permission-limited applications would also require reconsidering
the full-access session credential. Do not add dormant proof hooks in advance
of that decision.

## Implementation and verification

The global before-hook uses Better Auth's public session API with only the
explicit bearer when one was supplied, otherwise the hosted cookie. It disables
refresh and cookie caching for the gate, then requires the expected principal
and an age strictly below 600 seconds. Invalid bearers cannot fall back to a
valid unrelated cookie. Database failure returns a server failure, not an
invalid-credential verdict.

Real-route tests cover stale, fresh, boundary-age, mixed-credential,
wrong-principal, and infrastructure-failure requests. Provider-link callbacks
retain the authorized initiating principal; implicit same-email linking is
tested separately. The Chromium dashboard smoke registers and renames a
virtual passkey for the captured principal despite another person's hosted
cookie. Its narrow browser cookie adapter preserves challenge/state cookies
without using them to select the Account.

Handoff and resource-renewal tests preserve `createdAt`. Passive hosted
continuation cannot manufacture freshness; explicit reauthentication requests
a new social or passkey sign-in. Live provider SSO and physical authenticators
remain untested. See [ADR-0354](0354-hosted-applications-authenticate-with-better-auth-session-bearers.md)
for the implementation evidence, native smoke limits, and the pre-existing
account-deletion erasure gap. No stronger human-presence assurance is claimed.

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
- Give client sessions weaker account-management authority. Introduces session
  provenance or capability distinctions. Cookie transport alone cannot enforce
  that distinction; it would be a separate credential-policy decision.
- Disable freshness or reset it at handoff. Lets an old credential authorize
  new login methods indefinitely and defeats the remaining session-age guard.

# 0383. Self-hosted sign-in defaults to passkeys with optional passwords

- **Status:** Proposed
- **Date:** 2026-09-09
- **Unbuilt:** Self-hosted named-user admission, passkey enrollment, recovery, and optional password setup/reset.

## Context

Self-hosted Personal and Shared libraries need stable named users. A credential
change must preserve the user's identity and Personal library. The operator
needs a usable first-sign-in and recovery path without a mandatory external
identity provider or email service.

## Decision

Use passkeys by default. The operator admits a stable user and privately delivers
a short-lived, single-use enrollment link. Redeeming that link authorizes passkey
registration for that user. Public registration does not confer admission.

If a user loses access, the operator verifies the person and issues recovery for
the same user. Recovery invalidates lost credentials, existing sessions, and
outstanding enrollment/recovery grants before replacement access becomes usable.
It preserves the principal and library ownership. Recovery never creates a new
Personal library or restores a removed user's admission implicitly.

Operators may enable passwords as an additional sign-in method. Passwords are
disabled by default. Enablement requires working setup, change, and reset flows,
including a configured delivery or operator-assisted recovery path. Passwords
and passkeys attach to the same user; selecting another method does not create
another account. Build passkey enrollment and recovery before the password option.

Both Worker and Bun deployments implement this policy through shared server
behavior and runtime adapters. The operator controls admission and whether
passwords are available; this decision does not introduce arbitrary combinations
of identity providers or authentication policies.

## Consequences

The default deployment needs no email service, but its operator takes
responsibility for private enrollment delivery and verifying recovery requests.
Durable admission must gate session issuance and resource access regardless of
the credential used. Removing a user also disables outstanding enrollment and
recovery grants. Revoking sessions alone does not remove admission.

This is our product choice. Better Auth documents configurable
[passkey registration](https://better-auth.com/docs/plugins/passkey) and
[email/password authentication](https://better-auth.com/docs/authentication/email-password);
it does not prescribe this default or supply our operator admission policy.
The implementation must prove that enrollment authorization is consumed once and
cannot enroll a credential for a different user. The existing Cloud schema's
required email is not a reason to fabricate addresses for passkey users.

The [execution plan](../../specs/20260909T004225-library-ownership-execution.md)
tracks Worker-first verification, subsequent Bun adapters, and access-removal
bounds. This decision selects neither the auth database nor an operator UI.

## Considered alternatives

- Require passwords for every installation: makes password setup and recovery
  mandatory even when passkeys satisfy the deployment.
- Support only passkeys permanently: removes the operator's requested password
  option without evidence that every deployment can use passkeys exclusively.
- Require an external identity provider: adds infrastructure to the default
  installation before a deployment needs it.
- Recover by creating another user: strands Personal data under the old principal.
- Give each sign-in method its own user: splits ownership when credentials change.

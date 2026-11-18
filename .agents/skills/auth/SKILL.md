---
name: auth
description: 'Epicenter account package: `@epicenter/account`, the dashboard''s cookie-session auth client that Svelte reads through `reactive`, the Account lifetime, account-bound fetch, and hosted resource authorization. Use when editing Epicenter auth clients, session state, hosted sign-in, or how a route boots from auth.'
metadata:
  author: epicenter
  version: '12.0'
---

# Epicenter auth

Better Auth is the deployment's OAuth 2.1 authorization server (ADR-0549).
A hosted resource accepts only an opaque access token for its audience: the
API at its own origin (the folders audience has no routes). A self-hosted server is `apps/api` on Bun
with Postgres and issues the same tokens. Whispering has no sign-in
(ADR-0894); the account dashboard is the one client in this repository.

Read `packages/account/README.md` and `packages/account/src/auth-contract.ts`
before changing client API shape. The README owns the explanation; the
contract owns the signatures. Do not restate either here or in code comments.

## Ground external behavior

When correctness depends on Better Auth sessions, cookies, plugins, freshness,
or provider linking, ask DeepWiki a narrow question against
`better-auth/better-auth`, then verify decisive details against the installed
source, types, tests, or official docs. Online examples may target another
version.

Global before-hooks run before plugin before-hooks. A management gate cannot
assume bearer normalization has happened: use the public session API with
explicit headers and test a real header-only request. Distinguish a rejected
credential from a database failure; a transient fault must not retire good
identity.

## Client composition

The account dashboard's client is `createCookieSessionAuth` in
`apps/api/ui`, over the authorization server's own session cookie. Never
restore a server destination from saved preferences. An auth client has the
shape every capability has (ADR-0769): it reads `state()`, its actions
answer promises, and `subscribe` hears a change. The dashboard adapts it
once with its own `reactive` (`apps/api/ui/src/lib/reactive.ts`), and
`auth.state()` tracks in a template, `$derived` or effect.

## Account lifetime

An application session keeps one person and one server for its entire
lifetime. Preserve these guarantees:

- Token renewal and same-person reauthentication keep the same Account
  object. A browser navigation creates a new runtime.
- Sign-out or account replacement permanently retires the old Account. Later
  sign-in creates a new Account even for the same principal.
- Retirement aborts HTTP requests and response streams. Pending work checks
  the captured Account after each await.
- An Account refuses foreign origins before attaching credentials and does
  not follow redirects. `account.fetch` uses `credentials: 'omit'`.
- Retry and inference work uses the captured Account, never a new read of
  mutable auth state.

`startSignIn({ reauthenticate: true })` asks for a completed sign-in without
signing out first, so the Account survives.

The [dashboard layout](../../../apps/api/ui/src/routes/dashboard/+layout.svelte) reads `const signIn = $derived(auth.state())`. Once it has checked the account against the link, `{#key signIn.account}` gives `DashboardSession` the lifetime of that Account. Replacing the account remounts the session and its account-bound services.

## Hosted resources and sessions

Hosted resource routes take only an opaque OAuth access token for their
audience and scope: `requireAccessToken` runs `authorizeAccountRequest`, and
a namespace route runs `authorizeResourceRequest`. A Better Auth session
never reaches a resource. The profile is Better Auth's
`/auth/oauth2/userinfo`. Unknown, expired, or revoked tokens are 401;
database and infrastructure failures are retryable 503.

Better Auth sessions back only the authorization server's own pages
(`packages/server/src/auth/session-policy.ts`): a 30-day sliding expiry
updated after one day of use, and sensitive changes such as
`/auth/link-social` need a session younger than `freshAge` (600 seconds) for
the page's named account. Renewal does not reset authentication age.
Ordinary social sign-in may create fresh permission; do not describe it as
human-presence verification. Test provider-link callback binding and
implicit same-email linking separately; they have different policy gates.

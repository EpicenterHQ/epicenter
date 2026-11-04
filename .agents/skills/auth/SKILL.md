---
name: auth
description: 'Epicenter account package: `@epicenter/account` and the Svelte adapter at `@epicenter/account/svelte`, OAuth sign-in for browser and desktop apps, the Account lifetime, account-bound fetch, and hosted resource authorization. Use when editing Epicenter auth clients, session state, hosted sign-in, or how a route boots from auth.'
metadata:
  author: epicenter
  version: '11.0'
---

# Epicenter auth

Better Auth is the deployment's OAuth 2.1 authorization server (ADR-0549).
Every app is an OAuth client of it, and a hosted resource accepts only an
opaque access token for its audience. A self-hosted server is `apps/api` on
Bun with Postgres and issues the same tokens.

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

| Program | Client |
| --- | --- |
| A browser app | `createBrowserOAuth` from `@epicenter/account`, with one build-configured `AuthServer` |
| A standalone desktop app | `createTauriAuth()` from `@epicenter/account/tauri`, over the `epicenter-account` crate |
| The Epicenter app | the `epicenter` CLI's desktop grant (`epicenter auth login --desktop`); no page holds a token |
| The account dashboard | `createCookieSessionAuth` in `apps/api/ui`, over the authorization server's own session cookie |

Never restore a server destination from saved preferences. The Svelte
adapter `fromAuth` makes state reads track through `trackReads` from
`@epicenter/svelte/tracked`, the helper under every capability's adapter.
The app's auth module exports the facade for components and the plain
client for a capability that takes the live account (`hosted(account)` from
`@epicenter/ai`), which reads `getState()` and `subscribe` itself.
Retain the callback-capable type where a callback route needs it
(`isCallbackAuthClient`).

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

`startSignIn` begins a flow and `completeSignIn` consumes a callback; do not
make one verb infer the other from a query string. The callback route leaves
with `location.replace(returnTo)` and opens no store.
`startSignIn({ reauthenticate: true })` asks for a completed sign-in without
signing out first, so the Account survives.

An online root captures the Account once and opens its store over it, keyed
on the Account (`{#key auth.state.account}`), so a new Account opens a new
store.
Imports and preloads acquire no resources.

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

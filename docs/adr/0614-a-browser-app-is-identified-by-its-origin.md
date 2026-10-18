# 0614. A browser app is identified by its origin

- **Status:** Proposed
- **Date:** 2026-10-18
- **Amends:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "a grant has no target": a browser grant targets exactly one namespace; [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) at the client ID metadata document and the `cimd` plugin: a browser app's client id is its origin, and its first sign-in creates its client row; CORS chosen by route stands.
- **Relates:** [0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (the correctness blockers and build order), [0612](0612-a-namespace-is-one-git-repository-shared-by-its-members.md) (what a grant targets).
- **Unbuilt:** all of it: client rows created at first sign-in; (account, origin, namespace) grants with `referenceId = ns:<id>`; consent that lists namespaces and takes a suggested name; tokens keyed by grant; renewal pinned to a namespace; revocation retiring tokens; and Reconnect.

## Context

Every OAuth client is a row `buildFirstPartyClients` in
`apps/api/worker/oauth-registrations.ts` writes, and first-party browser
clients get the grant target `*`. A third-party browser app was to sign in
with a client ID metadata document on its origin
([ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md)).
A grant names no namespace
([ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md)).
Consent stages its choice under `consentKey(session.id, clientId)` in
`packages/server/src/auth/grant-target.ts`, and the browser stores one token
per client and server under `tokenKey` in
`packages/auth/src/browser-oauth.ts`, where silent renewal
(`prompt: 'none'`) accepts whatever grant comes back. With many apps sharing
one namespace ([0612](0612-a-namespace-is-one-git-repository-shared-by-its-members.md)),
each sign-in has to say which namespace an app reaches.

## Decision

**An app is its origin, and its origin is its OAuth `client_id`; no developer
registers anything.** The first sign-in from an origin creates its client row:
a public client, PKCE `S256`, the fixed callback `${origin}/auth/callback`,
matched exactly on origin, a `localhost` port included. CORS is chosen by
route, as [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md)
states it. Withdrawn before it was built: client ID metadata documents and the
`cimd` plugin.

**A grant is (account, origin, namespace).** It carries fixed operation scopes
and names the namespace as its target, `referenceId = ns:<id>`, never as an
OAuth scope. A browser never gets `*`, no browser client has `skipConsent`,
one grant exists per tuple, and revoking a grant retires its tokens. Cost: a
site that works in two namespaces holds two grants.

**Consent picks one namespace.** An app may pass an optional `namespace:`
suggestion. Exactly one match is preselected; none offers to create one, and
creating is idempotent; several matches, or an ambiguous suggestion, make the
person choose. The choice is bound to the server's authorization transaction,
and membership is checked again when it is used.

```txt
https://kanban.alice.dev wants to read and change everything in one namespace.
It suggests: studio

  ( ) Braden                     owner
  (•) studio                     member     the only namespace named "studio": preselected
  ( ) Create a namespace named "studio"

                                         [Cancel]  [Allow]
```

**A browser token belongs to its grant.** The browser keys it by
(server, account, origin, namespace), and renewal is pinned to the same
namespace and refuses any other. When a token expires, local editing
continues and the app offers Reconnect without navigating the page.

## Consequences

- An origin becomes a client the first time someone signs in from it, so the
  client table grows by one row per origin, every `localhost` port included.
- Two tabs of one site on two namespaces hold two tokens and never overwrite
  each other.
- A token reaches its whole namespace, so which tables an app touches is
  etiquette, not permission.

## Considered alternatives

- **Client ID metadata documents (ADR-0606).** Each app then hosts a JSON
  document restating what its origin already says.
- **The namespace as an OAuth scope.** Scopes are fixed per operation, and a
  namespace chosen at consent is a target, which `referenceId` carries.
- **`*` grants for first-party apps.** One compromised first-party origin then
  reaches every namespace the account holds.

# 0614. A browser app is identified by its origin

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amended by:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at repository consent as a condition of local app use: consent connects existing local data and never selects it by name alone. [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) at grants for non-Git services: inference authorization needs no repository target and grants no repository access.
- **Amends:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "a grant has no target, and a token reaches its person's own namespace": a grant names one repository; [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) at the client ID metadata document, the `cimd` plugin, "A redirect URI is accepted only when the document lists it", and "Epicenter's first-party browser apps keep their rows in `BROWSER_APPS`": every browser app's client id is its origin, and nothing is registered or hosted; CORS chosen by route stands.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (a first-party app is an ordinary client), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (what a grant names).
- **Unbuilt:** all of it: a client row created at an origin's first sign-in; (account, origin, repository) grants; sign-in returning to the page that called it; `connect()` navigating to consent; consent preselecting a suggested name or offering to create a repository by it; a refresh token per grant that renews without leaving the page; the account grant `epicenter login` holds; and native app identity.

## Context

Every OAuth client is a row that `buildFirstPartyClients` in
`apps/api/worker/oauth-registrations.ts` writes, with the fixed redirect
`${origin}/auth/callback`, and first-party browser clients get the grant
target `*`. A third-party browser app was to sign in with a client ID
metadata document on its origin
([ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md)),
and a grant names no repository
([ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md)).
With several apps and several people sharing one repository
([ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md)),
each consent has to say which repository an app reaches, and a first-party
app is an ordinary client
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).

## Decision

**A web app is identified by its web origin, which is its OAuth `client_id`; no
developer registers anything.** The first sign-in from an origin creates its
client row: a public client using PKCE `S256`. First-party apps get no row
of their own. Withdrawn before it was built: client ID metadata documents
and the `cimd` plugin. Deleted: the rows `buildFirstPartyClients` writes for
browser apps.

**Sign-in returns to the page that called it.** There is no fixed callback
path: the redirect is the calling page's URL, accepted when it is on the
client's origin.

**A repository grant records consent for an account, web origin, and hosted repository.**
It names one repository by id, never `*`. One repository grant exists per
tuple. Inference authorization is independent under ADR-0634. Local data
opens without either grant under ADR-0633. Access tokens stay stored rows
checked on every request
([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)),
so revoking a grant retires its tokens at once. A refresh token per grant
renews access without leaving the page. Cost: a site that works in two
repositories holds two grants.

**A signed-in device holds an account grant.** `epicenter login` gives the
CLI a grant that reaches every repository the person is on. The deferred
Epicenter desktop app reaches Git through the CLI's credential helper
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).
Only browser apps hold per-repository grants.

**`connect()` navigates the page to consent and back.** An app may suggest
a repository name; at consent the one repository of that name on the
person's list is preselected, and otherwise the person chooses. Consent
also offers to create a repository with the suggested name, which the
person who creates it owns
([ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md)).

```txt
https://kanban.alice.dev wants to read and change everything in one repository.
It suggests: studio

  ( ) Braden                  owner
  (•) studio                  member     the only repository named "studio": preselected
  ( ) Create a repository named "studio"

                                         [Cancel]  [Allow]
```

**Native app identity is deferred to Whispering's desktop app.** A native
app would claim its website's origin; how Epicenter verifies that claim is
not decided. The Epicenter desktop app is no OAuth client: it reaches the
Git service through the CLI's credential helper
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).

## Consequences

- The client table grows by one row per web origin, each `localhost` port
  included.
- Two tabs of one site on two repositories hold two grants and two tokens,
  and neither overwrites the other.
- A token reaches its whole repository, so which tables an app touches is
  etiquette, not permission.
- A signed-in device reaches every repository its person is on, and
  `epicenter repos` lists them all; a browser app reaches only the
  repositories it holds grants for.
- A first-party app's consent screen is the one an outside site gets.

## Considered alternatives

- **Client ID metadata documents
  ([ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md)).**
  Each app hosts a JSON document restating what its origin already says.
- **A fixed callback path, `${origin}/auth/callback`.** Every app then
  routes a path Epicenter chose and sends the person back to where they
  were itself.
- **The repository as an OAuth scope.** Scopes are fixed per operation; a
  repository chosen at consent is a target.
- **`*` grants for first-party apps.** One compromised first-party origin
  then reaches every repository the account is on.

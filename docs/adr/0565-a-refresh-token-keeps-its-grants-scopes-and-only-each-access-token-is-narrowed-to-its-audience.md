# 0565. A refresh token keeps its grant's scopes, and only each access token is narrowed to its audience

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at "A refresh family is one grant's lineage", which named reuse detection and revocation but not what a refresh stores or what revoking a live refresh token ends: a refresh token keeps the grant's scopes, revoking a live one ends its lineage, and a row without a lineage answers 500; at the `so.epicenter.cli` row, whose grant includes `openid`; and at "Its issuer and resources are its own origin", which is `<origin>`, `<origin>/git`, and `<origin>/mcp`, resolved by `resolveOAuthAudiences`.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at "`epicenter auth login` sets `credential.https://git.epicenter.so.helper=!epicenter auth git-credential`": the key is `credential.<the deployment's Git audience>.helper`, its value is `!'<absolute path to the CLI>' auth git-credential`, and an empty value is written before it.
- **Relates:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) (the Git audience a folder syncs to), [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) (the deployment names the authority).
- **Unbuilt:** sending `patches/@better-auth%2Foauth-provider@1.7.9.patch` upstream; `epicenter auth status` reporting a grant as signed in after its sign-in has ended (a refresh answered `invalid_grant` twice) until `epicenter auth logout`; a development build's auth lock files, which land in the release data directory because Rust does not pass `EPICENTER_DATA_DIR` to the auth commands.

## Context

ADR-0549 gives each first-party grant every audience its client may reach:
`api`, `git`, and `mcp`. The `epicenter` CLI asks for all of them at sign-in
and names one `resource` on each refresh, so the server can narrow that access
token to the audience's `allowedScopes`. Git's token gets `folders:read` and
`folders:write`; the API's gets `ai`, `profile`, and `folders:read`.

`@better-auth/oauth-provider` 1.7.9 computes the narrowed scopes once and
stores them on both tokens. The first refresh for `git.epicenter.so` therefore
writes a refresh token holding only the folder scopes, and the next refresh for
the API cannot get `ai` back. One Git fetch would end a grant's inference for
good: the refresh succeeds, and the next AI request answers 403
`insufficient_scope`.

The same library, on revocation of a live refresh token, deletes only the
access tokens that row issued. Access tokens issued under earlier rotations of
the same grant stay valid for up to eight hours. ADR-0549 keyed reuse detection
and revocation on lineage but did not say what an explicit revocation reaches.

The build also settled details ADR-0549 and ADR-0558 left open or named
loosely: the status code for a refresh row without a lineage, whether the CLI
client may ask for `openid`, the exact Git configuration `auth login` writes,
and the audiences of a deployment that is not the hosted one.

## Decision

**A refresh token keeps its grant's full scopes, and only each access token is
narrowed to the audience its request names.** RFC 8707 restricts the access
token to its resource; the grant is not a resource. The vendored patch
`patches/@better-auth%2Foauth-provider@1.7.9.patch`, listed in the root
`package.json` `patchedDependencies`, passes the grant's scopes, not the
intersected ones, to `createRefreshToken`. One grant serves every audience it
was approved for, in any order of refreshes.

## Consequences

- **Revoking a live refresh token ends its whole lineage** (RFC 7009 section
  2.1). The patch makes `revokeRefreshToken` call `invalidateRefreshFamily`
  with the row's `authorizationCodeId`, which deletes every refresh row in
  that lineage and every access token they issued, including those from
  earlier rotations. Other grants of the same client and person are untouched.
- **A refresh row with no lineage is a server error.** `invalidateRefreshFamily`
  answers 500 `server_error` ("refresh token has no grant lineage") and
  revokes nothing. It never falls back to the `(clientId, userId)` family,
  which would sign the person out of every installation of that client.
- **`so.epicenter.cli` includes `openid`.** Its registration in
  `apps/api/worker/oauth-registrations.ts` lists `openid` beside
  `offline_access`, `profile`, `ai`, `folders:read`, and `folders:write`, and
  the CLI asks for it, so `epicenter auth status` names the account from
  `/auth/oauth2/userinfo`.
- **`epicenter auth login` writes Git's helper as two global entries.**
  `configureGitHelper` in `packages/cli/src/auth.ts` runs:

  ```txt
  git config --global --replace-all credential.<git audience>.helper ''
  git config --global --add         credential.<git audience>.helper "!'<absolute path to the CLI>' auth git-credential"
  ```

  The empty value resets the helper list Git has built so far for that URL,
  so a broader helper such as the system `osxkeychain` is never asked to
  `store` the token. This relies on Git resetting its helper list at an empty
  value, which covers helpers configured earlier (the system file); a helper
  the person adds later in their global file is still asked. The absolute path is the compiled binary's own path, or
  `bun` and the entry when run from source, so the helper never depends on
  `PATH`. This replaces ADR-0558's `!epicenter auth git-credential`.
- **Audiences come from one function.** `resolveOAuthAudiences` in
  `@epicenter/constants/apps` maps a deployment's API origin to its three
  audiences. The API seeds and checks them, and the CLI requests and presents
  them:

  | Deployment | `api` | `git` | `mcp` |
  | --- | --- | --- | --- |
  | Hosted (`https://api.epicenter.so`) | `https://api.epicenter.so` | `https://git.epicenter.so` | `https://mcp.epicenter.so/mcp` |
  | Any other origin (local, self-host) | `<origin>` | `<origin>/git` | `<origin>/mcp` |

- The patch carries the refresh scopes and the lineage revocation beside
  ADR-0549's lineage keying, and all of it is re-verified on every Better Auth
  upgrade until upstream takes it.

## Considered alternatives

- **A refresh for every audience at once, with no `resource`.** The access
  token would carry every scope and every audience, so a Git token could call
  inference; audience binding would bind nothing.
- **One grant per audience.** Three device approvals for one sign-in, and three
  refresh tokens to keep and rotate.
- **Re-requesting the lost scopes with `scope` on refresh.** OAuth lets a
  refresh only narrow, never widen, and ADR-0549 already refuses narrowing
  `scope` on refresh because it narrows the stored grant.
- **Revoking only the presented refresh row's access tokens, as the library
  does.** A revoked grant keeps working for up to eight hours through access
  tokens from earlier rotations.
- **A plain `credential.<git audience>.helper` entry with no reset.** Git calls
  `store` on every helper in its list after a successful request, so the token
  would be copied into whatever broader helper the machine configures.
- **The audiences written out in each caller.** A token the CLI requests for
  one string and the API checks against another answers 401 with no other
  symptom.

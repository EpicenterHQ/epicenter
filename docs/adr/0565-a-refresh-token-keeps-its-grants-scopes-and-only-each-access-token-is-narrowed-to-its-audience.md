# 0565. A refresh token keeps its grant's scopes, and only each access token is narrowed to its audience

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at "A refresh family is one grant's lineage": a refresh family is every grant of one client for one person, a replay after 60 seconds ends all of them, and the desktop and the CLI are separate families; the vendored patch and "A refresh row without a lineage is an error" are withdrawn; at the consequences "No other installation is affected", which becomes "every installation of that client signs in again", and "The patch is re-verified on every Better Auth upgrade", which is withdrawn; at the resource table, where `api` and `git` accept every first-party scope and only `mcp` limits scopes; at the Unbuilt item "sending the lineage patch upstream", which is withdrawn; at the `so.epicenter.cli` row, whose grant includes `openid`; and at "Its issuer and resources are its own origin", which is `<origin>`, `<origin>/git`, and `<origin>/mcp`, resolved by `resolveOAuthAudiences`.
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at "`epicenter auth login` sets `credential.https://git.epicenter.so.helper=!epicenter auth git-credential`": the key is `credential.<the deployment's Git audience>.helper`, its value is `!'<absolute path to the CLI>' auth git-credential`, and an empty value is written before it; at "When the CLI spawns `git`, it passes the helper on that one command", which is refused: every `git` the CLI starts gets the CLI's own access token as a header, minted in the CLI's process, and the helper serves only the person's own `git`, written only by `epicenter auth login`; and at the hidden `--loopback`, which is withdrawn: `epicenter auth login --desktop` is the desktop app's loopback sign-in, so `--desktop` is the one flag that selects the desktop grant.
- **Amended by:** [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at "only `mcp` limits scopes" and the `mcp` column of the audience table: a deployment has two audiences, `api` and `git`, and both allow every scope.
- **Amended by:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "approves the code with the chosen target": the consent page approves a device code with no choice of folders.
- **Amended by:** [ADR-0618](0618-epicenter-hosts-no-ai-service.md) at `ai` in its scope lists and audience table: no `ai` scope exists.
- **Relates:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) (the Git audience a folder syncs to), [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) (the deployment names the authority), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) (a window's children end with the window).
- **Unbuilt:** moving from Better Auth `1.8.0-beta.0` to 1.8 stable before the first deploy; `epicenter auth status` reporting a grant as signed in after its sign-in has ended (a refresh answered `invalid_grant` twice) until `epicenter auth logout`.

## Context

ADR-0549 gives each first-party grant every audience its client may reach,
`api` and `git`. The `epicenter` CLI asks for both at sign-in and names one
`resource` on each refresh, so each access token is bound to one audience.

`@better-auth/oauth-provider` intersects a refresh's scopes with the named
resource's `allowedScopes`, and stores the result on the new refresh token
as well as the access token. ADR-0549's resource table gave the API `ai`,
`profile`, and `folders:read`, and Git `folders:read` and `folders:write`.
The first refresh for Git therefore wrote a refresh token holding only the
folder scopes, and the next refresh for the API could not get `ai` back. One
Git fetch ended a grant's inference for good.

ADR-0549 also keyed the refresh family on grant lineage, so one replay would
end one installation. The library keys it on `(clientId, userId)`, and
neither behavior has an option. Epicenter carried both changes, and a third
that ended a whole lineage on revocation, as a Bun patch of the library's
content-hashed `dist` chunks.

Better Auth 1.8 (better-auth#11610) approves a device code through the
provider's own consent flow and copies the consent's `referenceId` onto the
device grant's tokens. Until then, a device grant's target came from a hook
that found the device's tokens through the patch's `device:<id>` lineage, so
the patch could not be dropped on 1.7.

## Decision

**Every first-party resource allows the same scopes, so a refresh never
narrows the grant, and each access token stays bound to its audience.** The
`api` and `git` resources allow every scope Epicenter grants (`openid`,
`offline_access`, `profile`, `email`, `ai`, `folders:read`, `folders:write`); the
intersection a refresh computes is then the grant itself. The audience, not
the scope list, keeps a Git token out of inference: the resource query checks
`t.resources ? $2` before `t.scopes ? $3`. `mcp` keeps `folders:read` and
`folders:write`, plus `openid` and `offline_access`, as the ceiling for
third-party clients, whose only audience it is. A first-party client's
registration is its only scope ceiling.

Epicenter runs Better Auth unpatched, pinned exactly in the root catalog,
and fits its own behavior to the library's:

| ADR-0549 said | Now |
| --- | --- |
| A refresh family is one grant's lineage | A refresh family is every grant of one client for one person. A replay inside 60 seconds gets the cached answer; a later replay ends every grant of that client for that person, with every access token they issued. `so.epicenter` (the desktop) and `so.epicenter.cli` (terminals and agents) are separate families. |
| A refresh row without a lineage is an error | Withdrawn; there is no lineage. |
| A device grant's tokens receive the target from the approval | The device page sends a code to `/auth/oauth2/authorize?user_code=<code>`. The provider signs the person in and shows the consent page, whose answer approves the code with the chosen target, which the provider copies onto every token of the grant. |
| `api` allows `ai`, `profile`, `folders:read`; `git` allows `folders:read`, `folders:write` | Both allow every first-party scope. `GET /.well-known/oauth-protected-resource` still lists the scopes each audience's routes check. |

## Consequences

- **`epicenter auth logout` revokes the refresh token and every cached
  access token.** Revoking a live refresh token ends only the access tokens
  of its latest rotation, and the cached `api` and `git` tokens usually come
  from different rotations, so `logout` names each one to `/oauth2/revoke`.
- **Access tokens discarded at rotation expire within eight hours.** Only
  a thief holds one. A replay ends them early; nothing else does until an
  account page can end one client's grants by `(clientId, userId)`.
- **A replay after 60 seconds signs every installation of that client out.**
  Every terminal and agent of `so.epicenter.cli`, or every Mac of
  `so.epicenter`, asks for a new sign-in, and a headless agent waits for a
  person to approve a new device code. The legitimate paths to a replay:
  - the process exits after the server rotates the token and before the
    keychain write lands;
  - both sends of one refresh lose their answer;
  - the keychain write fails after a rotation;
  - a cloned keychain (Migration Assistant, a restore) gives two machines
    one refresh token;
  - `epicenter auth logout` revokes a refresh token already rotated, which
    the library also treats as a replay.
- **The CLI and the shell narrow the first path.** The CLI finishes a
  refresh it has sent before it exits: a stop signal waits for the keychain
  write, at most two seconds (`STOP_GRACE_MS` in
  `packages/cli/src/stop.ts`, the CLI's one stop handler, which a history
  command shares). The shell stops a CLI child with SIGTERM to its process
  group and kills it only after three seconds (`STOP_GRACE` in
  `apps/epicenter/src-tauri/src/cli.rs`), both when a window's page ends
  (ADR-0559's rule stands: a window's children end with the window) and when
  a run is dropped or its listener stops. A history command still kills its
  own `git` children at once, which is why no refresh runs under one of
  them: the CLI mints the token for every `git` it starts in its own
  process, and hands it to that `git` as a header (`hostedCredentials` in
  `packages/cli/src/repository-commands.ts`).
- **A Git token lists `ai` and `profile`, and an API token lists
  `folders:write`.** Both are inert at their audience: inference requires the
  `api` audience, and no API route checks `folders:write`. Least privilege
  inside one audience is what this record gives up.
- **The device grant needs Better Auth 1.8.** Its `deviceCode` table gains
  `reference_id`, `auth_time`, `acr`, and `amr`; `oauth_client` gains
  `sector_identifier` and the front-channel logout columns; and
  `oauth_refresh_token` gains `acr` and `amr` (migration
  `0005_better_auth_1_8`). `registerFirstPartyClients` writes each
  first-party resource with every first-party scope, on every deployment.
- **The profile is Better Auth's userinfo.** `getProfile` in every client
  reads `/auth/oauth2/userinfo`, which answers `sub` for any token with
  `openid` and the email only with `email`; `/api/session` is deleted.
  Browser builds may ask for `email`, and Vocab, which shows it, does.
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
  the person adds later in their global file is still asked. The absolute
  path is the command link `~/.local/bin/epicenter` (ADR-0566, ADR-0567),
  the same path when the CLI runs from source, so the helper never depends
  on `PATH`, survives moving the app, and never names a checkout. Only
  `auth login` writes it; `sync --to` and `clone` do not. This replaces
  ADR-0558's `!epicenter auth git-credential`.
- **`--desktop` is the one flag for the desktop grant.** Rust runs every
  command with it, and `epicenter auth login --desktop` is the desktop app's
  loopback sign-in as `so.epicenter`, which Settings runs. ADR-0558's hidden
  `--loopback` meant the same grant and is gone; `auth login` without
  `--desktop` is the device grant.
- **Audiences come from one function.** `resolveOAuthAudiences` in
  `@epicenter/constants/apps` maps a deployment's API origin to its three
  audiences. The API seeds and checks them, and the CLI requests and presents
  them:

  | Deployment | `api` | `git` | `mcp` |
  | --- | --- | --- | --- |
  | Hosted (`https://api.epicenter.so`) | `https://api.epicenter.so` | `https://git.epicenter.so` | `https://mcp.epicenter.so/mcp` |
  | Any other origin (local, self-host) | `<origin>` | `<origin>/git` | `<origin>/mcp` |

## Considered alternatives

- **The vendored patch of `@better-auth/oauth-provider`.** It keyed the
  refresh family on grant lineage (`device:<id>` for a device grant), ended a
  whole lineage when a live refresh token was revoked, and kept a refresh
  token's scopes whole while each access token was narrowed. It kept
  ADR-0549's guarantee that one replay ends one installation, and its scope
  hunk follows RFC 6749 section 6. Its cost: it edited content-hashed `dist`
  chunks, so every Better Auth release, 1.7.10 included, failed `bun install`
  until the patch was rewritten; 1.8's device rework meant rewriting its
  device hunk; and its family deletion kept the fail-open order of
  better-auth#11704 (delete without first marking revoked). Fitting
  Epicenter to the library deleted it, and the device half of
  `grant-target.ts` with it.
- **A refresh for every audience at once, with no `resource`.** The access
  token would carry every scope and every audience, so a Git token could call
  inference; audience binding would bind nothing.
- **One audience for every first-party resource.** A Git or MCP token would
  then be accepted at inference and Git alike, scope would be the only
  separation, and the MCP rule that a server accepts no token issued for
  another resource would break. Uniform scope lists already stop the
  narrowing.
- **One grant per audience.** Two device approvals for one sign-in, and two
  refresh tokens to keep and rotate.
- **Re-requesting the lost scopes with `scope` on refresh.** OAuth lets a
  refresh only narrow, never widen, and ADR-0549 already refuses narrowing
  `scope` on refresh because it narrows the stored grant.
- **A one-hour access token, to bound tokens discarded at rotation.** The
  lifetime is per resource, and browser apps use the `api` audience, so every
  browser app would redirect every hour and lose a recording held only in
  memory, which ADR-0549 refused.
- **The helper on every `git` the CLI starts, as ADR-0558 planned
  (`-c credential.<git audience>.helper=!'<the CLI>' auth git-credential`).**
  The refresh would then run in a grandchild of `git`, inside the process
  group a history command ends at once when its page reloads, with no grace.
  A refresh cut off after the server rotated the token is a replay, which
  under this record signs out every installation of the client. Minting the
  token first, so the helper only read the cache, would keep the in-process
  refresh anyway and add a process to each transfer. The CLI keeps minting
  in-process and sending the header.
- **A plain `credential.<git audience>.helper` entry with no reset.** Git calls
  `store` on every helper in its list after a successful request, so the token
  would be copied into whatever broader helper the machine configures.
- **The audiences written out in each caller.** A token the CLI requests for
  one string and the API checks against another answers 401 with no other
  symptom.

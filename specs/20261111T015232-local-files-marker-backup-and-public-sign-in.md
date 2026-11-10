# Local secrets, the `EPICENTER.md` marker, `ui/dist`, backup status, and a public sign-in

**Date**: 2026-11-11
**Status**: In Progress
**Owner**: Braden
**Branch**: `claude/local-files-and-sign-in` (integration); waves branch from `3e6f1fca38`
**Decisions**: [ADR-0870](../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` secrets), [ADR-0868](../docs/adr/0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (marker), [ADR-0854](../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md) and [ADR-0860](../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (`ui/dist`, no `.cache/`), [ADR-0851](../docs/adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (backup status), [ADR-0871](../docs/adr/0871-a-public-address-signs-people-in-with-a-passkey-and-connectors-in-with-oauth.md) (sign-in)

## One sentence

Replace the Keychain with `.local` collections, mark an Epicenter with
`EPICENTER.md`, serve a view from `ui/dist/`, make a missing backup visible,
and let claude.ai and ChatGPT reach `epicenter serve` through a public
listener that signs people in with passkeys and connectors in with OAuth.

## Current and target

| | Before (`3e6f1fca38`) | Target |
| --- | --- | --- |
| Secrets | `secrets` in the run, `Bun.secrets` under `epicenter.<id>.<app>` | a one-file collection at `<name>.local.md`; no `secrets` |
| `.local` | never committed | also: no generated verbs, writable in a read-only run, created `0600` |
| Marker | `epicenter.root.json` `{ id, port }` | `EPICENTER.md`, front matter `port`, `public`, `publicPort` |
| UI | built into `.cache/ui/`; template ignores `.cache/` | `ui/dist/`, built or hand-written; template ignores `node_modules/`, `*.local`, `*.local.*` |
| Backup | unpushed count only when `origin/<branch>` exists | `not backed up` / `never backed up` in status, and after `epicenter new` |
| Public access | none; tailnet only, no sign-in | a second listener at `publicPort`; passkeys for people, OAuth for connectors; `epicenter access` |

## Waves and state

| Wave | Branch | Owner | State |
| --- | --- | --- | --- |
| 0a spike | none (`$TMPDIR/epicenter-spike`) | Opus | done; results below |
| 0b Better Auth 1.8.0-beta.7 | `claude/w0b-better-auth-beta7` | Codex | merged (`36dfc26720`) |
| 1 `.local` secrets and marker | `claude/w1-local-secrets-and-marker` | Codex | running |
| 2 UI build path and backup status | `claude/w2-ui-build-and-backup` | Codex | running; built to `ui/build`, renamed in wave 3 |
| 3 `ui/dist` | integration branch | Claude | after 1 and 2 merge |
| 4 sign-in | from the integration tip | Opus | after 3, review, and green tests |
| 5 live Epicenter | `~/Epicenter` | the person approves each step | last |

Before each merge: read the branch diff against its brief, search for
leftovers (`secrets`, `keychain`, `EPICENTER_TEST_SECRETS`,
`epicenter.root.json`, `.cache`), and confirm the commit exists on the branch.
After merging 1 to 3: typecheck `packages/app` and `packages/cli`, run every
test file one at a time with its own `TMPDIR`, build the three UIs, and run
`post-implementation-review` on the combined change.

## Wave 3: a view is what is in `ui/dist/` (ADR-0860)

- `packages/cli/src/ui.ts`, `http.ts`, and every caller: the served folder is
  `ui/dist/`. `serve` looks nowhere else.
- With a `build` script in `ui/package.json`, `epicenter build`, `new --from`,
  and `update` run it and keep the last `ui/dist/` that built. Without one,
  there is nothing to build: `ui/dist/` holds hand-written files.
- `apps/{capture,tasks,vocab}/ui/svelte.config.js`:
  `adapter({ pages: 'dist', assets: 'dist' })`; each `ui/.gitignore` lists
  `dist/`.
- Tests: a built UI is served; a hand-written `ui/dist/index.html` with no
  `package.json` is served; a project with a build script and no `dist/` has
  no view.

## Wave 0a results (the spike, 2026-11-11)

`$TMPDIR/epicenter-spike/example.ts` runs the whole flow in 43 printed steps
(`run.log`); `access.ts` lists and revokes from a second process;
`cimd-transport.ts` is the IPv4-first CIMD fetch. Copy what wave 4 needs; the
temp folder is not kept.

- **Database.** `new Database(path)` from `bun:sqlite` works as `database`.
  `getMigrations(auth.options).runMigrations()` from `better-auth/db/migration`
  creates all tables at start and is a no-op the second time. Set
  `PRAGMA journal_mode=WAL` and a `busy_timeout`; the CLI opens the same file.
- **Discovery.** The issuer is `<publicOrigin>/.auth`. `auth.handler` answers
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server/.auth` (path insertion, which the MCP
  SDK fetches). The bare root `/.well-known/oauth-authorization-server` needs
  `oauthProviderAuthServerMetadata(auth)` from `@better-auth/oauth-provider`.
  Metadata has `client_id_metadata_document_supported: true` and no
  `registration_endpoint`. Set `grantTypes` to drop `client_credentials`
  (untested).
- **Scopes.** Include `offline_access`, or no refresh token is issued. The mcp
  plugin keeps it out of the protected-resource metadata. Leave
  `challengeScopes` unset: a scope in the 401 overrides `scopes_supported`.
- **Resource.** `https://host:port/` with the trailing slash; Better Auth
  matches it exactly, and old SDKs add the slash.
- **Token checks.** Use `createMcpProtectedRequestHandler({ audience: resource,
  jwksUrl })`, not `requireMcpAuth`, whose default audience is `baseURL`
  (`…/.auth`) and which fetches the JWKS from the public URL. Pass a memoized
  `() => auth.api.getJwks()` (needs a cast; the type says `string`) or
  `http://127.0.0.1:<publicPort>/.auth/jwks`.
- **Sign-in continuation.** After a session is created, POST to the sign-in
  endpoint with `{ oauth_query }` in the JSON body; it returns
  `{ redirect: true, url: '/.allow?…' }`. The passkey `verify-authentication`
  endpoint ends the same way (inferred).
- **Consent narrowing works.** `scope: 'read offline_access'` on consent issues
  a narrower code; an unrequested scope is 400. `/oauth2/public-client` gives
  `client_name` and `client_uri` for `/.allow`.
- **Tokens.** `expires_in: 900`, EdDSA JWTs with `aud` = resource and `azp` =
  the CIMD URL; access tokens are not stored. Refresh rotates. Asking for
  `write` after a `read` approval returns to `/.allow`.
- **Revocation.** The refresh grant never checks consent, and a rotated token
  replays for 30 seconds. Revoke deletes the consent and the client's
  refresh-token rows in one transaction.
- **Passkey.** Endpoints under `/.auth/passkey/`. Invite flow:
  `registration: { requireSession: false, resolveUser, afterVerification }`;
  `generate-register-options?context=<invite>` resolves the invite from the
  `verification` table, `afterVerification` deletes it, and
  `verify-registration` with `createSession: true` signs the person in.
  Verified to the options (200 with the invite, 401 without); the WebAuthn
  ceremony itself was not run.
- **Pages.** Better Auth accepts JSON POSTs with a trusted `Origin` only, so
  `/.sign-in` and `/.allow` use a little script (WebAuthn needs it anyway).
- **Cookies.** `Secure` and `__Secure-` follow the https `baseURL`; requests at
  `http://127.0.0.1` with the https `Origin` work unchanged. DPoP checks
  `request.url`, so rewrite it to the public origin before the MCP handler.
- **Users.** Email is required and unique: use `<id>@epicenter.invalid`.
  `createUser` takes a provisioning source as a second argument.
- **Secret.** Persist `secret` in `access.local.key`.
- **CIMD fetch under Bun.** Upstream `@better-auth/cimd/node` connects to the
  first DNS answer; Bun lists IPv6 first, so claude.ai fails without IPv6.
  `cimd-transport.ts` keeps the checks (public addresses only, certificate
  checked against the name) and tries IPv4 first. Claude's and Claude Code's
  documents validate under `mcp-2026-07-28`. ChatGPT's CIMD URL is unknown.
- **MCP SDK.** `packages/cli` has `@modelcontextprotocol/sdk` 1.29.0 (latest
  protocol `2025-11-25`). `@modelcontextprotocol/server` 2.x is on npm; the
  2.3.1 client adds `offline_access` itself. Moving is optional.
- **Not verified:** what claude.ai's and ChatGPT's clients send; `disabledPaths`;
  rate limiting behind a tunnel (every request is from `127.0.0.1`).

## Wave 4: the public sign-in (ADR-0871)

- `packages/cli/package.json`: `better-auth`, `@better-auth/mcp`,
  `@better-auth/cimd`, `@better-auth/passkey` from the catalog.
- `packages/cli/src/access.ts` (or a better name found while building): the
  `betterAuth` setup in ADR-0871, migrations on start, WAL, the secret, the
  invite (`verification` row, 15 minutes, one use), and the CIMD fetch.
- `packages/cli/src/http.ts`: a second `Bun.serve` on `publicPort` when
  `public` is set, with the ADR-0871 path table. `POST /` takes a bearer token
  through `createMcpProtectedRequestHandler`, or a session with the public
  origin as `Origin`. With only `read`, `tools/list` shows `readOnlyHint`
  actions and other calls throw `createInsufficientScopeError(['write'])`.
  The private listener is unchanged.
- `/.sign-in` and `/.allow`: server-rendered HTML with a small inline script
  and no framework.
- `epicenter access`, `access invite`, `access revoke <name>`; add `access` to
  `COMMANDS`.
- Tests, no network and no tunnel:
  - the path table: each path with no credential, a session, a token;
  - the OAuth flow in process, with a stubbed CIMD fetch and a session created
    the way a passkey sign-in ends;
  - a `read` token cannot call or list a write action;
  - a revoke ends refresh; the invite works once and expires;
  - a cookie-authenticated `POST /` with a foreign `Origin` is refused;
  - the private listener needs nothing.
- Docs: `packages/cli/README.md` (serve, access), the `epicenter-app` skill
  (connecting Claude and ChatGPT).

## Wave 5: the live Epicenter

The person runs these, or approves each.

1. `~/Epicenter`: write `EPICENTER.md` (`port: 4747`,
   `public: https://studio.tail0f84e1.ts.net:10000/`, `publicPort: 4757`),
   delete `epicenter.root.json`.
2. Remove `.gitattributes` from `~/Epicenter/tasks` and `~/Epicenter/vocab`
   (no binaries; ADR-0856); replace each app's `.gitignore`; copy each `ui/`
   source in and build to `ui/dist/`; snapshot; push.
3. Restart `serve` from the final commit. `epicenter access invite`, open the
   link, register a passkey.
4. `tailscale funnel --bg --https=10000 http://127.0.0.1:4757`. That publishes
   an address, so it needs the person's go.
5. Connect claude.ai and ChatGPT. Record in ADR-0871 what each client sent and
   whether ChatGPT completed CIMD.

## Done when

- A mail-style secret is a `.local.md` collection read in a read-only action
  that refreshes its token. No `secrets`, `Bun.secrets`, or `keychain` remains
  outside `docs/`.
- `epicenter` in a folder with only `EPICENTER.md` works; the old marker is
  refused with its step.
- A view is served from `ui/dist/`, built or hand-written; no `.cache` remains.
- An app with no `origin` says `not backed up` in the listing and after
  `epicenter new`.
- Claude and ChatGPT each list and call actions at the public address; a `read`
  approval cannot write; `epicenter access revoke` stops a connector within 15
  minutes; the UIs open at the public address after a passkey.
- Each wave passed review; the adversarial security review of wave 4 closed.
  Decisions that changed in the work are edited into their records. This spec
  is deleted.

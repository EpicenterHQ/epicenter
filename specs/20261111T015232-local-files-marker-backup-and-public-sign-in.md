# Local secrets, the `EPICENTER.md` marker, `ui/dist`, backup status, and a public sign-in

**Date**: 2026-11-11
**Status**: In Progress
**Owner**: Braden
**Branch**: `claude/compose`, which composes `claude/local-files-and-sign-in` onto `claude/collections` (`a267bcee02`)
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

| Wave | State on `claude/compose` |
| --- | --- |
| 0a spike | done; results below |
| 0b Better Auth 1.8.0-beta.7 | built (`chore(auth): update Better Auth to 1.8.0-beta.7`) |
| 1 `.local` secrets and marker | built on `claude/collections`, whose `isLocalPath`, `{ folder }` context, and `EPICENTER.md` are kept; the sign-in line's own wave 1 is dropped. `public` and `publicPort` are added to its marker check |
| 2 backup status | built (`feat(cli): an app says when it is not backed up, or never has been`) |
| 3 `ui/dist` | built (`feat(cli)!: a view is what is in ui/dist`) |
| 4 sign-in | built (`feat(cli): a public address signs people in with a passkey and connectors in with OAuth`), on `claude/collections`' run model: the child commits under the app's lock, and `serve`'s 5-minute clock backs up |
| 5 live Epicenter | migrated and serving from `claude/compose` (2026-11-11); Funnel, the passkey, and the connectors wait on the person |

After composing: typecheck `packages/app` and `packages/cli`, run every test
file one at a time with its own `TMPDIR`, build the four UIs, and run
`post-implementation-review` on the combined change.

## Wave 3: a view is what is in `ui/dist/` (ADR-0860)

- `packages/cli/src/ui.ts`, `http.ts`, and every caller: the served folder is
  `ui/dist/`. `serve` looks nowhere else.
- With a `build` script in `ui/package.json`, `epicenter build`, `new --from`,
  and `update` run it and keep the last `ui/dist/` that built. Without one,
  there is nothing to build: `ui/dist/` holds hand-written files.
- `apps/{capture,tasks,vocab,reading}/ui/svelte.config.js`:
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

Built. ADR-0871 describes the result. Code: `packages/cli/src/`
`authorization-server.ts` (Better Auth, the generation tables and triggers,
`listAccess`, `revokeAccess`), `public.ts` (the router), `sign-in-pages.ts`,
`access.ts`, `http.ts` (both listeners and the public address check). Tests:
`public.test.ts` and `acceptance.public.test.ts`, which hold the review's
attacks as regressions (silent re-authorization, revoke across an in-flight
code exchange or rotation, tunnel headers, Host rebinding, the self-check).

The adversarial review (two Codex seats, one Opus seat) changed the first build:
grants are per (connector, person); a revoke ends a grant at once through
generation triggers; every authorization needs a passkey and `/.allow`; the
private listener allowlists `Host`, refuses tunnel headers, and is checked from
`public`; revoke is routed and introspection unadvertised; CIMD text is
cleaned. Its accepted risks are listed in ADR-0871.

Unverified until Wave 5: WebAuthn in a real browser, what claude.ai and
ChatGPT send, and the headers Funnel and Cloudflare add.

## Wave 5: the live Epicenter

Done on 2026-11-11, with the person's go:

1. `~/Epicenter/EPICENTER.md` holds `port: 4747`,
   `public: https://studio.tail0f84e1.ts.net:10000`, `publicPort: 4757`. The
   old JSON marker was already gone.
2. Capture, Tasks, and Vocab each have the repository's `epicenter.ts`, the
   template `.gitignore`, and a prebuilt `ui/dist/`, committed. No `.cache/`
   remains. Each was committed with `epicenter sync <app> -m` and pushed to its
   `origin`.
   - A `ui/` source cannot build outside the monorepo until `@epicenter/app`
     and `@epicenter/ui` are published, so each app keeps the view without a
     build script, as ADR-0860 allows.
   - Each keeps its LFS `.gitattributes`, since each view has an `icon.png`
     (ADR-0856).
   - When the packages publish, each app becomes a starter and builds its own
     view.
3. `serve` runs from a detached worktree pinned at the composed commit, with
   `~/Epicenter` as its folder. Checked: the private listener serves the
   launcher, the views, and MCP, on `127.0.0.1` and on the tailnet at `:4747`.
   It refuses a Funnel header or a foreign Host with 403. The public listener
   redirects to `/.sign-in`, answers MCP without a token with 401, and serves
   the metadata for `https://studio.tail0f84e1.ts.net:10000/`.

Left for the person:

4. `tailscale funnel --bg --https=10000 http://127.0.0.1:4757` publishes the
   address. `serve` sees it on its next 5-minute check.
5. `epicenter access invite`, then open the link and register a passkey within
   15 minutes.
6. Connect claude.ai and ChatGPT. Record in ADR-0871 what each client sent,
   whether ChatGPT completed CIMD, and whether Funnel sets
   `Tailscale-Funnel-Request` and `X-Forwarded-For`.

## Done when

- A mail-style secret is a `.local.md` collection read in a read-only action
  that refreshes its token. No `secrets`, `Bun.secrets`, or `keychain` remains
  outside `docs/`.
- `epicenter` in a folder with only `EPICENTER.md` works; a folder without
  it is refused, naming `epicenter init <folder>`.
- A view is served from `ui/dist/`, built or hand-written; no `.cache` remains.
- An app with no `origin` says `not backed up` in the listing and after
  `epicenter new`.
- Claude and ChatGPT each list and call actions at the public address; a `read`
  approval cannot write; `epicenter access revoke` stops a connector on its next
  call; the UIs open at the public address after a passkey.
- Each wave passed review; the adversarial security review of wave 4 closed.
  Decisions that changed in the work are edited into their records. This spec
  is deleted.

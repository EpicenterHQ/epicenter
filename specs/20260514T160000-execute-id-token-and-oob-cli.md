# Execute: id_token + OOB CLI (composed)

**Date**: 2026-05-14
**Type**: Execution prompt for a coding agent
**Status**: **Retracted (2026-05-14)**

## Retraction

Do not execute this prompt.

The id_token spec it drives (`specs/20260514T154500-id-token-bearing-encryption-keys.md`) is retracted. See that file's `## Retraction` section for rationale. The OOB CLI half of this composition lives entirely in `specs/20260514T120000-machine-auth-oob-clean-break.md` and is executed standalone (no id_token coupling, no `decodeIdTokenClaims`, no `customIdTokenClaims` hook). The wave diagram and shared-schema framing below conflated two concerns that no longer compose.

If you arrived here looking for execution guidance, read the OOB CLI spec's `## Implementation Plan` instead. Phase 1 (server callback page + constants + trusted-client projection) is already landed in the working tree; Phases 2-6 (file-backed session store, OOB launcher, `machine-auth.ts` rewrite, daemon smoke, docs) are still open.

**Original execution prompt preserved below as a historical record.**

---

**(retracted) Original drives:**
- `specs/20260514T154500-id-token-bearing-encryption-keys.md` (id_token spec, retracted)
- `specs/20260514T120000-machine-auth-oob-clean-break.md` (OOB CLI spec, decoupled from id_token)

This document is the marching order for an executing agent. Read it end-to-end before touching code. Do not skim. The composition has subtle ordering rules; getting them wrong means re-doing waves.

## What you are doing

Two specs landed at the same time and compose into one architecture change:

1. The api server gains a `customIdTokenClaims` hook on its OAuth provider, so every id_token issued from `/auth/oauth2/token` carries the user's email and `workspace_encryption_keys` claim.
2. Every client (browser apps, browser extension, CLI/daemons) stops calling `/workspace-identity` and instead decodes the id_token at read time for identity.
3. The CLI replaces its broken device-code flow with an OOB authorization-code paste flow against the same `/oauth2/token` endpoint the browser uses.
4. All three storage cells (browser localStorage, extension chrome.storage, CLI `~/.epicenter/auth.json`) persist the same arktype: `OAuthTokenGrant = { accessToken, refreshToken, idToken, accessTokenExpiresAt }`.

The cohesion sentence both specs serve:

> One token bundle, four fields. Identity is a function of the id_token. Browser, extension, and CLI persist the same shape. There is no `/workspace-identity` route, no second storage adapter, no pre-decoded identity cache.

If a step you are about to take violates that sentence, stop.

## Required reading (in order, before any code change)

1. `specs/20260514T154500-id-token-bearing-encryption-keys.md` end-to-end. Pay close attention to:
   - `## Pass 2 status (read me first)`
   - `## Composition with the OOB CLI spec` (the wave diagram)
   - `## Verification targets (Pass 2)` (V1-V6 with file:line proof)
   - `## Decisions log`
2. `specs/20260514T120000-machine-auth-oob-clean-break.md` end-to-end. Pay close attention to:
   - `## Desired State` (the four-field on-disk shape)
   - `## Architecture` (CLI Login Flow + File Layout + Daemon Auth Composition)
   - `## Implementation Plan` Phases 1-6
3. `apps/api/src/auth/create-auth.ts` (current `betterAuth()` config; you will add `customIdTokenClaims` here)
4. `apps/api/src/app.ts` lines 160-260 (current `/workspace-identity` route + Hono setup)
5. `apps/api/src/auth/resource-boundary.ts` (`resolveBearerIdentity` becomes orphan in Wave 4)
6. `packages/auth/src/auth-types.ts` (`OAuthTokenGrant`, `OAuthSession`, `WorkspaceIdentity`)
7. `packages/auth/src/auth-contract.ts` (`AuthState`, `AuthClient`)
8. `packages/auth/src/create-oauth-app-auth.ts` (the `loadIdentity` call + `replaceSession` guard you are deleting)
9. `packages/auth/src/auth-state-store.ts` (state diff machinery)
10. `packages/auth/src/node/machine-auth.ts` (the entire CLI auth surface you are rewriting)
11. `packages/auth/src/node/machine-session-store.ts` (the Bun.secrets backend you are deleting)
12. `packages/encryption/src/keys.ts` (`EncryptionKey` / `EncryptionKeys` arktype reused inside `IdTokenClaims`)
13. `node_modules/@better-auth/oauth-provider/dist/index.mjs` lines 284-315 and 403-447 (real signature of `customIdTokenClaims`; do not invent a `ctx` parameter)

When you finish reading, before any edit, post one short message to the human stating:
- which spec phases you are about to run in this wave
- any ambiguity you hit while reading
- your proposed first commit's title

Wait for "go" or a redirect.

## Load-bearing rules (do not violate)

Read these once and keep them in working memory through every wave.

### Schema discipline
- The persisted shape is exactly four fields: `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`. Flat. No nesting under `tokens`. No `version`. No `auth_mode`. No `users` map. No `last_refresh`. No `user`. No `email`. No `encryptionKeys`.
- `OAuthSession` (the old `{ tokens, identity }` bundle) is deleted in Wave 2. Anywhere you see it after Wave 2, that is a bug.
- The arktype `OAuthTokenGrant` is the single validator. Browser localStorage, extension chrome.storage, and `~/.epicenter/auth.json` all validate against it.
- `WorkspaceIdentity` survives as a derived value type produced by `decodeIdTokenClaims`; it is never persisted as a peer field anywhere.

### Identity discipline
- Identity is computed via `decodeIdTokenClaims(grant.idToken)` on every read. Never cache it on disk. Never cache it in module scope. In-memory caching inside one `createOAuthAppAuth` instance is fine because the instance recomputes when tokens change.
- `auth.state.identity` keeps its current shape (`{ user: { id, email }, encryptionKeys }`); only its provenance changes (id_token decode instead of `/workspace-identity` fetch).

### Network discipline
- After Wave 2 ships, no client code may issue `GET /workspace-identity`. Grep for it after every wave; the count must monotonically decrease.
- After Wave 4, `grep -rn '/workspace-identity'` in `apps/` and `packages/` must return zero matches.
- `customIdTokenClaims` fires on every `refresh_token` grant (verified at `index.mjs:418-446`), so a fresh id_token rides every refresh. Do not add a separate "refresh identity" path; that is the bug class the spec was written to kill.

### Hook signature (the easy mistake)
- `customIdTokenClaims` receives `{ user, scopes, metadata }`. It does NOT receive `ctx`. `metadata` is `parseClientMetadata(client.metadata)`, the OAuth client's metadata, not the request context.
- Cloudflare Workers env access works via closure capture: `createAuth({ env, ... })` is called per-request at `apps/api/src/app.ts:173`, so the `customIdTokenClaims` closure constructed inside `oauthProvider({ ... })` captures `env`. Do not try to reach env any other way.

### Server-side guards (load-bearing for the schema)
- Inside `customIdTokenClaims`, throw if `scopes.includes('workspaces:open') && !scopes.includes('email')`. Without this guard, a client requesting `openid workspaces:open` (no email scope) would get an id_token whose decoded claims fail `IdTokenClaims.assert` on the missing `email` field, with a confusing "decode failed" surface. Fail at issuance, not at decode.
- Add a one-line comment in `apps/api/src/auth/create-auth.ts` next to the `oauthProvider` config noting that `pairwiseSecret` must remain unset. The same-user guard `claims.sub === identity.user.id` depends on it; enabling pairwise turns `sub` into a per-client pseudonym and silently breaks the guard across OAuth clients.

### Tooling and process
- bun, not npm/yarn/pnpm/node. `bun run`, `bun test`, `bun install`, `bun x`.
- No em or en dashes anywhere: source code, comments, JSDoc, error strings, commit messages, this spec's edits. Use colon, comma, semicolon, parens, or sentence break.
- Commits are conventional: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `test(scope):`, `docs(scope):`, `spec(scope):`. One logical change per commit.
- Use the `error-handling` skill: `wellcrafted` `tryAsync`/`trySync` at I/O boundaries, Result types at module boundaries.
- Use the `define-errors` skill for any new error variants: `IdTokenInvalid`, `OobLauncherError` variants, `MachineAuthStorageError` variants.
- After each wave, invoke `adversarial-review` on the cumulative implementation and remaining plan before dependent work begins. Record consequential decisions and update remaining tasks from accepted findings. Keep the wave-specific `post-implementation-review` checks and human gates below; the independent review includes the code inspection.

### What NOT to bundle
- Do not rename `createOAuthAppAuth`. Tempting but pure churn.
- Do not rename `WorkspaceIdentity` to `IdentityClaims` (the id_token spec's Open Question 4 explicitly defers this; bundle it later).
- Do not refactor unrelated areas you encounter while editing. Note them and move on.
- Do not add UX polish to the OOB CLI flow beyond what the OOB spec lists. No `--no-browser` flag, no auto-tab-close, no fancy progress indicators.

## Preflight decisions (confirm with human before Wave 1 starts)

These three decisions are upstream of the entire plan. Get explicit answers before writing code.

1. **`/api/health` for `status` to ping.** The OOB spec's `status` function pings a cheap endpoint to verify the bearer is still good. There is no `/api/health` today. Three options:
   - (recommended) Add `app.get('/api/health', ...)` returning `200 'ok'` behind the bearer middleware. Five lines. Removes the last reason to keep `/workspace-identity` alive past Wave 4.
   - Keep `/workspace-identity` as a bearer-liveness probe past Wave 4 (contradicts the cohesion sentence).
   - Skip the network probe in `status`; trust the local id_token decode (loses "is the bearer still valid right now" signal).
2. **`pairwiseSecret` stays unset.** Confirm with human, then add a load-bearing comment in `apps/api/src/auth/create-auth.ts`.
3. **CLI scope set on the trusted client projection.** `packages/constants/src/oauth.ts` must list `email` in the CLI's scope set, alongside `openid`, `profile`, `offline_access`, `workspaces:open`. Verify and patch in Wave 1 if missing.

If any of these are still open when you start, stop and ask. Do not guess.

## Wave 1: Server side

**Goal**: ship `customIdTokenClaims` and the `/auth/cli-callback` page. Both additive. `/workspace-identity` keeps working. No client changes.

**Skills to load**: `greenfield-clean-breaks`, `encryption`, `elysia` is not relevant (the api uses Hono + Better Auth), `error-handling`, `monorepo`.

### Files to touch

```
apps/api/src/auth/create-auth.ts                      EDIT
  - add customIdTokenClaims to oauthProvider({ ... })
  - gate on scopes.includes('workspaces:open')
  - throw if email scope missing
  - inject deriveUserEncryptionKeys via the env captured by the per-request closure
  - upgrade jwt() to jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } })
  - add a comment naming pairwiseSecret as a load-bearing assumption

apps/api/src/auth-pages/cli-callback-page.tsx          NEW
apps/api/src/auth-pages/scripts/cli-callback.ts        NEW
apps/api/src/auth-pages/index.tsx                      EDIT (add renderCliCallbackPage export)
apps/api/src/app.ts                                    EDIT
  - add app.get('/auth/cli-callback', secureHeaders(), handler)
  - handler sets Cache-Control: no-store, no-transform
  - reads c.req.query('code'/'state'/'error'/'error_description')
  - returns c.html(renderCliCallbackPage({ ... }))
  - add app.get('/api/health', ...) returning 200 'ok' (preflight decision 1)

packages/constants/src/oauth.ts                        EDIT
  - epicenter-cli entry: runtime: 'native'
  - redirectUris: ['https://api.epicenter.so/auth/cli-callback']
  - scopes include 'openid', 'profile', 'email', 'offline_access', 'workspaces:open'
  - drop runtime: 'device' anywhere it appears

apps/api/src/auth/trusted-oauth-clients.ts             EDIT
  - collapse toOAuthClientType to a two-arm switch:
      browser/extension -> 'user-agent-based'
      native            -> 'native'
  - the exhaustiveness check shrinks; TypeScript flags any leftover 'device' reference
```

### Tests (Wave 1)

```
apps/api/src/__tests__/customIdTokenClaims.test.ts     NEW (or adjacent to resource-boundary.test.ts)
  - run an OAuth authorize+token flow with scopes including 'openid' and 'workspaces:open'
  - assert the response body has id_token
  - decode id_token; assert workspace_encryption_keys is present and is a valid EncryptionKeys arktype
  - assert customIdTokenClaims throws if scopes include workspaces:open but not email

apps/api/src/__tests__/cli-callback-page.test.ts       NEW
  - GET /auth/cli-callback?code=test&state=xyz returns 200, content contains literal `test` in a <code> tag
  - response headers: cache-control: no-store, no-transform; x-frame-options: DENY; x-content-type-options: nosniff
  - GET /auth/cli-callback?error=access_denied renders the error branch
  - GET /auth/cli-callback (no query) renders missing-code error

apps/api/src/__tests__/health.test.ts                  NEW
  - GET /api/health with valid bearer returns 200 'ok'
  - GET /api/health without bearer returns 401
```

### Acceptance gate (Wave 1)

```bash
bun --cwd apps/api run typecheck
bun --cwd apps/api test
bun --cwd apps/api run build
```

All green. Then a manual probe:

```bash
# in another shell, dev API running
curl -i http://localhost:8787/auth/cli-callback?code=test&state=xyz
# expect Cache-Control: no-store, no-transform and `test` in the body
```

### Commits in this wave (one per logical change)

```
feat(api): add customIdTokenClaims to oauthProvider; sign id_tokens with ES256
feat(api): /auth/cli-callback page + secureHeaders + Cache-Control: no-store, no-transform
feat(api): /api/health endpoint for bearer-liveness probes
refactor(constants,api): drop runtime: 'device' from trusted-clients projection; collapse toOAuthClientType
test(api): customIdTokenClaims, cli-callback-page, health
```

After Wave 1: run `post-implementation-review` skill on the touched files. Surface any drift to the human. Wait for "go" before Wave 2.

## Wave 2: Client schema (one PR; do not split mid-wave)

**Goal**: rewrite `OAuthTokenGrant` to include `idToken`. Delete `OAuthSession`. Make identity a derived view. Rename `machine-session-store` to `machine-tokens-store` and switch it to a file backend at `~/.epicenter/auth.json`.

This is the schema-change wave. It touches every persisted shape and must land atomically (one PR or one commit chain merged together) to avoid leaving a half-migrated state.

**Skills to load**: `refactoring`, `arktype`, `typescript`, `define-errors`, `error-handling`, `testing`, `monorepo`, `encryption`, `documentation`.

### Files to touch (id_token side)

```
packages/auth/src/auth-types.ts                        EDIT
  - OAuthTokenGrant gains idToken: 'string'
  - delete OAuthSession entirely
  - WorkspaceIdentity stays (becomes a derived value type)

packages/auth/src/decode-id-token.ts                   NEW (~25 lines + JSDoc)
  - export const IdTokenClaims = type({ '+': 'delete', sub, iss, aud, exp, iat, email,
      workspace_encryption_keys: EncryptionKeys })
  - export function decodeIdTokenClaims(idToken: string): IdTokenClaims
  - export const IdTokenError = defineErrors({ Malformed, ClaimsInvalid })

packages/auth/src/auth-contract.ts                     EDIT (no shape change, but update JSDoc)
  - AuthState.identity is preserved; document that its provenance is now id_token decode

packages/auth/src/auth-state-store.ts                  EDIT
  - identitiesEqual / encryptionKeysEqual fire on token-bundle changes
  - delete any "identity write path" notion

packages/auth/src/create-oauth-app-auth.ts             EDIT (significant rewrite)
  - rename sessionStorage -> tokensStorage (config field rename; this is a public API change)
  - delete loadIdentity entirely (no /workspace-identity fetch)
  - replaceSession's same-user guard now compares
    decodeIdTokenClaims(next.idToken).sub vs cached identity.user.id
  - state derivation: signed-out / signed-in / reauth-required, identity from idToken
  - keep refreshSession's single-flight + epoch machinery (still needed for token rotation)

packages/auth/src/auth-errors.ts                       EDIT
  - if missing, add IdTokenInvalid variant (or import from decode-id-token.ts)

packages/auth/src/index.ts                             EDIT
  - re-export decodeIdTokenClaims, IdTokenClaims, IdTokenError
  - drop OAuthSession from exports
  - keep OAuthTokenGrant, WorkspaceIdentity, AuthClient, AuthState

packages/auth/src/contract.test.ts                     EDIT
  - cover new derive-identity-from-tokens path
  - cover refresh produces new id_token, identity re-derives
  - cover signature/decode failures map to IdTokenInvalid
  - cover same-user guard catches sub mismatch
```

### Files to touch (OOB side)

```
packages/auth/src/node/machine-tokens-store.ts         NEW (renamed from machine-session-store.ts; delete the old file)
  - DEFAULT_AUTH_FILE_PATH = path.join(os.homedir(), '.epicenter', 'auth.json')
  - loadMachineTokens({ filePath?, log? }): Result<OAuthTokenGrant | null, MachineAuthStorageError>
  - saveMachineTokens(tokens, { filePath? }): Result<undefined, MachineAuthStorageError>
  - atomic write via .tmp + rename
  - mode 0o600 enforcement (refuse to load if file mode & 0o077 != 0)
  - directory created with mode 0o700 if missing
  - corrupt-blob and schema-mismatch both surface as Ok(null) + warn
  - MachineAuthStorageError = defineErrors({ StorageFailed, FilePermissionsTooOpen, ... })
  - Bun.secrets is gone; do not import it

packages/auth/src/node/machine-session-store.ts        DELETE
packages/auth/src/node/machine-session-store.test.ts   DELETE

packages/auth/src/node/machine-tokens-store.test.ts    NEW (per the OOB spec Phase 2.4)

packages/auth/src/node.ts                              EDIT
  - re-export loadMachineTokens, saveMachineTokens
  - drop loadMachineSession, saveMachineSession
```

### Acceptance gate (Wave 2)

```bash
bun --cwd packages/auth typecheck
bun --cwd packages/auth test
```

Both green. The browser apps and CLI will not run yet because their call sites use the old config field name (`sessionStorage`); that is Wave 3.

Cross-check (run after acceptance):

```bash
grep -rn 'OAuthSession' packages/ apps/ | grep -v node_modules
# expect zero matches in packages/auth/. Matches in apps/ are Wave 3 follow-ups.

grep -rn 'machine-session-store\|loadMachineSession\|saveMachineSession' packages/ apps/
# expect zero matches.

grep -rn '/workspace-identity' packages/auth/
# expect zero matches in packages/auth/. apps/api still has the route alive (Wave 4 deletes it).
```

### Commits in this wave

```
feat(auth)!: OAuthTokenGrant gains idToken; delete OAuthSession
feat(auth): decodeIdTokenClaims + IdTokenClaims arktype + IdTokenError
refactor(auth): create-oauth-app-auth uses tokensStorage; identity derived from idToken
refactor(auth): auth-state-store derives state from token-bundle changes
refactor(auth): rename machine-session-store -> machine-tokens-store; switch to file backend
test(auth): contract + decode-id-token + machine-tokens-store
```

The `!` on the first commit signals breaking change in the conventional-commits style. The breaking change is real: `OAuthTokenGrant` shape changes and `OAuthSession` is gone. Wave 3 fixes the call sites.

After Wave 2: run `post-implementation-review`. The single most important thing to check is "did any consumer of `OAuthSession` survive my edits." Use `Grep` not memory.

## Wave 3: Adoption (parallelizable by surface)

**Goal**: every consumer of `@epicenter/auth` and `@epicenter/auth-svelte` adopts the new shape. CLI gets the OOB launcher. `machine-auth.ts` is rewritten to use the new tokens-only file backend.

This wave can be split into per-surface PRs because each app/package is independent after Wave 2 lands. Land them in this order if you want a single PR chain, or run them in parallel if separate PRs:

1. `@epicenter/auth-svelte` (rename `sessionStorage` -> `tokensStorage` in any internal usage; verify exports)
2. Browser apps (each one's `app.ts` or `main.ts` that constructs the auth client)
3. Browser extension (`apps/tab-manager`)
4. OOB launcher (`packages/auth/src/node/oob-launcher.ts`)
5. `machine-auth.ts` rewrite
6. `packages/cli/src/commands/auth.ts`

**Skills to load**: `svelte` (for browser apps), `tauri` (for Tauri apps), `refactoring`, `define-errors`, `error-handling`, `testing`, `monorepo`.

### Files to touch (per-surface)

```
packages/svelte-utils/src/account-popover/account-popover.svelte    AUDIT
packages/svelte-utils/src/session.svelte.ts                          AUDIT (re-verify identity reads)
packages/svelte-utils/src/workspace-gate/workspace-gate.svelte       AUDIT

apps/whispering/src/...auth.ts                                       AUDIT/EDIT
apps/dashboard/src/...auth.ts                                        AUDIT/EDIT
apps/honeycrisp/src/...auth.ts                                       AUDIT/EDIT
apps/opensidian/src/...auth.ts                                       AUDIT/EDIT
apps/zhongwen/src/...auth.ts                                         AUDIT/EDIT
apps/fuji/src/...auth.ts                                             AUDIT/EDIT
apps/tab-manager/...auth.ts                                          AUDIT/EDIT (chrome.storage backend; localStorage-key 'local:auth.tokens')

  In each: rename `sessionStorage` -> `tokensStorage`; verify the persisted shape is OAuthTokenGrant.
  None of the apps should call /workspace-identity.

packages/auth/src/node/oob-launcher.ts                               NEW (per OOB spec Phase 3.1-3.3)
  - createOobOAuthLauncher({ ... }): OAuthSignInLauncher
  - PKCE: code_verifier from crypto.getRandomValues, code_challenge = base64url(sha256)
  - state from crypto.getRandomValues
  - print URL; openBrowser best-effort
  - readCode from stdin
  - POST /auth/oauth2/token with grant_type=authorization_code
  - validate response shape; return Ok(OAuthTokenGrant { ... idToken ... })
  - OobLauncherError = defineErrors({ TokenExchangeFailed, InvalidTokenResponse, AuthorizationCancelled })

packages/auth/src/node/oob-launcher.test.ts                          NEW

packages/auth/src/node/machine-auth.ts                               REPLACE (per OOB spec Phase 4.1)
  - loginWithOob({ ... }) returns Result<{ identity: WorkspaceIdentity }, ...>
  - status({ ... }) loads tokens, decodes id_token locally, pings /api/health for bearer liveness
  - logout({ ... }) calls auth.signOut() (revokes refresh token, clears file)
  - createMachineAuthClient({ ... }) loads file, builds createOAuthAppAuth with no-op launcher
  - delete: DeviceTokenError, MachineAuthClient type alias, pollForAccessToken, fetchOAuthSession,
    readRecord/readString/readPositiveNumber, the deviceAuthorizationClient import, the entire
    rawDefaultAuthClient module-level setup

packages/auth/src/node.ts                                            EDIT
  - export loginWithOob, status, logout, createMachineAuthClient
  - drop loginWithDeviceCode (no deprecation alias; clean break)
  - drop DeviceTokenError

packages/auth/src/node/machine-auth.test.ts                          REPLACE (per OOB spec Phase 4.5)

packages/cli/src/commands/auth.ts                                    EDIT
  - call loginWithOob instead of loginWithDeviceCode
  - report sessionSummary from the returned identity
```

### Acceptance gate (Wave 3)

```bash
# typecheck and tests at every layer
bun --cwd packages/auth typecheck
bun --cwd packages/auth test
bun --cwd packages/svelte-utils typecheck
bun --cwd packages/cli typecheck
bun --cwd packages/cli test

# each browser app builds
for app in whispering dashboard honeycrisp opensidian zhongwen fuji tab-manager; do
  bun --cwd apps/$app run typecheck
  bun --cwd apps/$app run build
done
```

Then manual smokes (do all three):

```
1. Browser smoke (one app, e.g. dashboard):
   - rm localStorage entry for the auth cell in devtools
   - sign in: completes; identity renders
   - force a 401 (block /api/* in network panel briefly): state goes reauth-required
   - sign out: storage cell cleared

2. CLI smoke (laptop):
   - rm -f ~/.epicenter/auth.json
   - epicenter auth login
     -> URL prints, browser opens (best-effort), /auth/cli-callback renders code
     -> paste code into terminal
     -> "Signed in as <email>"
   - stat -f "%Lp" ~/.epicenter/auth.json (mac) or stat -c '%a' (linux)
     -> 600
   - epicenter auth status -> "Signed in (verified)"
   - epicenter auth logout -> file gone, /auth/oauth2/revoke called

3. Headless smoke (SSH to a server, no DISPLAY):
   - epicenter auth login on the server
   - copy printed URL to your laptop browser
   - paste the displayed code back into the SSH session
   - login succeeds; ~/.epicenter/auth.json on the server holds the bundle
```

### Cross-checks (run after Wave 3 acceptance)

```bash
grep -rn '/workspace-identity' packages/ apps/
# Expect: only matches inside apps/api (the route is still alive). Zero matches in any client code.

grep -rn 'OAuthSession\|loadMachineSession\|saveMachineSession' packages/ apps/
# Expect: zero matches.

grep -rn 'sessionStorage:' packages/auth packages/svelte-utils apps/
# Expect: only matches that refer to the browser global window.sessionStorage if any. The
# OAuthAppAuth config field is now tokensStorage.

grep -rn 'deviceAuthorizationClient\|deviceCode\|deviceToken\|DeviceTokenError' packages/ apps/
# Expect: zero matches. The CLI no longer touches device-code.
```

### Commits in this wave

```
refactor(auth-svelte): adopt tokensStorage rename
refactor(apps): browser apps adopt tokensStorage; identity from id_token decode
feat(auth): OOB OAuth launcher (PKCE, stdin code reader, token exchange)
refactor(auth): machine-auth uses OOB launcher and tokens-only file backend
refactor(cli): auth login uses loginWithOob
test(auth): oob-launcher + machine-auth (full rewrite)
```

After Wave 3: run `post-implementation-review` on the entire diff. Run the cross-check greps. Confirm with the human before Wave 4.

## Wave 4: Cleanup

**Goal**: delete `/workspace-identity` server-side. Update docs.

This wave is split into two PRs by reversibility:

### Wave 4a: env-flagged 503 (one release of soak time)

```
apps/api/src/app.ts                                    EDIT
  - replace the /workspace-identity handler body with:
      if (env.DELETE_WORKSPACE_IDENTITY === 'true') {
          return c.text('Gone', 503);
      }
      // ... existing handler ...

  - flip DELETE_WORKSPACE_IDENTITY=true in production via env config (not in code)
```

Watch one release. Check error logs. If anything still calls `/workspace-identity`, find it and fix it. Do not move to 4b until the env-flagged 503 has been live for at least one full release window.

### Wave 4b: actual deletion

```
apps/api/src/app.ts                                    EDIT
  - delete the /workspace-identity route entirely (lines 238-252 today)

apps/api/src/auth/resource-boundary.ts                 EDIT
  - if resolveBearerIdentity now has zero callers, delete it
  - keep resolveBearerUser; it is still used by /api/* middleware

packages/auth/src/index.ts                             AUDIT
  - if any /workspace-identity-only error variant survives in AuthError, delete it

docs/encryption.md                                     EDIT
  - replace /auth/get-session and /workspace-identity references with id_token claims

packages/cli/README.md                                 NEW or EDIT (per OOB spec Phase 6.2)
  - document `epicenter auth login`, the OOB flow, the file location, mode 0o600

specs/20260512T111335-post-oauth-audit-remediation.md  EDIT
  - prepend "Superseded by 20260514T120000-machine-auth-oob-clean-break.md" notice on Phase 4
```

### Cross-check (final)

```bash
grep -rn '/workspace-identity' apps/ packages/
# Expect: zero matches. Anywhere.

grep -rn 'resolveBearerIdentity' apps/ packages/
# Expect: zero matches if you deleted it.

grep -P -rn '\x{2014}|\x{2013}' specs/20260514T154500-id-token-bearing-encryption-keys.md \
                  specs/20260514T120000-machine-auth-oob-clean-break.md
# Expect: zero.
```

### Commits in Wave 4

```
feat(api): env-flagged 503 on /workspace-identity (rollback safety net)
chore(api): delete /workspace-identity route after one-release soak
chore(auth): drop resolveBearerIdentity; orphan after id_token migration
docs(encryption,cli): id_token replaces /workspace-identity; document OOB flow
spec(auth): mark post-oauth-audit Phase 4 superseded
```

After Wave 4: final `post-implementation-review`. Confirm the cohesion sentence still reads true:

> One token bundle, four fields. Identity is a function of the id_token. Browser, extension, and CLI persist the same shape. There is no `/workspace-identity` route, no second storage adapter, no pre-decoded identity cache.

## When to stop and ask the human

Stop and ask if you hit any of these:

- A grep cross-check fails after a wave (e.g., `OAuthSession` still appears after Wave 2). Do not press on; figure out why.
- A test fails in a way you cannot reduce to a single root cause within ~10 minutes of investigation.
- A consumer of `auth.state.identity` does something the spec did not anticipate (e.g., expects a field that is no longer there).
- The OAuth provider plugin returns an unexpected response shape from `/oauth2/token`. Compare against `node_modules/@better-auth/oauth-provider/dist/index.mjs:418-446` and the DeepWiki finding.
- You discover a hidden dependency between waves (e.g., a Wave 1 test requires a Wave 2 schema). Flag it; do not merge waves silently.
- You feel tempted to add a flag, an option, an alias, a deprecation shim, or a migration helper. The spec is a clean break; ask before adding any of those.
- The `/api/health` endpoint behaves differently than expected (e.g., the bearer middleware needs adjustment to reach it).
- A browser app's smoke fails in a way that suggests the storage cell key migrated wrong.

When you stop, post a short message to the human stating:
- which wave + step
- what failed
- what you tried
- two or three options for how to proceed, with your recommendation

## Definition of done (whole composition)

The composition is fully landed when ALL of these are true:

```
[ ] customIdTokenClaims is registered in apps/api/src/auth/create-auth.ts
[ ] /auth/oauth2/token returns id_token with workspace_encryption_keys when scoped
[ ] customIdTokenClaims throws if workspaces:open granted without email
[ ] jwt() plugin uses ES256
[ ] /auth/cli-callback page renders the code with no-store, no-transform
[ ] /api/health returns 200 with valid bearer
[ ] OAuthTokenGrant arktype has four fields including idToken
[ ] OAuthSession type does not exist anywhere in packages/ or apps/
[ ] decodeIdTokenClaims is the only path producing WorkspaceIdentity
[ ] No code in packages/ or apps/ (other than tests asserting absence) calls /workspace-identity
[ ] /workspace-identity route in apps/api is deleted (Wave 4b)
[ ] resolveBearerIdentity is deleted if orphaned
[ ] ~/.epicenter/auth.json holds OAuthTokenGrant; mode is 0o600
[ ] machine-auth.ts has no Bun.secrets, no deviceAuthorization import, no /workspace-identity call
[ ] Browser localStorage cell, extension chrome.storage cell, CLI auth.json all validate against
    the same OAuthTokenGrant arktype
[ ] CLI smoke passes on macOS, Linux server (SSH headless), Docker container
[ ] Browser smoke passes on at least one app: cold boot, sign-in, sign-out, force-401-reauth, restore
[ ] grep -P '\x{2014}|\x{2013}' returns zero in source files, comments, JSDoc, error strings, commit messages
[ ] post-implementation-review run after each wave; findings addressed or filed
```

When all boxes are checked, post a one-paragraph summary to the human and stop. Do not start a follow-up cleanup pass without explicit ask.

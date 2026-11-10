# Local secrets, the `EPICENTER.md` marker, backup status, and a public sign-in

**Date**: 2026-11-11
**Status**: Draft
**Owner**: Braden
**Branch**: `claude/local-files-and-sign-in` (records); code waves branch from `claude/collections` once its review fixes land
**Supersedes**: none. Decisions: [ADR-0870](../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md), [ADR-0868](../docs/adr/0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (marker), [ADR-0851](../docs/adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (backup status), [ADR-0871](../docs/adr/0871-a-public-address-signs-clients-in-with-better-auths-mcp-plugin-and-the-owner-approves-from-the-tailnet.md) (sign-in)

## One sentence

Replace the Keychain with `.local` collections, mark an Epicenter with
`EPICENTER.md`, make a missing backup visible, and let claude.ai and ChatGPT
reach `epicenter serve` through Funnel with Better Auth's MCP plugin and
approval from the tailnet.

## Current and target

| | Now (`claude/collections`) | Target |
| --- | --- | --- |
| Secrets | `secrets` in the run, `Bun.secrets` under `epicenter.<id>.<app>` | a one-file collection at `<name>.local.md`; no `secrets` |
| `.local` | never committed | also: no generated verbs, writable in a read-only run, created `0600` |
| Marker | `epicenter.root.json` `{ id, port }` | `EPICENTER.md`, front matter `port`, `owners`, `public` |
| Backup | unpushed count only when `origin/<branch>` exists | `not backed up` / `never backed up` in status, and after `epicenter new` |
| Public access | none; tailnet only, no sign-in | Funnel port from `public`; OAuth through `@better-auth/mcp` + `@better-auth/cimd`; `epicenter connections` |

## Order and dependencies

Wave 1 edits `packages/app/src/context.ts` and `collection.ts`, which the
review fixes on `claude/collections` also edit (collection `update`, BOM,
claims). Start code after those commits land, from the new tip. Waves 1 to 3
are independent of each other; wave 4 needs wave 2 (`EPICENTER.md` fields).

## Wave 0: checks before code

Each settles a fact the records lean on; write the result into this spec.

1. Better Auth 1.8.0-beta.7 with a `bun:sqlite` `Database` as `database`, and
   its migrations run from code (`getMigrations`) with no CLI step. If not, use
   Kysely's Bun SQLite dialect.
2. `fetchClientMetadataResource` from `@better-auth/cimd/node` works under Bun
   (it pins DNS answers and sets TLS SNI by hand).
3. Bump the catalog's Better Auth packages from 1.8.0-beta.0 to 1.8.0-beta.7:
   typecheck and test `packages/server` and `apps/api` alone, in its own
   commit.
4. Whether oauth-provider's consent endpoint accepts a narrower `scope` than
   requested, for "Allow reading only". If not, `/.allow` re-issues the
   authorization request with `scope=read` before consenting.
5. Whether `@modelcontextprotocol/sdk`, as `serve` uses it, answers the
   protocol versions claude.ai and ChatGPT send. Test it with the SDK's client
   locally. The `@better-auth/mcp` README pairs with `@modelcontextprotocol/server`
   v2 `createMcpHandler({ legacy: 'reject' })`, but `requireMcpAuth` wraps any
   `(Request) => Response`, so moving is optional.

## Wave 1: `.local` files replace the Keychain (ADR-0870)

- `packages/app/src/context.ts`: `Context` is `{ folder }`; delete `secrets`,
  `Secrets`, and their `writableRun` branches. A read-only run lets
  `write`, `writeBytes`, `update`, and `delete` through when the path matches
  `*.local` or `*.local.*`.
- `packages/app/src/collection.ts`: `actions()` throws
  `<path> never leaves this computer, so it offers no actions` when `path`
  matches `*.local` or `*.local.*`. Check that `path.ts` accepts `google.local.md`
  as a one-file template.
- `packages/cli/src/disk.ts` and `packages/app/src/memory.ts`: a new file at a
  `.local` path is created `0600` (the temp file is `chmod`ed before the
  rename, as a replaced file's mode already is).
- Delete `packages/cli/src/secrets.ts`, its uses in `home.ts`, the `keychain`
  field in `listing.ts`, `createMemorySecrets`, and `EPICENTER_TEST_SECRETS`.
- Tests:
  - a read-only action writes `x.local.md` and is refused writing `x.md`;
  - `actions()` on a `.local` collection throws;
  - a `.local` file is `0600`;
  - a snapshot never takes it (existing test);
  - a run's context has no `secrets`.
- Docs: `packages/app/README.md`, `packages/cli/README.md`, and the
  `epicenter-app` skill teach a secret as a `.local.md` collection.

## Wave 2: `EPICENTER.md` (ADR-0868)

- `packages/cli/src/root.ts`: walk up for `EPICENTER.md`. Read its front
  matter with `@epicenter/app`'s front-matter reader: `port` (integer 0 to
  65535), `owners` (list of strings), and `public` (443, 8443, or 10000).
  Anything else is a problem naming the field. `EpicenterRoot` loses `id`.
- A folder with `epicenter.root.json` and no `EPICENTER.md` is refused with
  the step `write EPICENTER.md with port: <n>, then delete epicenter.root.json`.
- `packages/cli/src/init.ts` writes the `EPICENTER.md` shown in ADR-0868.
- Tests: discovery from inside an app; front-matter problems; the old marker's
  refusal; `init`'s file.
- Docs: `packages/cli/README.md`, the `epicenter-app` skill (setup and test
  sections).

## Wave 3: a missing backup is visible (ADR-0851)

- `packages/cli/src/snapshot.ts` `statusOf`: add `backup: 'none'` when there
  is no `origin`, and `'never'` when there is one but no `origin/<branch>`.
- `listing.ts`: `not backed up` / `never backed up` in the app line and above
  its actions, with the next step from ADR-0851.
- `new.ts`: the same line at the end of stderr.
- Tests: an app with no origin, one with an origin never pushed, one pushed.
- Use whichever name the status JSON field has after the review fixes land
  (`history` is being renamed to `status`).

## Wave 4: the public sign-in (ADR-0871)

- `packages/cli/package.json`: `better-auth`, `@better-auth/mcp`,
  `@better-auth/cimd` from the catalog.
- New `packages/cli/src/auth.ts`:
  - the `betterAuth` call from ADR-0871, with `basePath: '/.auth'` and
    `connections.local.sqlite` in the Epicenter's folder;
  - migrations on start;
  - an access token lifetime of 15 minutes;
  - `tailnetSignIn`, a plugin with one endpoint that checks the owner's
    `Tailscale-User-Login`, refuses `Tailscale-Funnel-Request`, finds or
    creates the user by login, and calls `internalAdapter.createSession`.
- `packages/cli/src/http.ts`:
  - classify each request by the ADR-0871 table (`Tailscale-Funnel-Request`,
    `Tailscale-User-Login` against `owners`, neither);
  - over Funnel, serve only the listed paths; mount Better Auth at `/.auth/*`
    and its metadata at the two `/.well-known` paths;
  - wrap `POST /` in `requireMcpAuth`;
  - with only `read`, filter `tools/list` to `readOnlyHint` actions and answer
    other calls with `createInsufficientScopeError`.
- `/.sign-in` and `/.allow`: two server-rendered HTML pages in `http.ts`, plain
  forms, no framework. The `/.allow` copy is in ADR-0871.
- Startup: with `public` set, read `tailscale status --json` for the name,
  owner, and Funnel routes. If Funnel does not route `public` to this port,
  print the `tailscale funnel` command and keep serving the tailnet.
- New `packages/cli/src/connections.ts`: `epicenter connections` and
  `epicenter connections revoke <client>`, reading the same SQLite file. Add
  `connections` to `COMMANDS`.
- Tests: no network, no Tailscale.
  - Classification: each table row by headers.
  - Funnel path filter.
  - The whole OAuth flow in process: metadata, then authorize, then
    `/.sign-in` with an owner header, then `/.allow`, then token, then
    `POST /` with the token. Inject a `fetchClientMetadataResource` that
    returns a fixed client document, since the real one refuses non-public
    DNS.
  - A `read` token cannot call a write action.
  - A revoke ends the refresh.
  - A request with another login gets 403.
- Docs: `packages/cli/README.md` (serve, connections), `docs/vision.md` check,
  the `epicenter-app` skill (how a person connects Claude and ChatGPT).

## Wave 5: the live Epicenter

The person runs these, or approves each.

1. `~/Epicenter`: write `EPICENTER.md` (`port: 4747`, `public: 10000`), delete
   `epicenter.root.json`.
2. Remove `.gitattributes` from `~/Epicenter/tasks` and `~/Epicenter/vocab`
   (no binaries; ADR-0856), snapshot, push.
3. Restart `serve` from the final commit. Then run
   `tailscale funnel --bg --https=10000 http://127.0.0.1:4747`. That publishes
   an address, so it needs the person's go.
4. Connect claude.ai and ChatGPT. Record in ADR-0871 whether ChatGPT completed
   CIMD or needed dynamic registration.

## Done when

- Mail-style secret: a `.local.md` collection read in a read-only action that
  refreshes its token. No `secrets`, `Bun.secrets`, or `keychain` remains
  outside `docs/`.
- `epicenter` in a folder with only `EPICENTER.md` works; the old marker is
  refused with its step.
- An app with no `origin` says `not backed up` in the listing and after
  `epicenter new`.
- Claude and ChatGPT each list and call actions over the Funnel address. A
  `read` approval cannot write. `epicenter connections revoke` stops a client
  within 15 minutes.
- Each wave passed `post-implementation-review`; decisions that changed in
  the work are edited into ADR-0868, 0870, 0871, and 0851. This spec is
  deleted.

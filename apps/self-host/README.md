# Self-hosted Epicenter

This community-supported deployment runs on infrastructure you control. The
server operator enrolls named people; each person signs in with a passkey. The
shared credential owner in `@epicenter/server/self-host-auth` stores admission,
passkeys, sessions, and recovery grants together. Cloud billing remains in
`apps/api`.

The library-ownership implementation is in progress. Both runtime entries serve
passkey sign-in and named sessions. The Worker also serves store sync; Bun still
needs its sync backend. Application connection screens still need the new
sign-in integration, and Shared libraries and optional passwords are unbuilt.
Follow the [execution plan](../../specs/20260909T004225-library-ownership-execution.md)
for remaining work and verification.

## Run the Bun issuer locally

From the repository root:

```bash
bun dev:self-host
```

The default issuer is `http://localhost:8787`. Auth state lives in
`apps/self-host/data/auth.sqlite`. `AUTH_DB_PATH` can select another file; relative
paths are resolved from `apps/self-host` for both the server and operator command.
Keep the database and its SQLite sidecar files on persistent storage.

Enroll a person in that same database:

```bash
bun apps/self-host/scripts/manage-user.ts admit alice 'Alice'
```

Deliver the printed, expiring link privately to Alice. Opening it creates a
passkey and signs her in. The page removes the grant from the address bar before
the ceremony. This enrollment link grants one credential; it is not an
application bearer token.

Use the same `API_PUBLIC_ORIGIN`, `PORT`, and `AUTH_DB_PATH` environment when
running the server and operator command. A non-local issuer requires a stable
HTTPS origin because passkeys are bound to its host.

```bash
bun apps/self-host/scripts/manage-user.ts recover alice
bun apps/self-host/scripts/manage-user.ts remove alice
```

Recovery immediately invalidates Alice's old credentials and sessions and prints
a replacement enrollment link for the same user ID. Removal disables access and
outstanding grants. Neither command changes library content. Recovery cannot
restore a removed user, and `instance` is reserved to prevent accidental access
to historical shared-token data.

## Configure the Worker

`worker/index.ts` uses the same credential commits through a SQLite Durable
Object named `deployment`. `wrangler.jsonc` declares `SELF_HOST_AUTH` and its
migration alongside the existing store bindings. Preserve existing migration
history when adapting a customized Worker.

Set `API_PUBLIC_ORIGIN` to the exact HTTPS issuer origin. Set
`SELF_HOST_CALLBACKS` to a JSON array of exact application callback URLs, for
example `["https://notes.example.com/auth/callback"]`. The checked-in empty array
allows passkey enrollment and sign-in but refuses application handoffs.
`TRUSTED_BROWSER_ORIGINS` separately controls cross-origin API requests and takes
a comma-separated list of exact browser origins.

The Worker credential owner exposes infrastructure RPC methods for admission,
recovery, and removal. A runnable Worker operator command is still required;
the local Bun command only changes its SQLite file. This reference has no public
HTTP administration route. `INSTANCE_TOKEN` no longer authorizes either entry.

## Session and access boundaries

The issuer's `/sign-in` page performs the passkey ceremony. An application sends
an exact callback, state, and PKCE challenge. A one-use code is exchanged for an
independent opaque bearer, preserving the time of the original sign-in.
`reauth=1` requires a fresh passkey ceremony. The browser cookie and application
bearer have separate lifetimes and revocation operations.

Each protected request resolves current admission. Removing a person refuses
subsequent checks; it does not erase offline copies or undo already authorized
work. Existing store sockets retain their fixed 600-second authorization
deadline. Issued blob tickets retain their 120-second GET or 300-second PUT
lifetime. These are separate bounds, not an immediate global revocation claim.

`OPENAI_API_KEY` and `GEMINI_API_KEY` enable the shared inference gateway. Admitted
users consume those configured provider accounts without per-person billing.
Inference and transcription each have a 120-request-per-minute policy, local to
the Bun process or Worker isolate. Configure provider spending limits to match
the group you admit.

## Development evidence

From the repository root:

```bash
bun test apps/self-host/runtime-profile.test.ts packages/server/src/self-host-auth
bun run --cwd apps/self-host typecheck
```

The production Worker credential owner also has real WebAuthn and HTTP handoff
coverage in `packages/server/evidence/enrollment`. The runtime profile explicitly
records Bun's missing sync backend so auth parity cannot imply sync parity.

# Self-hosted Epicenter

This community-supported deployment runs on infrastructure you control. The
server operator enrolls named people; each person signs in with a passkey. The
shared credential owner in `@epicenter/server/self-host-auth` stores admission,
passkeys, sessions, and recovery grants together. Cloud billing remains in
`apps/api`.

Both runtime entries serve passkey sign-in and named sessions. The Worker
serves Personal and Shared data synchronization; Bun still needs its sync
backend. Desktop Settings and apps with server selection can choose this
issuer. Honeycrisp fixes its issuer per build instead. Optional passwords
remain unbuilt.
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
outstanding grants. Neither command changes application data. Recovery cannot
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

The Worker exports a named `SelfHostOperator` entrypoint for admission, recovery,
and removal. The command reaches it through a remote service binding authenticated
by Wrangler. Sign in with `bun x wrangler login`, or provide a
`CLOUDFLARE_API_TOKEN` authorized to create Worker preview sessions in the selected
account. The deployed Worker must contain this entrypoint before using the command.

From the repository root, substitute your Cloudflare account ID and deployed Worker
name (including its environment suffix, if any):

```bash
export CLOUDFLARE_ACCOUNT_ID='<account-id>'
bun apps/self-host/scripts/manage-worker-user.ts my-self-host admit alice 'Alice'
bun apps/self-host/scripts/manage-worker-user.ts my-self-host recover alice
bun apps/self-host/scripts/manage-worker-user.ts my-self-host remove alice
```

These commands always change the selected remote deployment. They do not deploy
code or open the Bun SQLite file. Admission and recovery print a private, expiring
link using the deployment's configured issuer origin. Recovery and removal have
the same identity and invalidation behavior described above.

Cloudflare's account permissions protect the service binding. The named entrypoint
has no HTTP handler and the public Worker exposes no administration routes. Treat
access to create service bindings in this account as operator access.
`INSTANCE_TOKEN` no longer authorizes either entry.

The implementation uses Wrangler's [remote service bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)
and [getPlatformProxy API](https://developers.cloudflare.com/workers/wrangler/api/).
Direct remote Durable Object bindings are unsupported, so the service entrypoint
forwards commands to the same `SelfHostAuthOwner` that serves sign-in.

## Connect an application

After Alice creates her passkey from the private link, she opens her app,
chooses **Connect to your server**, and enters the issuer origin. The app opens
the server's sign-in page and receives its own session through the callback.
The existing browser sign-in can finish this handoff without another passkey
prompt. Reauthentication asks for a fresh passkey proof.

For a browser app, allow its exact `/auth/callback` URL in
`SELF_HOST_CALLBACKS` and its origin in `TRUSTED_BROWSER_ORIGINS`. Desktop uses
`epicenter://auth/callback`; select the server in Home Settings, restart, and
choose **Sign in**. The desktop host keeps the credential and makes requests
for application windows.

An enrollment link does not select an application or start its PKCE transaction.
Alice returns to the app to start that handoff. Recovery gives her a new passkey
for the same identity. Her existing local data stays attached to that identity.

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
bun apps/self-host/smoke/application.browser.mjs
bun apps/self-host/smoke/application.browser.mjs --worker
```

The production Worker credential owner also has real WebAuthn and HTTP handoff
coverage in `packages/server/evidence/enrollment`. The runtime profile explicitly
records Bun's missing sync backend so auth parity cannot imply sync parity.

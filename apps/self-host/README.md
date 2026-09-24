# Self-hosted Epicenter

This community-supported deployment runs on infrastructure you control. The
server operator enrolls named people; each person signs in with a passkey. The
shared credential owner in `@epicenter/server/self-host-auth` stores admission,
passkeys, sessions, and recovery grants together. Cloud billing remains in
`apps/api`.

Both runtime entries serve passkey sign-in, named sessions, Personal sync, and
hosted blobs. The Bun reference runs one long-lived process and stores auth,
sync, and blobs under one persistent data root. Applications fix their issuer
per build. Rebuild and redeploy an app to change its server. Optional passwords
remain unbuilt.

## Run the Bun issuer locally

From the repository root:

```bash
bun dev:self-host
```

The default issuer is `http://localhost:8787`. Set `SELF_HOST_DATA_ROOT` to a
persistent directory before running the server or operator commands. Relative
paths resolve from `apps/self-host`; the default is `apps/self-host/data`.
The root contains `auth.sqlite`, `blobs.sqlite`, `owner.sqlite`, and a `sync/`
directory of per-document SQLite databases. SQLite may create `-wal` and `-shm`
sidecars. Run one active Bun server per root. A second server is refused.
For a long-lived installation, run `bun apps/self-host/server.ts` under your
process supervisor; `bun dev:self-host` restarts on source changes.

Enroll a person in that same database:

```bash
bun apps/self-host/scripts/manage-user.ts admit alice 'Alice'
```

Deliver the printed, expiring link privately to Alice. Opening it creates a
passkey and signs her in. The page removes the grant from the address bar before
the ceremony. This enrollment link grants one credential; it is not an
application bearer token.

Use the same `API_PUBLIC_ORIGIN`, `PORT`, and `SELF_HOST_DATA_ROOT` environment when
running the server and operator command. A non-local issuer requires a stable
HTTPS origin because passkeys are bound to its host.

Local blobs are the default. To use an S3-compatible service, set
`BLOBS_BACKEND=s3` along with `BLOBS_S3_ENDPOINT`,
`BLOBS_S3_ACCESS_KEY_ID`, and `BLOBS_S3_SECRET_ACCESS_KEY`.
`BLOBS_S3_BUCKET` defaults to `epicenter-blobs`; `BLOBS_S3_REGION` defaults to
`auto`. The authority URLs stay the same, so switching an existing deployment
requires an operator-managed byte and metadata migration first. There is no
automatic backend switch or dual write.

## Protect and restore the data root

Stop the Bun server and wait for it to exit before taking a snapshot. Copy the
entire data root, including SQLite `-wal` and `-shm` sidecars if present, to a
protected backup location. Restart the server after the copy completes. To
restore, stop the server, move the damaged root aside, copy the entire saved
root into place, and start the server. Check sign-in, Personal current download,
and a hosted-blob read before admitting writes. Do not copy a live SQLite root
as a consistency guarantee. If S3 is selected, protect its bucket separately
and restore it to the same point as the data root. Operator commands share the
auth file but do not start another server.

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

Build the browser application with `VITE_EPICENTER_SERVER` set to the issuer
origin. Allow its exact `/auth/callback` URL in `SELF_HOST_CALLBACKS` and its
origin in `TRUSTED_BROWSER_ORIGINS`.

For desktop, compile the native host with `EPICENTER_SERVER_ORIGIN` set to that
origin and allow `epicenter://auth/callback`. The host uses the same configured
origin for credentials, requests, and its native sign-in URL validation.

After Alice creates her passkey from the private link, she opens the configured
app and chooses **Sign in**. The server completes the handoff and the app
receives its own session. An existing browser sign-in can finish this handoff
without another passkey prompt. Reauthentication asks for a fresh passkey proof.
The desktop host keeps the credential and makes requests for application windows.

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
coverage in `packages/server/evidence/enrollment`. The runtime profile checks
that both entries mount Personal sync. `local-lifecycle.test.ts` exercises Bun
enrollment, socket update, local publication, and restart with no S3 service.

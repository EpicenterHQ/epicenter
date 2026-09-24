# Epicenter Self-Hosted Instance (Reference)

A self-hosted Epicenter is one instance: a single partition behind one bearer token you generate and hand out. There are no accounts, no OAuth app to register, no sign-in flow, and no mode to pick. You run the box, you generate a token, and everyone you give that token to reaches the same partition. Not operated by Epicenter: you run the infrastructure, so Epicenter never holds or sees what is stored here.

"Solo" and "shared" are not settings. They are just how many people you hand the one token to. A homelab box for yourself and a shared box for your family or lab are the same deployment; the only difference is the size of the group that holds the credential.

## Quick start (Bun API features)

The whole box is `bun server.ts`: no database, no Cloudflare account, nothing to provision. Generate a token, supply it as `INSTANCE_TOKEN`, and boot:

```bash
# 1. Generate a strong token (256 bits, base64url). Persists nothing.
bun run --cwd apps/self-host gen-token
#   -> Hq9...43-char-token...kQ

# 2. Boot the instance with that token.
INSTANCE_TOKEN=Hq9...kQ \
bun apps/self-host/server.ts
```

A client connects with the server URL and this existing token; the server does not exchange it for another credential. Every request from that client arrives as `Authorization: Bearer <token>` and authenticates against `principals/instance`. Hand the token to one person or to your whole group; the command is identical either way.

Boot fails closed if `INSTANCE_TOKEN` is missing or too weak, and the error names `gen-token`. The box never mints or stores a token: you own the secret, which is exactly what lets the same instance run on Cloudflare too. To rotate, generate a new token, restart with it, and redistribute it; there is no per-person revocation (see [Offboarding](#offboarding-and-rotation)).

`INSTANCE_TOKEN` is the only required variable. The instance needs no external
account database or auth secret. Clients own their stores; the Cloudflare Worker
stores opaque synchronization bytes in Durable Objects. The Bun entry has no
store synchronization backend.

If a browser app is hosted on a different origin from the instance, set
`TRUSTED_BROWSER_ORIGINS` to a comma-separated list of exact origins, for
example `https://notes.example.com`. Same-origin clients and the Tauri desktop
client need no additional entry. Paths and wildcard origins are rejected.

### Use TLS

A static bearer over plaintext HTTP is total compromise: anyone who sees one request can capture the token and replay it forever. Terminate TLS in front of the box (Caddy, nginx, a Cloudflare Tunnel) and serve the instance over HTTPS. A homelab on a trusted LAN behind its own boundary is your call, but the moment the box is reachable over the open internet, plain `http://` hands out the keys.

## Running on Cloudflare

The same `@epicenter/server` composition runs as a Worker (`worker/index.ts`). It works because you supply the secret; there is no first-boot minting that would tie the instance to a single Bun process. Set the token, then deploy:

```bash
bun run --cwd apps/self-host gen-token | tr -d '\n' | \
  bunx wrangler secret put INSTANCE_TOKEN --cwd apps/self-host

bun run --cwd apps/self-host typecheck
bun run --cwd apps/self-host deploy
```

`INSTANCE_TOKEN` is the only secret to set: the instance composes no Better Auth and no Postgres, so there is no `BETTER_AUTH_SECRET` and no Hyperdrive binding (ADR-0075). Set `API_PUBLIC_ORIGIN` in `wrangler.jsonc` to your domain. A Worker has no boot phase, so the entropy gate (`assertStrongToken`) runs per request at the edge: a weak or unset `INSTANCE_TOKEN` fails every request closed. Use `gen-token` for the secret.

`worker-configuration.d.ts` is hand-written: it inherits the library's binding
contract (`ServerBindings`) and declares the deployment-owned config,
`API_PUBLIC_ORIGIN` and `INSTANCE_TOKEN`. If you add bindings of your own,
declare them there (or regenerate with `bun run typegen` and re-add the
`extends` clause).

## What this isn't

This is not Epicenter Cloud. There are no billing routes (billing is hosted-only and lives in `apps/api/worker/billing/`), no dashboard SPA, and no SLA, support contract, or paid hosting from Epicenter. There is also no per-user partitioning: every valid token reaches the one `principals/instance` partition. Multi-tenancy, where everyone signs in and gets their own private partition, is Epicenter Cloud's only. An enterprise that wants on-prem runs one instance (shared), or one instance per person or team.

Community-supported, not Epicenter-operated. Issues filed against this folder are accepted as community contributions.

### Store sync on Cloudflare

The Worker mounts `mountStoreSyncApp` with the same static-token resolver as
session and blob requests. Its `STORE_AUTHORITY` and `GENERATIONS_LEDGER`
Durable Object bindings store opaque bytes and generation numbers under
`principals/instance`. The committed class declarations and initial SQLite
migration create this deployment's own backend; preserve your existing
migration history if adapting an already-customized Worker.

The Bun entry still serves session, inference, transcription, and blobs only.
There is no Bun store backend, so two devices cannot synchronize their stores
through that entry. `runtime-profile.test.ts` records this runtime difference.

## Inference and your house key

If you set `OPENAI_API_KEY` or `GEMINI_API_KEY`, the instance offers an OpenAI-compatible inference gateway at `/v1/chat/completions`. That is YOUR key, the "house key", shared by everyone holding `INSTANCE_TOKEN` and unmetered: there is no per-person billing on an instance (that is Cloud's job). Leave both unset and the gateway returns 503 until configured.

Two things keep that from becoming a runaway bill:

- **Set a hard spend cap on the provider key itself.** This is your real ceiling. In the OpenAI or Google AI dashboard, give the key a monthly hard limit. If `INSTANCE_TOKEN` ever leaks, that cap is what bounds the damage, regardless of anything in this box. Do this before you hand the token out.
- **The box also rate-limits the gateway** (`rateLimit({ requests: 120, windowSeconds: 60 })` in `server.ts` / `worker/index.ts`) as an in-process burn-rate floor. It is exact on the single-node Bun box and per-isolate on Cloudflare. Tune it to your group's size, or drop the policy to leave it uncapped. It is a backstop, not a substitute for the provider cap above.

## Composition

The whole instance is the same handful of lines on either runtime: build the app
with `createServerApp`, then mount each surface. No billing, no SPA, no
`createCloudContextMiddleware`. Bun (`server.ts`) reads the token once at
boot and runs the entropy gate there:

```ts
const token = requireStrongInstanceToken(env.INSTANCE_TOKEN);   // fail closed if weak
const resolveBearerPrincipal = createEnvTokenResolver(token);   // one bearer
const auth = requireBearerPrincipal(resolveBearerPrincipal);    // every surface
const app = createServerApp({
  resolveOrigin: () => origin,
  resolveTrustedOrigins: () => trustedOrigins,
});
mountSessionApp(app, { auth });
mountInferenceApp(app, {
  auth,
  policies: [rateLimit({ requests: 120, windowSeconds: 60 })],  // burn-rate floor
});
mountTranscriptionApp(app, {
  auth,
  policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
});
mountBlobsApp(app, { auth });
```

Cloudflare (`worker/index.ts`) reads the per-request secret at the edge instead,
running the same entropy gate per request (a Worker has no boot phase):

```ts
const resolveBearerPrincipal: ResolveBearerPrincipal = (c, bearer) =>
  createEnvTokenResolver(
    assertStrongToken((c.env as Cloudflare.Env).INSTANCE_TOKEN),
  )(c, bearer);
const auth = requireBearerPrincipal(resolveBearerPrincipal);
// ...createServerApp({ resolveOrigin, resolveTrustedOrigins }), then the same
// session + inference + transcription + blobs mounts.
// The Worker also mounts store sync with its Durable Object backends.
```

`runtime-profile.test.ts` declares that one divergence and holds every other
surface to parity across both entries.

Deliberately absent: `mountBillingApi`, any OAuth provider, a launch-time mode selector, an admission allowlist, and first-boot token minting. The shape is the contract.

## Offboarding and rotation

The static token has no expiration. Each store socket has a fixed 600-second
authorization lifetime, after which it must reconnect through token verification.
Rotation blocks new requests immediately; existing sockets can retain access
until that deadline.

A multi-person instance has one honest cost: removing someone means rotating the token and redistributing it to everyone who stays. There is no per-member revocation and no authenticated attribution; whoever holds the token is the instance owner, and attribution in collaborative presence is self-declared. This is fine for the trusted small group an instance targets (a family, a club, a lab, a small team) and gets painful past roughly six to eight people with involuntary churn.

The escape, when that pain is real, is named per-person tokens: a hashed token registry behind the same verifier and the same constant partition, so each person gets their own revocable token and a server-stamped identity, with zero data migration. It is a deliberately unbuilt seam (ADR-0075). If you are hitting the offboarding cliff, that is the signal to build it, or to move to Epicenter Cloud, which is multi-tenant by design.

## See also

- [ADR-0075](../../docs/adr/0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) for why an instance is one partition behind one bearer
- [ADR-0076](../../docs/adr/0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) for why the instance composes no Better Auth and no Postgres
- [ADR-0095](../../docs/adr/0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md) for why a WebSocket upgrade carries the bearer as a route-owned subprotocol
- [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) and [ADR-0227](../../docs/adr/0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) for why a server owns no application data
- `apps/api` for the hosted personal cloud variant (OAuth, principal partitions, billing)
- `packages/server` for the shared library both deployables compose

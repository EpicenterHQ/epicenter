/**
 * Epicenter self-hosted instance Worker (Cloudflare; ADR-0075).
 *
 * The instance on Cloudflare: the same `@epicenter/server` surfaces the Bun entry
 * (`server.ts`) builds, wired to Cloudflare bindings instead of plain
 * primitives (ADR-0066), plus the shared Durable Object store backend.
 * `runtime-profile.test.ts` records the runtime difference.
 * One single-partition instance, not a multi-user wiki and not
 * a mode: every request resolves to the pinned `principals/instance` partition,
 * and authentication is one operator-supplied static
 * bearer (`INSTANCE_TOKEN`), constant-time compared. No OAuth, no allowlist, no
 * sessions. "Solo" vs "shared" is only how many people hold the token.
 *
 * This is a reference, not an Epicenter-operated product. Copy this folder, set
 * `INSTANCE_TOKEN` (`wrangler secret put INSTANCE_TOKEN`, generated with
 * `bun run gen-token`), and deploy. The instance composes no Better Auth or
 * Postgres, so there is no Hyperdrive binding and no
 * `BETTER_AUTH_SECRET` (ADR-0075). Community-supported.
 *
 * Trust boundary: the deployer operates the infrastructure. Epicenter never holds
 * or sees the data stored here, so self-hosting is functionally zero-knowledge
 * against Epicenter.
 */

import { assertStrongToken } from '@epicenter/auth';
import {
	createEnvTokenResolver,
	createServerApp,
	GenerationsLedger,
	mountBlobsApp,
	mountInferenceApp,
	mountSessionApp,
	mountStoreSyncApp,
	mountTranscriptionApp,
	type ResolveBearerPrincipal,
	rateLimit,
	requireBearerPrincipal,
	StoreAuthority,
	type StoreAuthorityStub,
} from '@epicenter/server';
import { resolveSelfHostTrustedOrigins } from '../trusted-origins.js';

const app = createServerApp({
	resolveOrigin: (env) => (env as Cloudflare.Env).API_PUBLIC_ORIGIN,
	resolveTrustedOrigins: (baseURL, env) =>
		resolveSelfHostTrustedOrigins(
			baseURL,
			(env as Cloudflare.Env).TRUSTED_BROWSER_ORIGINS,
		),
});

// The instance authenticates one operator-supplied bearer. On Cloudflare the
// secret lives on the per-request `c.env` (a Worker has no module-scope env), so
// the wrapper closes over a resolver that reads `INSTANCE_TOKEN` at the honest edge
// each request (ADR-0066). `assertStrongToken` runs the SAME entropy gate the Bun
// entry runs at boot, so a missing or weak token fails closed on Cloudflare too
// (ADR-0075's entropy floor): a Worker has no boot phase, so the gate runs per
// request and a throw surfaces as a 500 instead of admitting a weak credential. It
// also returns the trimmed token, so there is no `?? ''` coalesce whose removal
// could silently let an unset secret reach the compare.
const resolveBearerPrincipal: ResolveBearerPrincipal = (c, bearer) =>
	createEnvTokenResolver(
		assertStrongToken((c.env as Cloudflare.Env).INSTANCE_TOKEN),
	)(c, bearer);
const auth = requireBearerPrincipal(resolveBearerPrincipal);

app.get('/', (c) =>
	c.json({ product: 'instance', version: '0.1.0', runtime: 'cloudflare' }),
);

// No `createCloudContextMiddleware`: the instance composes no Better Auth and no sessions. The
// operator bearer (`auth` above) is the only gate, so every surface is
// bearer-authenticated (ADR-0075).
mountSessionApp(app, { auth });
// The same opaque store backend as hosted, addressed under the one instance
// principal. Each socket must authenticate again after its 600-second lifetime.
mountStoreSyncApp(app, {
	resolveBearerPrincipal,
	resolveStore: (env) => {
		const bindings = env as Cloudflare.Env;
		return {
			authority: (name) =>
				bindings.STORE_AUTHORITY.get(
					bindings.STORE_AUTHORITY.idFromName(name),
				) as unknown as StoreAuthorityStub,
			ledger: (name) =>
				bindings.GENERATIONS_LEDGER.get(
					bindings.GENERATIONS_LEDGER.idFromName(name),
				),
		};
	},
});
// Cap the inference burn rate so a leaked or overused bearer cannot run the
// operator's house key up unbounded. Per-isolate on Cloudflare (approximate);
// the real ceiling is the hard spend limit on the provider key itself (README).
mountInferenceApp(app, {
	auth,
	policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
});
// The STT sibling of the inference gateway: same operator house key, same
// 503-until-configured opt-out, same burn-rate cap, no Autumn. A `star`
// transcription against this instance is unmetered, which is what makes
// "transcribe through the star you're connected to" true on self-host too.
mountTranscriptionApp(app, {
	auth,
	policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
});
// Content-addressed media store over any S3, mounted by default; it answers 503
// until the operator sets `BLOBS_S3_*` (the same honest opt-out as inference's
// house key). Storage is the operator's own bucket, so no house key to burn.
mountBlobsApp(app, { auth });

export default app;

export { GenerationsLedger, StoreAuthority };

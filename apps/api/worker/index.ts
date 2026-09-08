/**
 * Epicenter Cloud Worker entry.
 *
 * Composes `@epicenter/server` with the cloud principal resolver and layers
 * cloud-only billing and dashboard surfaces on top.
 * The self-hosted single-partition instance lives in a sibling apps/* folder
 * and composes the same library with `instance` and no Autumn policies
 * (ADR-0075).
 *
 * Read top to bottom for the full URL surface of cloud. Each `mount*`
 * call bundles auth + policies + route mount for one
 * reusable surface; the deployment passes only the deployment-controlled
 * knobs (optional cloud policies, auth choice for AI).
 */

import { PRODUCTION_API_URL } from '@epicenter/constants/apps';
import {
	type CloudEnv,
	connectHyperdriveDb,
	createServerApp,
	GenerationsLedger,
	mountBlobsApp,
	mountCloudAuth,
	mountCloudDb,
	mountInferenceApp,
	mountSessionApp,
	mountStoreSyncApp,
	mountTranscriptionApp,
	requireBearerPrincipal,
	resolveRequestSessionPrincipal,
	type ServerBindings,
	StoreAuthority,
	type StoreAuthorityStub,
} from '@epicenter/server';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import { mountAccountDeletionApi } from './account/routes.js';
import {
	chargeOpenAiCreditsWithAutumn,
	chargeOpenAiTranscriptionCredits,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';
import { buildSessionCallbacks } from './session-callbacks.js';

// Compile-time proof that this worker's generated Env provides every
// binding the library reads. A missing or mistyped binding fails here,
// not deep inside library files compiled in this program.
({}) as Cloudflare.Env satisfies ServerBindings;

// The cloud's Postgres + `waitUntil` are NOT here; they are installed by
// `mountCloudDb` below.
const app = createServerApp<CloudEnv>({
	// The hosted cloud's public origin never changes per deploy, so it is
	// baked from the constants source of truth rather than duplicated into
	// wrangler.jsonc vars. Local dev injects
	// `API_PUBLIC_ORIGIN=http://localhost:8787` via scripts/dev.ts; production
	// falls through to PRODUCTION_API_URL. `API_PUBLIC_ORIGIN` is
	// deployment-owned config, not a binding `ServerBindings` names, so casting
	// to this deployment's own `Cloudflare.Env` is the honest edge (ADR-0066).
	resolveOrigin: (env) =>
		(env as Cloudflare.Env).API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL,
	resolveTrustedOrigins: buildEpicenterTrustedOrigins,
});

// The cloud resolves a signed bearer against its Better Auth session row.
// Each protected wrapper closes over that one resolver; an instance
// closes over its env-token resolver instead (ADR-0075).
const bearer = requireBearerPrincipal(resolveRequestSessionPrincipal);

// The cloud UI (apps/api/ui) is one root-based SvelteKit SPA whose fallback
// shell (`fallback.html`) the server hands out for the browser surfaces it
// owns. This helper is the Worker's implementation of "serve the shell":
// fetch it from the ASSETS binding, forwarding the original request so
// conditional-request headers still work. The `Cloudflare.Env` cast lives
// here at the app edge, like HYPERDRIVE (ADR-0066). A 503 with the
// build command beats a blank page when the UI has not been built (local
// `wrangler dev`).
const serveUiShell = async (c: Context<CloudEnv>) => {
	const shellUrl = new URL('/fallback.html', c.req.url);
	const response = await (c.env as Cloudflare.Env).ASSETS.fetch(
		new Request(shellUrl.toString(), c.req.raw),
	);
	if (!response.ok) {
		return c.text(
			'Cloud UI is not built. Run `bun run --cwd apps/api/ui build`.',
			503,
		);
	}
	return response;
};

// Public health endpoint at root.
app.get('/', (c) =>
	c.json({ product: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Cloud-only Postgres lifecycle: a per-request pg client over Hyperdrive +
// `waitUntil` to keep billing's after-response drain alive. Installed first so
// `c.var.db` is set before Better Auth (and any billing handler) reads it. The
// instance composes no Postgres and never calls this (ADR-0076). The binding name
// and `Cloudflare.Env` cast live at this edge, type-checked against this Worker's
// generated bindings (ADR-0066).
mountCloudDb(app, {
	connect: (env) => connectHyperdriveDb((env as Cloudflare.Env).HYPERDRIVE),
	afterResponse: (c, work) => c.executionCtx.waitUntil(work),
});

// Cloud-only relational-auth layer: per-request Better Auth on `c.var.auth`
// plus hosted sign-in, account management, and session handoff. Host-only cookies
// serve the hosted auth pages; application data requests carry session bearers.
// Mounted before the principal-scoped surfaces so `c.var.auth` is set when their
// bearer wrappers run. The single-partition instance composes none of
// this (ADR-0075). The Cloud-only auth secrets are read at this Worker's own edge
// from its deploy-gated bindings (`c.env as Cloudflare.Env`), never the portable
// `ServerBindings` (ADR-0076/0066).
mountCloudAuth(app, {
	resolveSessionCallbacks: (c) => buildSessionCallbacks(c.var.authBaseURL),
	resolveAuthSecrets: (c) => c.env as Cloudflare.Env,
	serveAuthUiShell: serveUiShell,
});

// Principal-partitioned reusable surfaces.
mountSessionApp(app, { auth: bearer });
// The store transport (ADR-0222, ADR-0292, ADR-0298): one Durable Object per
// (principal, application id, generation) for the log, and one ledger per
// (principal, application id) for which generations exist. Both are reached
// with the same session bearer every other surface uses, and the principal is
// stamped from that bearer and prefixed onto the object name, so being signed
// in on two devices is the whole of the sharing model. The authority reads
// nothing it stores.
mountStoreSyncApp(app, {
	resolveBearerPrincipal: resolveRequestSessionPrincipal,
	resolveStore: (env) => {
		const bindings = env as Cloudflare.Env & {
			STORE_AUTHORITY: DurableObjectNamespace<StoreAuthority>;
			GENERATIONS_LEDGER: DurableObjectNamespace<GenerationsLedger>;
		};
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
// Content-addressed blob store (supersedes the retired assets surface). v1 is
// unmetered (no Autumn policy): Autumn's check() denies by default with no plan
// attached, so deferred quota means not calling it. When storage is billed, a
// `syncBlobStorageWithAutumn` policy and the `policies` seam it needs land on
// `mountBlobsApp` together.
mountBlobsApp(app, { auth: bearer });
mountInferenceApp(app, {
	auth: bearer,
	policies: [chargeOpenAiCreditsWithAutumn],
});
// OpenAI-compatible STT gateway (OpenAI whisper-1, house key). Metered by audio
// duration, settled after the call (per-minute); see chargeOpenAiTranscriptionCredits.
mountTranscriptionApp(app, {
	auth: bearer,
	policies: [chargeOpenAiTranscriptionCredits],
});

// Cloud-only billing data plane. Auth is bundled into the mount so the
// dashboard endpoints can't be mounted without it.
mountBillingApi(app, { auth: bearer });

// Hosted account deletion (Wave G): one route coordinates authority storage,
// the blob prefix, the Autumn customer, storage observations, and the auth
// user, ordered so retries stay authenticated until deletion is complete.
// The mount owns the account-deletion authentication policy.
mountAccountDeletionApi(app);

// Dashboard SPA: serve the cloud UI shell for the dashboard URLs. The hosted
// auth browser surfaces use the same shell through `mountCloudAuth` above.
// Cloud-only because the `ASSETS` binding lives in this worker's wrangler
// config; hashed assets (`/_app/*`, favicon) are served by the asset layer
// before the Worker runs.
app.on(
	'GET',
	['/dashboard', '/dashboard/*'],
	describeRoute({
		description: 'Dashboard SPA static fallback',
		tags: ['dashboard'],
	}),
	serveUiShell,
);

// Legacy redirect: /billing -> /dashboard.
app.get('/billing', (c) => c.redirect('/dashboard'));

// The Worker exposes the Hono fetch handler (the full URL surface above).
// `app.fetch` is bound, so destructuring it is safe.
export default {
	fetch: app.fetch,
};
export { GenerationsLedger, StoreAuthority };

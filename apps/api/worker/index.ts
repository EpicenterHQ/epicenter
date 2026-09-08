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
	createCloudDbMiddleware,
	createServerApp,
	GenerationsLedger,
	mountBlobsApp,
	mountCloudAuth,
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
import { GENERATIONS_ROUTE, STORE_SYNC_ROUTE } from '@epicenter/sync';
import type { Context } from 'hono';
import { every } from 'hono/combine';
import { describeRoute } from 'hono-openapi';
import { mountAccountDeletionApi } from './account/routes.js';
import {
	chargeOpenAiCreditsWithAutumn,
	chargeOpenAiTranscriptionCredits,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';
import { buildSessionCallbacks } from './session-callbacks.js';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';

// Compile-time proof that this worker's generated Env provides every
// binding the library reads. A missing or mistyped binding fails here,
// not deep inside library files compiled in this program.
({}) as Cloudflare.Env satisfies ServerBindings;

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

// Route-owned Postgres lifetime. Hyperdrive acquisition and waitUntil belong
// to this runtime; the middleware drains queued work before closing the client.
const database = createCloudDbMiddleware({
	connect: (env) => connectHyperdriveDb((env as Cloudflare.Env).HYPERDRIVE),
	afterResponse: (c, work) => c.executionCtx.waitUntil(work),
});

// Public auth shells bypass setup. Better Auth endpoints install it directly;
// protected resource mounts below compose it before their own auth guards.
// Cloud secrets stay at this deployment edge, outside ServerBindings.
const cloudAuth = mountCloudAuth(app, {
	database,
	resolveSessionCallbacks: (c) => buildSessionCallbacks(c.var.authBaseURL),
	resolveAuthSecrets: (c) => c.env as Cloudflare.Env,
	serveAuthUiShell: serveUiShell,
});

const bearer = every(
	cloudAuth,
	requireBearerPrincipal(resolveRequestSessionPrincipal),
);

// Principal-partitioned reusable surfaces.
mountSessionApp(app, { auth: bearer });
// The store transport (ADR-0222, ADR-0292, ADR-0298): one Durable Object per
// (principal, application id, generation) for the log, and one ledger per
// (principal, application id) for which generations exist. Both are reached
// with the same session bearer every other surface uses, and the principal is
// stamped from that bearer and prefixed onto the object name, so being signed
// in on two devices is the whole of the sharing model. The authority reads
// nothing it stores.
// Store routes use subprotocol bearers, so install setup before their own guard.
for (const path of [
	STORE_SYNC_ROUTE.pattern,
	GENERATIONS_ROUTE.collectionPattern,
	GENERATIONS_ROUTE.itemPattern,
]) {
	app.use(path, cloudAuth);
}
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

// Hosted account deletion currently refuses before destructive work because
// historical storage ownership and write retirement are not yet established.
// The mount preserves fresh-session and principal-binding checks.
app.delete('/api/account', cloudAuth);
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

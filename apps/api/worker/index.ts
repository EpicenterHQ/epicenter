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
	AttachRelay,
	type CloudEnv,
	ContainerProxy,
	connectHyperdriveDb,
	createDurableObjectAttachRelay,
	createDurableObjectRooms,
	createServerApp,
	DataAuthority,
	type DataAuthorityNamespace,
	DataBackup,
	DataBackupRegistry,
	type DataBackupRegistryNamespace,
	mountAttachRelayApp,
	mountBlobsApp,
	mountCloudAuth,
	mountCloudDb,
	mountCloudflareScalarV1App,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	mountTranscriptionApp,
	PortableMaterializer,
	Room,
	requireBearerPrincipal,
	requireCookieOrBearerPrincipal,
	resolveRequestOAuthDocumentAuthorization,
	resolveRequestOAuthPrincipal,
	type ServerBindings,
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

// Compile-time proof that this worker's generated Env provides every
// binding the library reads. A missing or mistyped binding fails here,
// not deep inside library files compiled in this program.
({}) as Cloudflare.Env satisfies ServerBindings;

const app = createServerApp<CloudEnv>({
	// The one runtime-specific portable concern: bind this Worker's Durable Object
	// room registry. The `Cloudflare.Env` cast and the binding name live here, at
	// the app edge, type-checked against this Worker's generated bindings (ADR-0066).
	// Per-room DO sharding stays the cloud's binding of the room actor forever:
	// hibernate-to-zero and single-writer-per-room at multi-tenant scale. The cloud's
	// Postgres + `waitUntil` are NOT here; they are installed by `mountCloudDb` below.
	resolveRooms: (env) => createDurableObjectRooms((env as Cloudflare.Env).ROOM),
	identity: {
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
	},
});

// The cloud resolves a request to its principal by verifying an OAuth bearer against
// JWKS (`resolveRequestOAuthPrincipal` reads `c.var.auth` + `c.var.db`, both present
// below). Each protected wrapper closes over that one resolver; an instance
// closes over its env-token resolver instead (ADR-0075).
const cookieOrBearer = requireCookieOrBearerPrincipal(
	resolveRequestOAuthPrincipal,
);
const bearer = requireBearerPrincipal(resolveRequestOAuthPrincipal);

// The cloud UI (apps/api/ui) is one root-based SvelteKit SPA whose fallback
// shell (`fallback.html`) the server hands out for the browser surfaces it
// owns. This helper is the Worker's implementation of "serve the shell":
// fetch it from the ASSETS binding, forwarding the original request so
// conditional-request headers still work. The `Cloudflare.Env` cast lives
// here at the app edge, like ROOM and HYPERDRIVE (ADR-0066). A 503 with the
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
// plus the auth surface (sign-in, consent, OAuth metadata). Session cookies are
// host-only to api.epicenter.so and consumed only by the dashboard the API
// serves itself; every other client is a bearer client (ADR-0079).
// Mounted before the principal-scoped surfaces so `c.var.auth` is set when their
// cookie-or-bearer wrappers run. The single-partition instance composes none of
// this (ADR-0075). The Cloud-only auth secrets are read at this Worker's own edge
// from its deploy-gated bindings (`c.env as Cloudflare.Env`), never the portable
// `ServerBindings` (ADR-0076/0066).
mountCloudAuth(app, {
	resolveAuthSecrets: (c) => c.env as Cloudflare.Env,
	serveAuthUiShell: serveUiShell,
});

// Principal-partitioned reusable surfaces.
mountSessionApp(app, { auth: cookieOrBearer });
mountCloudflareScalarV1App(app, {
	auth: bearer,
	resolveDocumentPrincipal: resolveRequestOAuthDocumentAuthorization,
	// Cloudflare's generated RPC stub recursively maps the protocol's JSON union
	// deeply enough to exceed TypeScript's instantiation limit. The deployment
	// still proves the concrete class through its generated binding; narrow it to
	// the two RPC methods the shared mount consumes.
	resolveNamespace: (env) =>
		(env as Cloudflare.Env).DATA_AUTHORITY as unknown as DataAuthorityNamespace,
	resolveBackupRegistry: (env) =>
		(env as Cloudflare.Env)
			.DATA_BACKUP_REGISTRY as unknown as DataBackupRegistryNamespace,
});
// Rooms resolves the bearer itself (WS-aware), so it takes the raw resolver, not
// a prebuilt wrapper.
mountRoomsApp(app, { resolveBearerPrincipal: resolveRequestOAuthPrincipal });
// Remote Super Chat attach (ADR-0115): the endpoint-addressed relay that forwards
// live session bytes between a signed-in desktop host and a signed-in client of
// the same principal. Like rooms it is WS-aware and resolves the OAuth bearer
// itself; the principal is stamped server-side, never the query. The transport is
// a Durable Object per `(principalId, hostId)` pair, bound here at the app edge
// where this Worker's generated `ATTACH_RELAY` binding is typed (ADR-0066, the
// same edge as ROOM). On Cloud a signed-in bearer is the whole attach
// authorization: no device-grant store, pairing ceremony, or QR (self-host keeps
// per-device grants because it has no account substrate).
mountAttachRelayApp(app, {
	resolveBearerPrincipal: resolveRequestOAuthPrincipal,
	resolveRelay: (env) =>
		createDurableObjectAttachRelay((env as Cloudflare.Env).ATTACH_RELAY),
});
// Content-addressed blob store (supersedes the retired assets surface). v1 is
// unmetered (no Autumn policy): Autumn's check() denies by default with no plan
// attached, so deferred quota means not calling it. When storage is billed, a
// `syncBlobStorageWithAutumn` policy and the `policies` seam it needs land on
// `mountBlobsApp` together.
mountBlobsApp(app, { auth: cookieOrBearer });
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
mountBillingApi(app, { auth: cookieOrBearer });

// Hosted account deletion (Wave G): one route coordinates authority storage,
// the blob prefix, the Autumn customer, storage observations, and the auth
// user, ordered so retries stay authenticated until deletion is complete.
// Auth is bundled inside the mount: a fresh cookie session only, so a leaked
// bearer can never destroy the account.
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
export {
	AttachRelay,
	ContainerProxy,
	DataAuthority,
	DataBackup,
	DataBackupRegistry,
	PortableMaterializer,
	Room,
};

/**
 * Epicenter Cloud Worker entry.
 *
 * Composes `@epicenter/server` with the cloud principal resolver and layers
 * cloud-only billing and dashboard surfaces on top. The Bun entry
 * (`server.ts`) composes the same library on Postgres with no Autumn policies.
 *
 * Read top to bottom for the full URL surface of cloud. Each `mount*`
 * call bundles auth + policies + route mount for one
 * reusable surface; the deployment passes only the deployment-controlled
 * knobs (optional cloud policies, auth choice for AI).
 */

import {
	PRODUCTION_API_URL,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createServerApp,
	mountAuthRoutes,
	mountGitHost,
	mountInferenceApp,
	mountTranscriptionApp,
	type OAuthScope,
	registerFirstPartyClients,
	requireAccessToken,
	requireSessionCookie,
	type ServerBindings,
} from '@epicenter/server';
import type { Context } from 'hono';
import { every } from 'hono/combine';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import pg from 'pg';
import {
	chargeOpenAiCreditsWithAutumn,
	chargeOpenAiTranscriptionCredits,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';
import { createArtifactsGitHost } from './git-repositories.js';
import { type LfsBindings, resolveR2Lfs } from './lfs-store.js';
import { buildFirstPartyClients } from './oauth-registrations.js';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';

// Compile-time proof that this worker's generated Env provides every
// binding the library reads. A missing or mistyped binding fails here,
// not deep inside library files compiled in this program.
({}) as Cloudflare.Env satisfies ServerBindings;

const resolveApiOrigin = (env: CloudEnv['Bindings']) =>
	(env as Cloudflare.Env).API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL;

const app = createServerApp<CloudEnv>({
	// The hosted cloud's public origin never changes per deploy, so it is
	// baked from the constants source of truth rather than duplicated into
	// wrangler.jsonc vars. Local dev injects
	// `API_PUBLIC_ORIGIN=http://localhost:8787` via scripts/dev.ts; production
	// falls through to PRODUCTION_API_URL. `API_PUBLIC_ORIGIN` is
	// deployment-owned config, not a binding `ServerBindings` names, so casting
	// to this deployment's own `Cloudflare.Env` is the honest edge (ADR-0066).
	resolveOrigin: resolveApiOrigin,
	resolveTrustedOrigins: buildEpicenterTrustedOrigins,
	// The hosted origin's Git audience lives on its own host
	// (`git.epicenter.so`); any other origin's sits under it (ADR-0326).
	resolveAudiences: resolveOAuthAudiences,
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
// The authorization server's Hyperdrive configuration must have caching
// disabled, so a revoked token is never read from a stale cache (ADR-0549).
const cloudContextOptions = {
	// Hyperdrive is the connection pool, so each request opens a `pg.Client`.
	connect: async (env: ServerBindings) => {
		const client = new pg.Client({
			connectionString: (env as Cloudflare.Env).HYPERDRIVE.connectionString,
		});
		await client.connect();
		return { db: createDb(client), close: () => client.end() };
	},
	afterResponse: (c: Context<CloudEnv>, work: Promise<unknown>) =>
		c.executionCtx.waitUntil(work),
	resolveAuthSecrets: (c: Context<CloudEnv>) => c.env as Cloudflare.Env,
};
const cloudContext = createCloudContextMiddleware(cloudContextOptions);
// The `/auth/*` routes add the OAuth 2.1 authorization server (ADR-0549).
const authServerContext = createCloudContextMiddleware({
	...cloudContextOptions,
	oauthServer: true,
});

// The first-party clients and resources are rows this code declares
// (ADR-0549). Each isolate writes them before its first authorization-server
// request, over that request's own connection; the write is idempotent, so
// isolates that start together converge. Only `/auth/*` reads them. The
// instance's initialization, which seeds the resources on the same
// connection, finishes first.
let firstPartyClientsRegistered = false;
const registerClientsOnce = createMiddleware<CloudEnv>(async (c, next) => {
	if (!firstPartyClientsRegistered) {
		await c.var.auth.$context;
		await registerFirstPartyClients(c.var.db, {
			audiences: c.var.audiences,
			clients: buildFirstPartyClients(c.var.authBaseURL),
		});
		firstPartyClientsRegistered = true;
	}
	await next();
});

// Public auth shells bypass setup. Better Auth endpoints install it directly;
// protected resource mounts below compose it before their own auth guards.
// Cloud secrets stay at this deployment edge, outside ServerBindings.
mountAuthRoutes(app, {
	setup: every(authServerContext, registerClientsOnce),
	serveAuthUiShell: serveUiShell,
});

// Every resource takes only an access token for its audience and the scope
// its operation needs (ADR-0549). Account management on the authorization
// server's own pages takes only its session cookie: billing here, and sign-in
// methods and account deletion through Better Auth under `/auth/*`.
const resource = (audience: 'api' | 'git', scope: OAuthScope) =>
	every(cloudContext, requireAccessToken({ audience, scope }));
const accountSession = every(cloudContext, requireSessionCookie());

// Hosted Git at git.epicenter.so/<namespace>/<name>.git over Cloudflare
// Artifacts (ADR-0546), and `GET /api/repos`. Git decides each request from
// the access token and the namespace membership (`authorizeResourceRequest`),
// and the listing from a Git-audience token, so they take no guard here.
// Unmetered. The local dev launcher removes the Artifacts binding and required account secret, so the
// store resolves to null and hosted Git answers 503. Pushes, web writes and
// LFS go through the receiver and the translator; LFS objects need an R2
// bucket (`resolveR2Lfs`), which this configuration does not bind yet, so the
// LFS routes answer 503 and a push with a non-note file is refused.
const resolveGitHost = (env: ServerBindings) => {
	const { ARTIFACTS, ARTIFACTS_ACCOUNT_ID, ARTIFACTS_NAMESPACE } =
		env as Partial<Cloudflare.Env>;
	if (!ARTIFACTS || !ARTIFACTS_ACCOUNT_ID || !ARTIFACTS_NAMESPACE) return null;
	return createArtifactsGitHost({
		artifacts: ARTIFACTS,
		accountId: ARTIFACTS_ACCOUNT_ID,
		namespace: ARTIFACTS_NAMESPACE,
	});
};
mountGitHost(app, {
	setup: cloudContext,
	resolveHost: resolveGitHost,
	resolveLfs: (env) => resolveR2Lfs(env as LfsBindings),
});
mountInferenceApp(app, {
	auth: resource('api', 'ai'),
	policies: [chargeOpenAiCreditsWithAutumn],
});
// OpenAI-compatible STT gateway (OpenAI whisper-1, house key). Metered by audio
// duration, settled after the call (per-minute); see chargeOpenAiTranscriptionCredits.
mountTranscriptionApp(app, {
	auth: resource('api', 'ai'),
	policies: [chargeOpenAiTranscriptionCredits],
});

// Cloud-only billing data plane for the dashboard, the authorization server's
// own page: billing is account management, which no access token reaches
// (ADR-0549). Auth is bundled into the mount so the dashboard endpoints can't
// be mounted without it.
mountBillingApi(app, { auth: accountSession });

// Dashboard SPA: serve the cloud UI shell for the dashboard URLs. The hosted
// auth browser surfaces use the same shell through `mountAuthRoutes` above.
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

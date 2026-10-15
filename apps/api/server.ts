/**
 * Bun entry for apps/api: the runtime port's keystone second runtime.
 *
 * Builds the SAME `createServerApp(...)` the Cloudflare Worker builds
 * (`worker/index.ts`), but binds the per-concern runtime hooks to plain
 * primitives instead of Cloudflare bindings (ADR-0066):
 *
 *   - the `db` leg   a module-scope `pg.Pool` over `DATABASE_URL`, drained
 *                    fire-and-forget in the live process (no `waitUntil`)
 *   - blobs          any S3 endpoint via the existing `BLOBS_S3_*` env
 *
 * This is additive: `wrangler dev`/`deploy` still serve the Worker unchanged.
 * `bun --watch server.ts` boots instantly with real stack traces. This entry is
 * also the self-host path: the same Better Auth, Postgres, and mounts as the
 * Worker, on any machine with Bun, Postgres, and an optional S3 endpoint.
 *
 * The whole Bun bootstrap lives here, in the app, not behind a shared
 * `@epicenter/server` factory: everything mechanical (the `pg.Pool`, the cloud
 * auth layer, the session/inference/blobs mounts, `Bun.serve`) is this app's
 * composition to own. The library ships the parts.
 *
 * The wiring lives in {@link startBunApiServer} so `server.dev.ts` can boot the
 * SAME server with a dev `resolveBearerPrincipal` injected (the parity smoke's credential)
 * without duplicating it. The bottom of this file runs production only when this
 * file IS the entrypoint (`import.meta.main`), so `server.dev.ts` importing the
 * builder does not also start a second listener. Production passes no
 * `resolveBearerPrincipal` and keeps the real session resolver; this file never imports the
 * dev bypass.
 *
 * Runtime skew is fenced by design: a DO-only behavior (hibernation restore,
 * alarm timing, edge placement) will not surface here, so `wrangler dev` /
 * staging stays the fidelity gate before any deploy touching runtime behavior.
 *
 * Four surfaces the Worker serves are intentionally absent here, and
 * `runtime-profile.test.ts` is where that list is declared and checked against
 * both entries: the dashboard SPA and the account-deletion route need Worker-only
 * bindings (`ASSETS`, `STORE_AUTHORITY`), and billing is the hosted Worker's
 * concern. Everything the shared library can mount on both runtimes is mounted
 * on both.
 * Because this runtime cannot resolve the hosted storage allowance, first
 * contact is allowed only for workspaces already registered by the hosted
 * Worker. Existing current-state replicas in this runtime's own backend may
 * still sync; opening an old records database performs the authorized protocol
 * reset and does not resume legacy receipts.
 */

import {
	API_BUN_DEV_PORT,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import {
	CloudAuthBindings,
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createServerApp,
	mountAuthRoutes,
	mountGitApp,
	mountInferenceApp,
	mountPersonalAuthorityBlobs,
	mountSessionApp,
	mountTranscriptionApp,
	nodeClientMetadataFetch,
	type OAuthScope,
	type ResolveBearerPrincipal,
	registerFirstPartyClients,
	requireAccessToken,
	requireBearerPrincipal,
	resolveDeploymentBlobStore,
	ServerBindings,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import { every } from 'hono/combine';
import pg from 'pg';
import { buildFirstPartyClients } from './worker/oauth-registrations.js';
import { buildEpicenterTrustedOrigins } from './worker/trusted-origins.js';

/**
 * The apps/api Bun env contract: the portable {@link ServerBindings}, the
 * Cloud-only {@link CloudAuthBindings} (Better Auth + OAuth secrets, ADR-0076),
 * and this host's process config (`DATABASE_URL`, port, origin).
 *
 * `CloudAuthBindings` already requires `BETTER_AUTH_SECRET` and leaves each OAuth
 * provider optional (register-when-present, ADR-0071). This hosted hub is
 * stricter: its sign-in UI offers only providers with production credentials, so
 * the Bun host requires those provider credential sets at boot instead of letting
 * a shown provider fail later. Unlike the Cloudflare edge (whose bindings are
 * deploy-gated and `wrangler types`-typed), `process.env` is unchecked, so boot is
 * the place to validate it. The validated env is also what feeds
 * `createCloudContextMiddleware`'s `resolveAuthSecrets` below, so the Cloud-only secrets reach
 * Better Auth without ever entering the portable `ServerBindings`.
 */
const ApiBunBindings = ServerBindings.merge(CloudAuthBindings).merge({
	DATABASE_URL: 'string',
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	GOOGLE_CLIENT_ID: 'string',
	GOOGLE_CLIENT_SECRET: 'string',
	GITHUB_CLIENT_ID: 'string',
	GITHUB_CLIENT_SECRET: 'string',
	MICROSOFT_CLIENT_ID: 'string',
	MICROSOFT_CLIENT_SECRET: 'string',
});

/**
 * Boot the apps/api Bun server, optionally with an injected principal resolver.
 *
 * Production (`server.ts` as the entrypoint) passes nothing, so every
 * resource takes OAuth access tokens (ADR-0549). `server.dev.ts` passes a dev
 * `Bearer dev:<principalId>` resolver, which then guards every resource in
 * their place, so the parity smoke needs no interactive login. Everything else (env validation, pool, mounts, `Bun.serve`) is
 * identical across the two, so they cannot drift.
 */
export async function startBunApiServer(
	opts: { resolveBearerPrincipal?: ResolveBearerPrincipal<CloudEnv> } = {},
): Promise<void> {
	// Validate this Bun host's environment once, at boot. The validated result IS
	// the typed env handed to the Hono app: no `as`-cast over `process.env`, no
	// lie (ADR-0066). A misconfiguration gets ONE descriptive error naming every
	// missing or malformed var.
	const env = ApiBunBindings(process.env);
	if (env instanceof type.errors) {
		console.error(`Invalid environment for the Bun server:\n${env.summary}`);
		process.exit(1);
	}

	const port = Number(env.PORT ?? API_BUN_DEV_PORT);
	// The auth origin must match where the process actually listens (cookies and
	// hosted callback URLs derive from it). Default to localhost
	// on the chosen port; an operator overrides it with their domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

	// One pool for the process. Drizzle checks out clients per query; the
	// request middleware borrows the pool and has no per-request client to close.
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = createDb(pool);

	// The migrations seed the hosted cloud's clients. This process serves its
	// own origin, so it writes the first-party clients and resources for that
	// origin once, at boot (ADR-0549, ADR-0326).
	const audiences = resolveOAuthAudiences(origin);
	await registerFirstPartyClients(db, {
		audiences,
		clients: buildFirstPartyClients(origin),
	});

	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: buildEpicenterTrustedOrigins,
	});


	const serveAuthUiShell = () =>
		new Response(
			'Hosted auth UI is served by the SvelteKit app in Bun dev. Use `bun run --cwd apps/api/ui dev` for browser auth surfaces, or `bun run --cwd apps/api dev` for the Worker asset shell.',
			{
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			},
		);

	app.get('/', (c) =>
		c.json({ product: 'hub', version: '0.1.0', runtime: 'bun' }),
	);
	// The live Bun process keeps the drain alive without waitUntil.
	const cloudContextOptions = {
		connect: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => env,
	};
	const cloudContext = createCloudContextMiddleware(cloudContextOptions);
	const authServerContext = createCloudContextMiddleware({
		...cloudContextOptions,
		resolveOAuthServer: () => ({
			audiences,
			clientMetadataFetch: nodeClientMetadataFetch,
		}),
	});
	// Public auth shells bypass setup. Database-backed endpoints and resource
	// guards explicitly install the context middleware, just like the Worker.
	mountAuthRoutes(app, {
		setup: authServerContext,
		serveAuthUiShell,
		resolveAudiences: () => audiences,
	});
	// Every resource takes only an access token for its audience and the scope
	// its operation needs (ADR-0549). The dev entry's resolver replaces that
	// guard for the parity smoke.
	const devBearer = opts.resolveBearerPrincipal;
	const resource = (audience: 'api' | 'git', scope: OAuthScope) =>
		every(
			cloudContext,
			devBearer
				? requireBearerPrincipal(devBearer)
				: requireAccessToken({ audience: () => audiences[audience], scope }),
		);
	mountSessionApp(app, { auth: resource('api', 'profile') });
	// Hosted Git needs the Worker's Artifacts binding. Mounting it with no store
	// keeps the routes in the shared profile and answers 503 `GitUnavailable`.
	mountGitApp(app, {
		auth: resource('git', 'folders:write'),
		resolveStore: () => null,
	});
	mountInferenceApp(app, { auth: resource('api', 'ai') });
	// The STT sibling of the inference gateway, on the same house key. Unmetered
	// here for the same reason inference is: this host composes no billing, so
	// there is no Autumn policy to attach. Mounting it is what keeps a `star`
	// transcription working against `dev:bun`; the Worker is the only hosted
	// artifact, and it meters both gateways.
	mountTranscriptionApp(app, { auth: resource('api', 'ai') });
	mountPersonalAuthorityBlobs(app, {
		auth: {
			read: resource('git', 'folders:read'),
			write: resource('git', 'folders:write'),
		},
		resolveStore: resolveDeploymentBlobStore,
	});

	const server = Bun.serve({
		port,
		// Bun calls `fetch(req, server)`; route everything through the Hono app with
		// the validated env as `c.env`. WebSocket upgrades are never intercepted
		// ahead of the auth pipeline here.
		fetch: (req) => app.fetch(req, env),
	});

	// Nothing durable to close here any more: the store lives in the client
	// (ADR-0223) and the authority is a Durable Object, so this process owns no
	// database whose WAL has to be checkpointed.
	const shutdown = () => {
		void server.stop(true);
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	console.log(`apps/api (Bun) listening on ${origin}`);
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startBunApiServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) await startBunApiServer();

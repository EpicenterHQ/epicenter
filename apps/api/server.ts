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
 * auth layer, the inference/blobs mounts, `Bun.serve`) is this app's
 * composition to own. The library ships the parts.
 *
 * Runtime skew is fenced by design: Worker-only behavior (Hyperdrive,
 * Artifacts, edge placement) will not surface here, so `wrangler dev` /
 * staging stays the fidelity gate before any deploy touching runtime behavior.
 *
 * The authorization server's pages (sign-in, consent, device) are the built
 * `apps/api/ui`, as on the Worker: this entry serves its `fallback.html`
 * for those URLs and its `/_app/*` files ({@link uiPages}), so sign-in
 * completes on a self-hosted server.
 *
 * Two surfaces the Worker serves are intentionally absent here, and
 * `runtime-profile.test.ts` is where that list is declared and checked against
 * both entries: the dashboard SPA needs the Worker-only `ASSETS` binding, and
 * billing is the hosted Worker's concern. Everything the shared library can
 * mount on both runtimes is mounted on both.
 */

import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
	API_BUN_DEV_PORT,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import {
	CloudAuthBindings,
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createDiskGitHost,
	createServerApp,
	mountAuthRoutes,
	mountGitHost,
	mountInferenceApp,
	mountMcpServer,
	mountPersonalAuthorityBlobs,
	mountTranscriptionApp,
	nodeClientMetadataFetch,
	type OAuthScope,
	registerFirstPartyClients,
	requireAccessToken,
	ServerBindings,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import type { Context } from 'hono';
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
	// Where hosted Git keeps its bare repositories. Unset, Git answers 503.
	'GIT_STORE_ROOT?': 'string',
	// The built authorization pages (`apps/api/ui`'s `build`), by default
	// beside this file at `ui/build`.
	'API_UI_DIR?': 'string',
	GOOGLE_CLIENT_ID: 'string',
	GOOGLE_CLIENT_SECRET: 'string',
	GITHUB_CLIENT_ID: 'string',
	GITHUB_CLIENT_SECRET: 'string',
	MICROSOFT_CLIENT_ID: 'string',
	MICROSOFT_CLIENT_SECRET: 'string',
});

/**
 * The built authorization pages in `dir`, served as the Worker's asset layer
 * serves them: `fallback.html` as the shell of each page, and the files under
 * `_app/`, which never leave that directory. Unbuilt, the shell answers 503
 * with the command that builds it.
 */
function uiPages(dir: string) {
	const assets = resolve(dir, '_app');
	const isFile = (path: string) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	return {
		shell: () => {
			const shell = resolve(dir, 'fallback.html');
			if (!isFile(shell))
				return new Response(
					`The sign-in pages are not built in ${dir}. Run \`bun run --cwd apps/api/ui build\`, or set API_UI_DIR to the built pages.`,
					{
						status: 503,
						headers: { 'Content-Type': 'text/plain; charset=utf-8' },
					},
				);
			return new Response(Bun.file(shell), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		},
		asset: (c: Context) => {
			let path: string;
			try {
				path = resolve(
					dir,
					`.${decodeURIComponent(new URL(c.req.url).pathname)}`,
				);
			} catch {
				return c.notFound();
			}
			if (!path.startsWith(`${assets}${sep}`) || !isFile(path))
				return c.notFound();
			return new Response(Bun.file(path), {
				headers: {
					// SvelteKit names every file under `immutable/` by its content.
					'Cache-Control': path.includes(`${sep}immutable${sep}`)
						? 'public, max-age=31536000, immutable'
						: 'no-cache',
				},
			});
		},
	};
}

/**
 * Boot the apps/api Bun server: every resource takes OAuth access tokens
 * (ADR-0549). `runtime-profile.test.ts` boots it in process.
 */
export async function startBunApiServer(): Promise<void> {
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

	// This process serves its own origin, so it writes the first-party clients
	// and resources for that origin once, at boot (ADR-0549, ADR-0326). The
	// Worker writes the hosted ones once per isolate.
	const audiences = resolveOAuthAudiences(origin);
	await registerFirstPartyClients(db, {
		audiences,
		clients: buildFirstPartyClients(origin),
	});

	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: buildEpicenterTrustedOrigins,
	});

	const ui = uiPages(env.API_UI_DIR ?? resolve(import.meta.dir, 'ui', 'build'));
	app.get('/_app/*', ui.asset);

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
		serveAuthUiShell: ui.shell,
		resolveAudiences: () => audiences,
	});
	// Every resource takes only an access token for its audience and the scope
	// its operation needs (ADR-0549).
	const resource = (audience: 'api' | 'git', scope: OAuthScope) =>
		every(
			cloudContext,
			requireAccessToken({ audience: () => audiences[audience], scope }),
		);
	// Hosted Git (ADR-0546) keeps bare repositories on disk under
	// GIT_STORE_ROOT, served by `git http-backend`. Unset, the routes stay in
	// the shared profile and answer 503 `git_unavailable`.
	const gitHost = env.GIT_STORE_ROOT
		? createDiskGitHost({ root: env.GIT_STORE_ROOT })
		: null;
	mountGitHost(app, {
		setup: cloudContext,
		resolveAudiences: () => audiences,
		resolveHost: () => gitHost,
	});
	// The folder MCP server at `<origin>/mcp` (ADR-0550) reads and commits
	// through the same store; without one it answers 503.
	mountMcpServer(app, {
		setup: cloudContext,
		resolveAudiences: () => audiences,
		resolveHost: () => gitHost,
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
	});

	const server = Bun.serve({
		port,
		// Bun calls `fetch(req, server)`; route everything through the Hono app with
		// the validated env as `c.env`.
		fetch: (req) => app.fetch(req, env),
	});

	// Nothing local needs a checkpoint: Postgres is a separate server, and the
	// pool's connections close with the process.
	const shutdown = () => {
		void server.stop(true);
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	console.log(`apps/api (Bun) listening on ${origin}`);
}

// Listen only when this file is the entrypoint, not when a test imports it.
if (import.meta.main) await startBunApiServer();

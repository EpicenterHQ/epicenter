/**
 * Bun entry for apps/self-host: the single-partition instance (ADR-0075).
 *
 * The off-Cloudflare twin of `worker/index.ts`, and the instance's peer to the
 * hosted cloud's own Bun bootstrap (`apps/api/server.ts`). Each Bun entry owns
 * its composition rather than sharing a launcher: this one is bearer-only with no
 * relational-auth substrate (no Better Auth, no cookie sessions), so a shared
 * factory would re-introduce the mode knob ADR-0075/0076 deleted. It composes no
 * Postgres (no Better Auth, no telemetry), so it installs no runtime adapter leg
 * at all (ADR-0066).
 *
 * This is the "one binary, no Cloudflare account, no database" instance artifact:
 * `bun server.ts` (or a `bun build --compile` binary) is a complete box on a
 * single node. It owns no application data: the client does. The current
 * reference instance does not mount store sync, so two devices do not converge
 * through it yet.
 *
 * There is ONE shape, not a mode (ADR-0075). Every request resolves to the pinned
 * `principals/instance` partition. Authentication is one operator-supplied static bearer
 * (`INSTANCE_TOKEN`), constant-time compared. "Solo" and "shared" are not
 * configurations: they are only how many people you hand the one token to. No
 * OAuth, no sessions, no allowlist, no mode, no first-boot minting. Multi-tenant
 * per-user partitions are Epicenter Cloud's, never an instance's.
 *
 * Boot FAILS CLOSED if `INSTANCE_TOKEN` is missing or fails the entropy gate, with
 * an error that points at `gen-token`: the operator generates the token once
 * (`bun run gen-token`) and supplies it through the environment, never a file the
 * box mints. That gate replaces the 256-bit floor minting used to guarantee while
 * keeping the instance Bun-or-Cloudflare (the operator supplies the secret either
 * way).
 *
 * Surface: session + inference + transcription + blobs behind the operator bearer, zero
 * billing, no dashboard SPA, no auth surface. The blob store is a portable
 * content-addressed media store over any S3 (your own MinIO/Garage/R2); it is
 * mounted by default and answers 503 until `BLOBS_S3_*` is set, exactly as the
 * inference gateway answers 503 until a provider house key is set. Owning your
 * own media on your own bucket is squarely the instance's purpose; configure
 * `BLOBS_S3_*` to turn it on, or leave it unconfigured to run without object
 * storage.
 */

import { assertStrongToken } from '@epicenter/auth';
import {
	createEnvTokenResolver,
	createServerApp,
	mountBlobsApp,
	mountInferenceApp,
	mountSessionApp,
	mountTranscriptionApp,
	rateLimit,
	requireBearerPrincipal,
	ServerBindings,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import { resolveSelfHostTrustedOrigins } from './trusted-origins.js';

/**
 * The instance's Bun env contract: the portable {@link ServerBindings} (the
 * cloud-only secrets stay optional and unused here) plus this host's process
 * config and its one bearer. There is deliberately NO `DATABASE_URL` and no
 * `BETTER_AUTH_SECRET`: the instance composes no Postgres and no Better Auth
 * (ADR-0075). `INSTANCE_TOKEN` is optional in the schema (so the arktype pass
 * never duplicates the entropy gate's message) and asserted strong below.
 */
const InstanceBindings = ServerBindings.merge({
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'TRUSTED_BROWSER_ORIGINS?': 'string',
	'INSTANCE_TOKEN?': 'string',
});

/**
 * Resolve the operator-supplied `INSTANCE_TOKEN` or fail closed, naming the
 * generator. The library gate ({@link assertStrongToken}) owns the portable
 * length/charset rule; this wrapper owns the exit and names the concrete command,
 * so the operator is never left guessing how to mint a strong token.
 * `process.exit` returns `never`, so a successful call returns the strong token.
 */
function requireStrongInstanceToken(value: string | undefined): string {
	try {
		return assertStrongToken(value);
	} catch (e) {
		console.error(
			`Invalid configuration for the self-host instance:\n  ${(e as Error).message}\n` +
				'  Generate a strong token with: bun run gen-token',
		);
		process.exit(1);
	}
}

/** Boot the apps/self-host instance: validate env, build the bearer gate, listen. */
export function startSelfHostServer(): void {
	// Validate this host's environment once, at boot (ADR-0066) against
	// {@link InstanceBindings}. A misconfiguration gets ONE descriptive error
	// naming every missing or malformed var. The validated result IS the typed env
	// handed to the Hono app: no `as`-cast over `process.env`, no lie.
	const env = InstanceBindings(process.env);
	if (env instanceof type.errors) {
		console.error(
			`Invalid environment for the self-host instance:\n${env.summary}`,
		);
		process.exit(1);
	}

	// The bearer gate. A strong `INSTANCE_TOKEN` builds the env-token resolver
	// (constant-time compare -> the instance principal); a missing or weak
	// token fails boot above. Every protected surface closes its bearer wrapper
	// over that one resolver, the same total gate the cloud builds from its OAuth
	// resolver (ADR-0075).
	const token = requireStrongInstanceToken(env.INSTANCE_TOKEN);
	const resolveBearerPrincipal = createEnvTokenResolver(token);
	const auth = requireBearerPrincipal(resolveBearerPrincipal);

	const port = Number(env.PORT ?? 8787);
	// The auth origin must match where the process actually listens. Default to
	// localhost; an operator overrides it with their own domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;
	// Resolve the CORS trust set once, at boot, beside the origin it extends: a
	// malformed `TRUSTED_BROWSER_ORIGINS` must refuse to start, not throw on
	// every request. (The Worker entry has no boot, so it resolves per request
	// from the same function.)
	const trustedOrigins = resolveSelfHostTrustedOrigins(
		origin,
		env.TRUSTED_BROWSER_ORIGINS,
	);

	const app = createServerApp({
		// The instance composes no Postgres (no Better Auth), so it never calls
		// `createCloudContextMiddleware` and `createServerApp` stays on the portable `Env`: `c.var.db`
		// is never set (ADR-0076).
		resolveOrigin: () => origin,
		// A self-host trusts its OWN origin, the Tauri desktop client, and any
		// exact browser origins the operator configured, never Epicenter
		// cloud's. Resolved at boot above, from the same function
		// `worker/index.ts` calls, so the two runtimes cannot drift.
		resolveTrustedOrigins: () => trustedOrigins,
	});

	app.get('/', (c) =>
		c.json({ product: 'instance', version: '0.1.0', runtime: 'bun' }),
	);
	// No `createCloudContextMiddleware`: the instance composes no Better Auth and no sessions. The
	// operator bearer (`auth` above) is the only gate, so every surface is
	// bearer-authenticated (ADR-0075).
	mountSessionApp(app, { auth });
	// Inference spends the operator's house key on every request. Cap the burn
	// rate so a leaked or overused bearer cannot run the provider bill up
	// unbounded between invoices. This is the in-process backstop; the real
	// ceiling is the hard spend limit you set on the provider key itself (README).
	// Tune to your group's size, or drop the policy to leave it uncapped.
	mountInferenceApp(app, {
		auth,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});
	// The STT sibling of the inference gateway: same operator house key, same
	// 503-until-configured opt-out, same burn-rate cap. Mounted with no Autumn
	// policy, so a `star` transcription against this instance is unmetered (the
	// operator's provider bill is the only cost). This is what makes "transcribe
	// through the star you're connected to" true on self-host, not just hosted.
	mountTranscriptionApp(app, {
		auth,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});
	// Content-addressed media store over any S3, mounted by default; it answers 503
	// until `BLOBS_S3_*` is set (the same honest opt-out as inference's house key).
	// Storage is the operator's own bucket, so there is no house key to burn and no
	// rate-limit policy here.
	mountBlobsApp(app, { auth });

	const server = Bun.serve({
		port,
		fetch: (req) => app.fetch(req, env),
	});

	const shutdown = () => {
		void server.stop(true);
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	console.log(
		`apps/self-host instance (Bun) listening on ${origin} ` +
			`(partition principals/instance). Hand INSTANCE_TOKEN to ` +
			'whoever should have access.',
	);
}

// Run only when this file is the entrypoint.
if (import.meta.main) startSelfHostServer();

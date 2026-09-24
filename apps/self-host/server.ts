/** Bun self-hosting uses the same admitted users, passkeys and sessions as Worker. */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { asPrincipalId } from '@epicenter/principal';
import {
	createServerApp,
	mountPersonalAuthorityBlobs,
	mountInferenceApp,
	mountSessionApp,
	mountTranscriptionApp,
	OAuthError,
	type ResolveBearerPrincipal,
	rateLimit,
	requireBearerPrincipal,
	ServerBindings,
} from '@epicenter/server/bun';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';
import { type } from 'arktype';
import { signInPage, signInScript } from './sign-in.js';
import { resolveSelfHostTrustedOrigins } from './trusted-origins.js';

const InstanceBindings = ServerBindings.merge({
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'TRUSTED_BROWSER_ORIGINS?': 'string',
	'SELF_HOST_CALLBACKS?': 'string',
	'AUTH_DB_PATH?': 'string',
});

export function startSelfHostServer(): void {
	const env = InstanceBindings(process.env);
	if (env instanceof type.errors)
		throw new Error(`Invalid self-host configuration: ${env.summary}`);
	const port = Number(env.PORT ?? 8787);
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;
	const callbacks: unknown = JSON.parse(env.SELF_HOST_CALLBACKS ?? '[]');
	if (
		!Array.isArray(callbacks) ||
		!callbacks.every((value): value is string => typeof value === 'string')
	)
		throw new Error(
			'SELF_HOST_CALLBACKS must be a JSON array of callback URLs',
		);
	const path = resolve(
		import.meta.dir,
		env.AUTH_DB_PATH ?? './data/auth.sqlite',
	);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const authentication = openSelfHostAuth({ path, origin, callbacks });
	const trustedOrigins = resolveSelfHostTrustedOrigins(
		origin,
		env.TRUSTED_BROWSER_ORIGINS,
	);
	const app = createServerApp({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => trustedOrigins,
	});
	const resolveBearerPrincipal: ResolveBearerPrincipal = async (_c, bearer) => {
		try {
			const session = await authentication.auth.resolveSession(bearer);
			return session
				? { data: { id: asPrincipalId(session.userId) }, error: null }
				: OAuthError.InvalidToken();
		} catch {
			return OAuthError.ServerError();
		}
	};
	const auth = requireBearerPrincipal(resolveBearerPrincipal);
	app.get('/', (c) => c.json({ product: 'self-host', runtime: 'bun' }));
	app.get('/sign-in', () => signInPage());
	app.get('/auth/sign-in.js', () => signInScript());
	app.all('/auth/*', (c) => authentication.auth.handle(c.req.raw));
	mountSessionApp(app, { auth });
	mountInferenceApp(app, {
		auth,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});
	mountTranscriptionApp(app, {
		auth,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});
	mountPersonalAuthorityBlobs(app, { auth });
	const requests = new Set<Promise<Response>>();
	let closing: Promise<void> | undefined;
	const server = Bun.serve({
		port,
		fetch(request) {
			if (closing) return new Response('Server is stopping', { status: 503 });
			const response = Promise.resolve(app.fetch(request, env));
			requests.add(response);
			return response.finally(() => requests.delete(response));
		},
	});
	const shutdown = () => {
		closing ??= (async () => {
			await server.stop(true);
			// Closing sockets does not stop WebAuthn verification already awaiting crypto.
			await Promise.allSettled(requests);
			authentication.close();
		})();
		return closing;
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	console.log(`Self-host listening on ${origin}. Auth database: ${path}`);
}
if (import.meta.main) startSelfHostServer();

/** Bun self-hosting uses the same admitted users, passkeys and sessions as Worker. */
import { mkdirSync } from 'node:fs';
import { asPrincipalId } from '@epicenter/principal';
import {
	createServerApp,
	mountInferenceApp,
	mountPersonalAuthorityBlobs,
	mountSessionApp,
	mountStoreSyncApp,
	mountTranscriptionApp,
	OAuthError,
	openBunStoreSync,
	openLocalBlobStore,
	type ResolveBearerPrincipal,
	rateLimit,
	requireBearerPrincipal,
	resolveDeploymentBlobStore,
	ServerBindings,
} from '@epicenter/server/bun';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';
import { type } from 'arktype';
import { selfHostDataPaths } from './data-root.js';
import { acquireDataRootOwner } from './data-root-owner.js';
import { signInPage, signInScript } from './sign-in.js';
import { resolveSelfHostTrustedOrigins } from './trusted-origins.js';

const InstanceBindings = ServerBindings.merge({
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'TRUSTED_BROWSER_ORIGINS?': 'string',
	'SELF_HOST_CALLBACKS?': 'string',
	'SELF_HOST_DATA_ROOT?': 'string',
	'BLOBS_BACKEND?': '"local" | "s3"',
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
	const s3Blobs =
		env.BLOBS_BACKEND === 's3' ? resolveDeploymentBlobStore(env) : null;
	if (env.BLOBS_BACKEND === 's3' && !s3Blobs)
		throw new Error(
			'BLOBS_BACKEND=s3 requires BLOBS_S3_ENDPOINT and credentials',
		);
	const paths = selfHostDataPaths(env.SELF_HOST_DATA_ROOT);
	mkdirSync(paths.root, { recursive: true, mode: 0o700 });
	const releaseDataRoot = acquireDataRootOwner(paths.root);
	const authentication = openSelfHostAuth({
		path: paths.auth,
		origin,
		callbacks,
	});
	const sync = openBunStoreSync(paths.sync);
	const localBlobs =
		env.BLOBS_BACKEND === 's3' ? null : openLocalBlobStore(paths.blobs);
	const blobStore = s3Blobs ?? localBlobs!.store;
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
	mountStoreSyncApp(app, {
		resolveBearerPrincipal,
		resolveStore: sync.resolveStore,
		upgrade: sync.upgrade,
	});
	mountInferenceApp(app, {
		auth,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});
	mountTranscriptionApp(app, {
		auth,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});
	mountPersonalAuthorityBlobs(app, { auth, resolveStore: () => blobStore });
	const requests = new Set<Promise<Response>>();
	let closing: Promise<void> | undefined;
	const server = Bun.serve<{
		name: string;
		generation: number;
		cursor: number;
		authorizedUntil: number;
	}>({
		port,
		async fetch(request, server) {
			if (closing) return new Response('Server is stopping', { status: 503 });
			const response = Promise.resolve(app.fetch(request, env));
			requests.add(response);
			try {
				const result = await response;
				const name = result.headers.get('x-epicenter-bun-upgrade');
				if (name) {
					const query = new URL(request.url).searchParams;
					const offered = request.headers.get('sec-websocket-protocol') ?? '';
					const upgraded = server.upgrade(request, {
						data: {
							name,
							generation: Number(query.get('generation')),
							cursor: Number(query.get('cursor') ?? '0'),
							authorizedUntil: Date.now() + 600_000,
						},
						headers: offered
							? { 'sec-websocket-protocol': 'epicenter' }
							: undefined,
					});
					return upgraded
						? undefined
						: new Response('WebSocket upgrade failed', { status: 500 });
				}
				return result;
			} finally {
				requests.delete(response);
			}
		},
		websocket: {
			open(socket) {
				sync.connect(socket);
			},
			message(socket, message) {
				sync.receive(socket, message);
			},
			close(socket) {
				sync.leave(socket);
			},
		},
	});
	const shutdown = () => {
		closing ??= (async () => {
			server.stop(true);
			// Closing sockets does not stop WebAuthn verification already awaiting crypto.
			await Promise.allSettled(requests);
			sync.close();
			localBlobs?.close();
			authentication.close();
			releaseDataRoot();
		})();
		return closing;
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	console.log(`Self-host listening on ${origin}. Data root: ${paths.root}`);
}
if (import.meta.main) startSelfHostServer();

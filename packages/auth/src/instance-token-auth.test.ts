import { describe, expect, test } from 'bun:test';
import { asPrincipalId, INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync/auth-subprotocol';
import type {
	AuthFetch,
	InstanceConnectionStatus,
	SyncAuthClient,
} from './auth-contract.js';
import { createInstanceTokenAuth } from './instance-token-auth.js';

const baseURL = 'http://localhost:8788';
const token = 'dev:principal-1';

function sessionBody(principalId = 'principal-1') {
	return {
		principalId,
		email: `${principalId}@example.com`,
	};
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Let the construction-time `/api/session` check settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Narrow to the self-hosted deployment's connection channel. */
function connection(auth: SyncAuthClient) {
	if (auth.deployment.kind !== 'self-hosted') {
		throw new Error('expected a self-hosted deployment');
	}
	return auth.deployment.connection;
}

describe('createInstanceTokenAuth', () => {
	test('boots signed-in from /api/session 200 with the instance bearer', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });

		// Optimistic boot: signed-in as the instance principal before the async
		// check resolves, so local data can open synchronously.
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});
		await flush();

		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: asPrincipalId('principal-1'),
		});
		expect(calls[0]?.url).toBe(`${baseURL}/api/session`);
		expect(calls[0]?.init?.credentials).toBe('omit');
		expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
			`Bearer ${token}`,
		);
	});

	test('a real instance (instance principal) sees no principal change across boot', async () => {
		// The self-host box resolves every valid bearer to INSTANCE_PRINCIPAL_ID
		// (ADR-0075), so the optimistic boot identity and the verified identity
		// match: no `signed-out -> instance` transition can restart consumers or
		// redirect already-attached work during boot.
		const seen: string[] = [];
		const fetch: AuthFetch = async () => json(sessionBody('instance'));
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		auth.onStateChange((s) =>
			seen.push(s.status === 'signed-out' ? 'signed-out' : s.principalId),
		);

		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});
		await flush();
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});
		// The principal id never left `instance`, so nothing a reload key watches changed.
		expect(seen.every((p) => p === INSTANCE_PRINCIPAL_ID)).toBe(true);
	});

	test('boots signed-out when /api/session rejects the token (401)', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');
	});

	test('fetch attaches the bearer to the instance origin and resolves relative paths', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		await auth.fetch('/api/blobs');
		const blobs = calls.at(-1);
		expect(blobs?.url).toBe(`${baseURL}/api/blobs`);
		expect(blobs?.init?.credentials).toBe('omit');
		expect(new Headers(blobs?.init?.headers).get('authorization')).toBe(
			`Bearer ${token}`,
		);
	});

	test('fetch never attaches the bearer to a different origin (audience scoping)', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		await auth.fetch('https://someone-elses-inference.example.com/v1/models');
		const cross = calls.at(-1);
		expect(cross?.url).toBe(
			'https://someone-elses-inference.example.com/v1/models',
		);
		expect(new Headers(cross?.init?.headers).has('authorization')).toBe(false);
	});

	test('a 401 on a resource call moves a signed-in client to signed-out', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');

		await auth.fetch('/api/blobs');
		expect(auth.state.status).toBe('signed-out');
	});

	test('openWebSocket carries the bearer as an Epicenter subprotocol', async () => {
		const wsCalls: Array<{ url: string; protocols: string[] }> = [];
		class FakeWebSocket {
			constructor(url: string, protocols: string[]) {
				wsCalls.push({ url, protocols });
			}
		}
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({
			baseURL,
			token,
			fetch,
			WebSocket: FakeWebSocket as unknown as typeof WebSocket,
		});
		await flush();

		await auth.openWebSocket(
			'ws://localhost:8788/api/sync/v1/records/chat/conversations/r/document',
			['existing-protocol'],
		);
		expect(wsCalls.at(-1)).toEqual({
			url: 'ws://localhost:8788/api/sync/v1/records/chat/conversations/r/document',
			protocols: ['existing-protocol', `${BEARER_SUBPROTOCOL_PREFIX}${token}`],
		});
	});

	test('signOut drops to signed-out locally without a server call', async () => {
		const calls: string[] = [];
		const fetch: AuthFetch = async (input) => {
			calls.push(String(input));
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');
		const callsBefore = calls.length;

		await auth.signOut();
		expect(auth.state.status).toBe('signed-out');
		expect(calls.length).toBe(callsBefore); // no revoke request
	});

	test('startSignIn re-verifies the token (retry after an offline boot)', async () => {
		let reachable = false;
		const fetch: AuthFetch = async () => {
			if (!reachable) throw new Error('offline');
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		// An unreachable instance leaves the optimistic identity: the self-hoster
		// keeps their local records available offline (the deployment's
		// connection channel, not `state`, carries the "unreachable" signal).
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: INSTANCE_PRINCIPAL_ID,
		});

		reachable = true;
		const { error } = await auth.startSignIn();
		expect(error).toBeNull();
		expect(auth.state).toEqual({
			status: 'signed-in',
			principalId: asPrincipalId('principal-1'),
		});
	});

	test('getProfile reads the user from /api/session with the bearer', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		const { data, error } = await auth.getProfile();
		expect(error).toBeNull();
		expect(data).toEqual({
			id: asPrincipalId('principal-1'),
			email: 'principal-1@example.com',
		});
	});

	test('deployment names the self-hosted instance', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		expect(auth.deployment.kind).toBe('self-hosted');
		expect(auth.deployment.baseURL).toBe(baseURL);
	});

	test('connection reports connecting at boot then connected on a 200', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		expect(connection(auth).status).toBe('connecting');
		await flush();
		expect(connection(auth).status).toBe('connected');
	});

	test('connection is rejected when the token is refused (401)', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');
		expect(connection(auth).status).toBe('rejected');
	});

	test('connection is unreachable when the instance is offline', async () => {
		const fetch: AuthFetch = async () => {
			throw new Error('offline');
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(connection(auth).status).toBe('unreachable');
	});

	test('connection notifies subscribers and recovers on a retry', async () => {
		let reachable = false;
		const fetch: AuthFetch = async () => {
			if (!reachable) throw new Error('offline');
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		const seen: InstanceConnectionStatus[] = [];
		connection(auth).onChange((s) => seen.push(s));
		await flush();
		expect(connection(auth).status).toBe('unreachable');

		reachable = true;
		await auth.startSignIn();
		expect(connection(auth).status).toBe('connected');
		// The retry moves connecting -> connected, both observed after subscribing.
		expect(seen).toContain('connecting');
		expect(seen).toContain('connected');
	});

	test('a 401 on a resource call marks the connection rejected', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(connection(auth).status).toBe('connected');

		await auth.fetch('/api/blobs');
		// A rejected token always drops `state` to signed-out, not just at boot: the
		// signed-in account UI relies on this coupling to skip rejected-token copy
		// (the sign-in panel owns it) and surface only `unreachable`.
		expect(auth.state.status).toBe('signed-out');
		expect(connection(auth).status).toBe('rejected');
	});
});

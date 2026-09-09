/**
 * The live-token manager between Gmail callers and the secret store.
 *
 * What is pinned here: a held access token is used without touching the token
 * endpoint, an expired one refreshes once and stores back whatever refresh
 * token is now current, concurrent callers share one grant, a failed grant does
 * not poison the next call, and a device holding no credential says so in the
 * words a person can act on.
 * Failed rotation writes remain retryable without losing the replacement
 * credential or exposing access before storage recovers.
 */

import { expect, test } from 'bun:test';
import { SecretError, type SecretStore, secretLabel } from '@epicenter/device';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { DEFAULT_MAIL_CONFIG, type MailConfig } from './config.ts';
import { openPassRecord, readOutbox } from './outbox.js';
import { openTestSession } from './session.test-support.js';
import { createTokenManager } from './token-manager.ts';

const IDENTITY = { clientId: 'client-id-123', clientSecret: 'client-secret' };
const ACCOUNT = secretLabel('account-row-id');
const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');

function config(overrides: Partial<MailConfig> = {}): MailConfig {
	return { ...DEFAULT_MAIL_CONFIG, ...overrides };
}

function secretStore(initial: string | null = 'old-refresh-token') {
	const writes: string[] = [];
	let held = initial;
	const secrets: SecretStore = {
		async get() {
			return Ok(held);
		},
		async put(_accountId, value) {
			held = value;
			writes.push(value);
			return Ok(undefined);
		},
		async delete() {
			held = null;
			return Ok(undefined);
		},
	};
	return { secrets, writes };
}

function tokenServer(
	handler: (request: Request) => Response | Promise<Response>,
) {
	return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
}

test('a held access token is used without touching the token endpoint', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		return Response.json({
			token_type: 'Bearer',
			access_token: 'first-access-token',
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	expect((await manager.getValidAccessToken()).data).toBe('first-access-token');
	expect((await manager.getValidAccessToken()).data).toBe('first-access-token');
	expect(requests).toBe(1);
	// Google returned no rotated token, so nothing was written back.
	expect(writes).toEqual([]);
	server.stop(true);
});

test('a rotated refresh token is stored back', async () => {
	const bodies: URLSearchParams[] = [];
	const server = tokenServer(async (request) => {
		bodies.push(new URLSearchParams(await request.text()));
		return Response.json({
			token_type: 'Bearer',
			access_token: 'new-access-token',
			refresh_token: 'new-refresh-token',
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const { data, error } = await manager.getValidAccessToken();
	expect(error).toBeNull();
	expect(data).toBe('new-access-token');
	expect(bodies[0]?.get('grant_type')).toBe('refresh_token');
	expect(bodies[0]?.get('refresh_token')).toBe('old-refresh-token');
	expect(writes).toEqual(['new-refresh-token']);
	server.stop(true);
});

test('concurrent callers share one refresh grant', async () => {
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const server = tokenServer(async () => {
		requests += 1;
		await release.promise;
		return Response.json({
			token_type: 'Bearer',
			access_token: 'shared-access-token',
			expires_in: 3600,
		});
	});
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const first = manager.getValidAccessToken();
	const second = manager.getValidAccessToken();
	while (requests === 0) await Bun.sleep(1);
	release.resolve();
	const [one, two] = await Promise.all([first, second]);

	expect(one.data).toBe('shared-access-token');
	expect(two.data).toBe('shared-access-token');
	expect(requests).toBe(1);
	server.stop(true);
});

test('a failed grant does not poison the next call', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		if (requests === 1) {
			return Response.json(
				{
					error: 'invalid_client',
					error_description: 'The OAuth client was not found.',
				},
				{ status: 401 },
			);
		}
		return Response.json({
			token_type: 'Bearer',
			access_token: 'retried-access-token',
			expires_in: 3600,
		});
	});
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const failed = await manager.getValidAccessToken();
	const retried = await manager.getValidAccessToken();

	expect(failed.error?.name).toBe('TokenExchangeFailed');
	expect(retried.data).toBe('retried-access-token');
	expect(requests).toBe(2);
	server.stop(true);
});

test('a revoked grant asks for re-consent rather than a retry', async () => {
	const server = tokenServer(() =>
		Response.json(
			{ error: 'invalid_grant', error_description: 'Token revoked.' },
			{ status: 400 },
		),
	);
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	expect((await manager.getValidAccessToken()).error?.name).toBe(
		'ReauthRequired',
	);
	server.stop(true);
});

test('a device holding no credential asks for the account again', async () => {
	// Reloading a browser page preserves the account record but replaces the
	// in-memory secret store with an empty one.
	const { secrets } = secretStore(null);
	const manager = createTokenManager({
		config: config(),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const error = expectErr(await manager.getValidAccessToken());
	expect(error.name).toBe('CredentialMissing');
	const session = await openTestSession();
	try {
		await session.passes.record({
			finishedAt: new Date(NOW()).toISOString(),
			discarded: [],
			failure: error,
		});
		const outbox = await readOutbox({
			...session,
			passes: openPassRecord(session.localDatabase, session.sub),
		});
		expect(outbox.status).toBe('signin');
		expect(outbox.lastPass?.failure).toEqual({
			kind: 'signin',
			name: 'CredentialMissing',
			message: error.message,
		});
	} finally {
		session.close();
	}
});

test('a failed credential read preserves the storage failure instead of claiming the credential is missing', async () => {
	const { secrets } = secretStore();
	const failed = SecretError.StorageFailed({ cause: 'Keychain is locked' });
	const manager = createTokenManager({
		config: config(),
		identity: IDENTITY,
		label: ACCOUNT,
		now: NOW,
		secrets: { ...secrets, get: async () => failed },
	});
	expect(expectErr(await manager.getValidAccessToken())).toEqual(
		expectErr(failed),
	);
});

test('a failed rotation stays retryable until the replacement credential is saved', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		return Response.json({
			token_type: 'Bearer',
			access_token: 'new-access',
			refresh_token: 'new-refresh',
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const failed = SecretError.StorageFailed({ cause: 'Keychain is locked' });
	let locked = true;
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		label: ACCOUNT,
		now: NOW,
		secrets: {
			...secrets,
			put: async (label, value) =>
				locked ? failed : secrets.put(label, value),
		},
	});
	const session = await openTestSession();
	try {
		for (const attempt of [
			() => manager.getValidAccessToken(),
			() => manager.getValidAccessToken(),
			() => manager.forceRefresh(),
		]) {
			const error = expectErr(await attempt());
			expect(error).toBe(expectErr(failed));
			await session.passes.record({
				finishedAt: new Date(NOW()).toISOString(),
				discarded: [],
				failure: error,
			});
			const outbox = await readOutbox({
				...session,
				passes: openPassRecord(session.localDatabase, session.sub),
			});
			expect(outbox.lastPass?.failure).toMatchObject({
				name: 'StorageFailed',
				kind: 'retry',
			});
		}
		expect(requests).toBe(1);
		expect(writes).toEqual([]);
		locked = false;
		expect(expectOk(await manager.getValidAccessToken())).toBe('new-access');
		expect(expectOk(await manager.getValidAccessToken())).toBe('new-access');
		expect(writes).toEqual(['new-refresh']);
		expect(requests).toBe(1);
	} finally {
		server.stop(true);
		session.close();
	}
});

test('ordinary and forced callers share a paused rotation save without returning cached access', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		return Response.json({
			token_type: 'Bearer',
			access_token: `access-${requests}`,
			...(requests === 1 ? {} : { refresh_token: 'rotated-refresh' }),
			expires_in: 3600,
		});
	});
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		label: ACCOUNT,
		now: NOW,
		secrets: {
			...secrets,
			async put(label, value) {
				started.resolve();
				await release.promise;
				return secrets.put(label, value);
			},
		},
	});
	try {
		expect(expectOk(await manager.getValidAccessToken())).toBe('access-1');
		const forced = manager.forceRefresh();
		await started.promise;
		let completed = false;
		const ordinary = manager.getValidAccessToken().then((result) => {
			completed = true;
			return result;
		});
		const alsoForced = manager.forceRefresh();
		await Bun.sleep(0);
		expect(completed).toBe(false);
		expect(writes).toEqual([]);
		release.resolve();
		for (const result of await Promise.all([forced, ordinary, alsoForced])) {
			expect(expectOk(result)).toBe('access-2');
		}
		expect(writes).toEqual(['rotated-refresh']);
		expect(requests).toBe(2);
	} finally {
		release.resolve();
		server.stop(true);
	}
});

test('a failed forced refresh never returns the previously rejected access token', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		return requests === 1
			? Response.json({
					token_type: 'Bearer',
					access_token: 'rejected-access',
					expires_in: 3600,
				})
			: Response.json({ error: 'invalid_grant' }, { status: 400 });
	});
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		label: ACCOUNT,
		now: NOW,
		secrets,
	});
	try {
		expect(expectOk(await manager.getValidAccessToken())).toBe(
			'rejected-access',
		);
		expect(expectErr(await manager.forceRefresh()).name).toBe('ReauthRequired');
		expect(expectErr(await manager.getValidAccessToken()).name).toBe(
			'ReauthRequired',
		);
		expect(requests).toBe(3);
	} finally {
		server.stop(true);
	}
});

test.each([
	'expired',
	'forced',
] as const)('%s access saves the pending credential before requesting a new grant', async (reason) => {
	const submitted: string[] = [];
	const { secrets, writes } = secretStore();
	const server = tokenServer(async (request) => {
		submitted.push(
			new URLSearchParams(await request.text()).get('refresh_token')!,
		);
		return Response.json({
			token_type: 'Bearer',
			access_token: `access-${submitted.length}`,
			refresh_token: 'rotated-refresh',
			expires_in: 3600,
		});
	});
	let locked = true;
	let now = NOW();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		label: ACCOUNT,
		now: () => now,
		secrets: {
			...secrets,
			put: async (label, value) =>
				locked
					? SecretError.StorageFailed({ cause: 'Keychain is locked' })
					: secrets.put(label, value),
		},
	});
	try {
		expect(expectErr(await manager.getValidAccessToken()).name).toBe(
			'StorageFailed',
		);
		locked = false;
		if (reason === 'expired') now += 3600_000;
		const result = await (reason === 'forced'
			? manager.forceRefresh()
			: manager.getValidAccessToken());
		expect(expectOk(result)).toBe('access-2');
		expect(writes).toEqual(['rotated-refresh']);
		expect(submitted).toEqual(['old-refresh-token', 'rotated-refresh']);
	} finally {
		server.stop(true);
	}
});

test.each([
	'replaced',
	'deleted',
] as const)('a %s credential supersedes a pending rotation', async (change) => {
	const submitted: string[] = [];
	const server = tokenServer(async (request) => {
		submitted.push(
			new URLSearchParams(await request.text()).get('refresh_token')!,
		);
		return Response.json({
			token_type: 'Bearer',
			access_token: `access-${submitted.length}`,
			...(submitted.length === 1 ? { refresh_token: 'unsaved-refresh' } : {}),
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		label: ACCOUNT,
		now: NOW,
		secrets: {
			...secrets,
			put: async () =>
				SecretError.StorageFailed({ cause: 'Keychain is locked' }),
		},
	});
	try {
		expect(expectErr(await manager.getValidAccessToken()).name).toBe(
			'StorageFailed',
		);
		if (change === 'replaced') {
			expectOk(await secrets.put(ACCOUNT, 'reconnected-refresh'));
			expect(expectOk(await manager.getValidAccessToken())).toBe('access-2');
			expect(submitted).toEqual(['old-refresh-token', 'reconnected-refresh']);
			expect(writes).toEqual(['reconnected-refresh']);
		} else {
			expectOk(await secrets.delete(ACCOUNT));
			expect(expectErr(await manager.getValidAccessToken()).name).toBe(
				'CredentialMissing',
			);
			expect(submitted).toEqual(['old-refresh-token']);
			expect(expectOk(await secrets.get(ACCOUNT))).toBeNull();
		}
	} finally {
		server.stop(true);
	}
});

test('a rotation write that landed despite an error is recognized on retry', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		return Response.json({
			token_type: 'Bearer',
			access_token: 'new-access',
			refresh_token: 'new-refresh',
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		label: ACCOUNT,
		now: NOW,
		secrets: {
			...secrets,
			async put(label, value) {
				expectOk(await secrets.put(label, value));
				return SecretError.StorageFailed({
					cause: 'Write acknowledgement lost',
				});
			},
		},
	});
	try {
		expect(expectErr(await manager.getValidAccessToken()).name).toBe(
			'StorageFailed',
		);
		expect(expectOk(await manager.getValidAccessToken())).toBe('new-access');
		expect(writes).toEqual(['new-refresh']);
		expect(requests).toBe(1);
	} finally {
		server.stop(true);
	}
});

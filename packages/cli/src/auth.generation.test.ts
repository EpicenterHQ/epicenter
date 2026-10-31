import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySecrets } from '@epicenter/ai/send';
import {
	accessToken,
	accountAccess,
	resolveDeployment,
	type StoredGrant,
} from './auth.ts';

const origin = 'https://api.example.test';
const deployment = resolveDeployment(origin);
const generation = '11111111-1111-4111-8111-111111111111';

const grant = (): StoredGrant => ({
	client: 'so.epicenter',
	generation,
	issuer: origin,
	refreshToken: 'refresh',
	scope: 'openid ai',
	account: { id: 'alice' },
	signedInAt: '2026-10-22T00:00:00.000Z',
	access: {
		[deployment.audiences.api]: {
			token: 'alice-api-token',
			expiresAt: Date.now() + 3_600_000,
		},
	},
});

test('a replaced sign-in cannot lend its cached token to an old Account', async () => {
	const secrets = createMemorySecrets();
	await secrets.set(`desktop ${origin}`, JSON.stringify(grant()));
	let networkCalls = 0;
	const result = await accessToken(
		{
			deployment,
			secrets,
			lockDir: join(tmpdir(), 'epicenter-auth-generation-unused'),
			fetch: async () => {
				networkCalls++;
				throw new Error('unexpected request');
			},
			now: Date.now,
		},
		'desktop',
		deployment.audiences.api,
		'22222222-2222-4222-8222-222222222222',
	);
	expect(result.error?.name).toBe('GrantChanged');
	expect(networkCalls).toBe(0);
});

test('the desktop sender refuses a target without a generation', async () => {
	let reads = 0;
	const access = accountAccess(
		{
			deployment,
			secrets: {
				async get() {
					reads++;
					return null;
				},
				async set() {},
				async delete() {
					return false;
				},
			},
			lockDir: join(tmpdir(), 'epicenter-auth-generation-unused'),
			fetch: async () => {
				throw new Error('unexpected request');
			},
			now: Date.now,
		},
		'desktop',
	);
	const result = await access('api');
	expect(result.error?.name).toBe('GrantChanged');
	expect(reads).toBe(0);
});

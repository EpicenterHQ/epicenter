import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySecrets } from '@epicenter/ai/send';
import {
	accessToken,
	accountAccess,
	authStatus,
	resolveDeployment,
	type StoredGrant,
} from './auth.ts';

const origin = 'https://api.example.test';
const deployment = resolveDeployment(origin);
const generation = '11111111-1111-4111-8111-111111111111';

const grant = (): StoredGrant => ({
	client: 'so.epicenter',
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
	await secrets.set(
		`desktop ${origin}`,
		JSON.stringify({ ...grant(), generation }),
	);
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

test('status upgrades one legacy desktop grant and keeps its generation', async () => {
	const lockDir = await mkdtemp(join(tmpdir(), 'epicenter-auth-generation-'));
	try {
		const secrets = createMemorySecrets();
		await secrets.set(`desktop ${origin}`, JSON.stringify(grant()));
		const ctx = {
			deployment,
			secrets,
			lockDir,
			fetch: async () => {
				throw new Error('unexpected request');
			},
			now: Date.now,
		};
		const first = await authStatus(ctx);
		const desktop = first.data?.find((item) => item.grant === 'desktop');
		expect(desktop?.signedIn).toBe(true);
		if (!desktop?.signedIn) throw new Error('desktop grant missing');
		expect(desktop.generation).toMatch(/^[0-9a-f-]{36}$/);
		const second = await authStatus(ctx);
		expect(second.data?.find((item) => item.grant === 'desktop')).toMatchObject(
			{
				generation: desktop.generation,
			},
		);
		expect(JSON.parse((await secrets.get(`desktop ${origin}`))!)).toMatchObject(
			{
				generation: desktop.generation,
			},
		);
	} finally {
		await rm(lockDir, { recursive: true, force: true });
	}
});

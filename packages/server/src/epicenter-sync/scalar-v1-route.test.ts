import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import { openScalarAuthorityV1 } from './authority-v1.js';
import { authorityV1TestLimits } from './authority-v1-cases.test-support.js';
import {
	createScalarV1App,
	SCALAR_V1_FACTS_PATH,
	SCALAR_V1_SUBMISSIONS_PATH,
} from './scalar-v1-route.js';

const LIFETIME = 'lifetime-one';
const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function setup(rawSubmissionBytes = 262144) {
	const raw = new Database(':memory:', { strict: true });
	const limits = authorityV1TestLimits();
	const authority = openScalarAuthorityV1({
		database: createBunSqliteAdapter(raw),
		limits,
		initialize: { authorityLifetime: LIFETIME },
	});
	const principals: PrincipalId[] = [];
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('principal', {
			id: asPrincipalId(c.req.header('x-test-principal') ?? 'alice'),
		});
		await next();
	});
	app.route(
		'/',
		createScalarV1App({
			limits,
			rawSubmissionBytes,
			locateAuthority(principalId) {
				principals.push(principalId);
				return authority;
			},
		}),
	);
	return { app, limits, principals, close: () => raw.close() };
}

function submission(submissionNumber = 1) {
	return {
		authorityLifetime: LIFETIME,
		replicaId: REPLICA,
		submissionNumber,
		intents: [{ address: ADDRESS, op: 'replace' as const, value: 'hello' }],
	};
}

describe('scalar V1 HTTP routes', () => {
	test('submits intents and then reads facts for the authenticated principal', async () => {
		const context = setup();
		try {
			const submitted = await context.app.request(SCALAR_V1_SUBMISSIONS_PATH, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-test-principal': 'bob',
				},
				body: JSON.stringify(submission()),
			});
			expect(submitted.status).toBe(200);
			expect((await submitted.json()) as unknown).toMatchObject({
				authorityLifetime: LIFETIME,
				facts: [{ sequence: 1, state: 'live', payload: 'hello' }],
				parked: [],
			});

			const facts = await context.app.request(
				`${SCALAR_V1_FACTS_PATH}?authorityLifetime=${LIFETIME}&afterSequence=0`,
				{ headers: { 'x-test-principal': 'bob' } },
			);
			expect(facts.status).toBe(200);
			expect((await facts.json()) as unknown).toMatchObject({
				authorityLifetime: LIFETIME,
				facts: [{ sequence: 1, state: 'live', payload: 'hello' }],
				hasMore: false,
			});
			expect(context.principals).toEqual([
				asPrincipalId('bob'),
				asPrincipalId('bob'),
			]);
		} finally {
			context.close();
		}
	});

	test('rejects malformed, duplicate, and noncanonical facts queries before lookup', async () => {
		const context = setup();
		try {
			for (const query of [
				'',
				'?afterSequence=01',
				'?afterSequence=0&afterSequence=1',
				'?afterSequence=0&extra=x',
				'?afterSequence=1',
			]) {
				const response = await context.app.request(
					`${SCALAR_V1_FACTS_PATH}${query}`,
				);
				expect(response.status).toBe(400);
			}
			expect(context.principals).toEqual([]);
		} finally {
			context.close();
		}
	});

	test('rejects malformed and oversized bodies before authority lookup', async () => {
		const context = setup(64);
		try {
			const malformed = await context.app.request(SCALAR_V1_SUBMISSIONS_PATH, {
				method: 'POST',
				body: '{',
			});
			expect(malformed.status).toBe(400);

			const oversized = await context.app.request(SCALAR_V1_SUBMISSIONS_PATH, {
				method: 'POST',
				body: JSON.stringify(submission()),
			});
			expect(oversized.status).toBe(413);

			const declaredOversized = await context.app.request(
				SCALAR_V1_SUBMISSIONS_PATH,
				{
					method: 'POST',
					headers: { 'content-length': '65' },
					body: '{}',
				},
			);
			expect(declaredOversized.status).toBe(413);
			expect(context.principals).toEqual([]);
		} finally {
			context.close();
		}
	});

	test('maps semantic authority refusals to stable conflict responses', async () => {
		const context = setup();
		try {
			const gap = await context.app.request(SCALAR_V1_SUBMISSIONS_PATH, {
				method: 'POST',
				body: JSON.stringify(submission(2)),
			});
			expect(gap.status).toBe(409);
			expect((await gap.json()) as unknown).toEqual({
				error: 'submission-gap',
				expectedSubmissionNumber: 1,
			});

			const mismatch = await context.app.request(
				`${SCALAR_V1_FACTS_PATH}?authorityLifetime=lifetime-two&afterSequence=0`,
			);
			expect(mismatch.status).toBe(409);
			expect((await mismatch.json()) as unknown).toEqual({
				error: 'lifetime-mismatch',
				activeAuthorityLifetime: LIFETIME,
			});
		} finally {
			context.close();
		}
	});
});

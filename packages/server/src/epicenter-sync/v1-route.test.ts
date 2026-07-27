/**
 * Scalar V1 HTTP Route Tests
 *
 * Drives the two wire operations end to end against the real SQLite authority,
 * so the route, the authority, and the kernel's admission agree on one contract
 * rather than on a mock's idea of one.
 *
 * Key behaviors:
 * - The two operations are separate routes with separate methods
 * - Every authority refusal keeps its own machine-readable code and status
 * - A non-integer or missing `afterSequence` never reaches the authority
 * - Malformed and oversized bodies never reach the authority
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import {
	type Intent,
	parseFactsResponse,
	parseSubmissionResponse,
	type ScalarSyncLimits,
	validateLimits,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import type { Env } from '../types.js';
import { openEpicenterSyncV1Authority } from './v1-authority.js';
import { createEpicenterSyncV1App } from './v1-route.js';

const LIFETIME = 'authority-lifetime';
const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.tests';

const limits = expectOk(
	validateLimits({
		jsonDepth: 16,
		propertiesPerObject: 1024,
		maxNamespaceBytes: 128,
		maxTableKeyBytes: 64,
		maxValueKeyBytes: 64,
		maxLifetimeBytes: 64,
		maxFieldKeyBytes: 128,
		maxUnsetKeysPerIntent: 64,
		maxEncodedFactBytes: 4096,
		maxFactsResponseBytes: 262144,
		maxSubmissionBytes: 262144,
		maxSubmissionResponseBytes: 1048576,
		maxSubmissionAddresses: 64,
	} satisfies ScalarSyncLimits),
);

const setValue = (valueName: string, content: string): Intent => ({
	address: { kind: 'value', namespace: NAMESPACE, valueName },
	presence: 'present',
	content,
});

function setup() {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncV1Authority({
		database,
		limits,
		mintLifetime: () => LIFETIME,
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
		createEpicenterSyncV1App((principalId) => {
			principals.push(principalId);
			return authority;
		}),
	);
	return { app, raw, principals };
}

function submit(app: Hono<Env>, body: unknown) {
	return app.request('/api/sync/v1/submissions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

const submission = (submissionNumber: number, intents: Intent[]) => ({
	authorityLifetime: LIFETIME,
	replicaId: REPLICA,
	submissionNumber,
	intents,
});

test('a submission settles and the facts feed then returns it', async () => {
	const { app, raw } = setup();

	const settled = await submit(app, submission(1, [setValue('theme', 'dark')]));
	expect(settled.status).toBe(200);
	expectOk(parseSubmissionResponse(await settled.json(), limits));

	const facts = await app.request('/api/sync/v1/facts?afterSequence=0');
	expect(facts.status).toBe(200);
	const page = (await facts.json()) as unknown;
	expectOk(parseFactsResponse(page, limits));
	expect(page).toMatchObject({
		authorityLifetime: LIFETIME,
		hasMore: false,
		facts: [{ sequence: 1, presence: 'present', content: 'dark' }],
	});
	raw.close();
});

test('the facts operation resolves the authenticated principal', async () => {
	const { app, raw, principals } = setup();
	await app.request('/api/sync/v1/facts?afterSequence=0', {
		headers: { 'x-test-principal': 'bob' },
	});
	expect(principals.map(String)).toEqual(['bob']);
	raw.close();
});

test('the two operations do not answer each other’s method', async () => {
	const { app, raw } = setup();
	expect(
		(await app.request('/api/sync/v1/facts', { method: 'POST' })).status,
	).toBe(404);
	expect((await app.request('/api/sync/v1/submissions')).status).toBe(404);
	// The combined exchange this replaces is not served by the V1 app at all.
	expect(
		(await app.request('/api/sync/v1', { method: 'POST', body: '{}' })).status,
	).toBe(404);
	raw.close();
});

test('a non-integer or missing afterSequence is refused before the authority', async () => {
	const { app, raw, principals } = setup();
	for (const query of [
		'',
		'?afterSequence=',
		'?afterSequence=1.0',
		'?afterSequence=1e3',
		'?afterSequence=0x10',
		'?afterSequence=-1',
		'?afterSequence=+1',
	]) {
		const response = await app.request(`/api/sync/v1/facts${query}`);
		expect(response.status).toBe(400);
		expect((await response.json()) as unknown).toEqual({
			error: 'invalid-request',
		});
	}
	expect(principals).toHaveLength(0);
	raw.close();
});

test('a lifetime mismatch keeps its own code and reports the active lifetime', async () => {
	const { app, raw } = setup();
	const response = await app.request(
		'/api/sync/v1/facts?afterSequence=0&authorityLifetime=someone-else',
	);
	expect(response.status).toBe(409);
	expect((await response.json()) as unknown).toEqual({
		error: 'lifetime-mismatch',
		activeLifetime: LIFETIME,
	});
	raw.close();
});

test('an afterSequence past the authority is sequence-ahead, not invalid input', async () => {
	const { app, raw } = setup();
	const response = await app.request(
		`/api/sync/v1/facts?afterSequence=99&authorityLifetime=${LIFETIME}`,
	);
	expect(response.status).toBe(409);
	expect((await response.json()) as unknown).toEqual({
		error: 'sequence-ahead',
	});
	raw.close();
});

/**
 * ADR-0163 lets a replica omit the lifetime only when starting from zero. A
 * non-zero cursor with no lifetime is malformed, and must be refused as such
 * rather than reaching the authority and being diagnosed as a state conflict.
 */
test('a non-zero cursor without a lifetime is malformed, not a conflict', async () => {
	const { app, raw, principals } = setup();
	const response = await app.request('/api/sync/v1/facts?afterSequence=99');
	expect(response.status).toBe(400);
	expect((await response.json()) as unknown).toEqual({
		error: 'invalid-request',
	});
	// The cross-field rule is the protocol parser's, so the authority is still
	// consulted; what matters is that it never reports this as a conflict.
	expect(principals).toHaveLength(1);
	raw.close();
});

test('an exact retry settles again while a fork and a gap keep their codes', async () => {
	const { app, raw } = setup();
	const first = submission(1, [setValue('theme', 'dark')]);
	expect((await submit(app, first)).status).toBe(200);

	// Exact retry: same number, same intents.
	expect((await submit(app, first)).status).toBe(200);

	// Same number, different intents.
	const fork = await submit(app, submission(1, [setValue('theme', 'light')]));
	expect(fork.status).toBe(409);
	expect((await fork.json()) as unknown).toEqual({ error: 'submission-fork' });

	// A skipped number.
	const gap = await submit(app, submission(9, [setValue('theme', 'light')]));
	expect(gap.status).toBe(409);
	expect((await gap.json()) as unknown).toEqual({ error: 'submission-gap' });
	raw.close();
});

test('a malformed body never reaches the authority', async () => {
	const { app, raw, principals } = setup();
	const response = await app.request('/api/sync/v1/submissions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: 'not json',
	});
	expect(response.status).toBe(400);
	expect(principals).toHaveLength(0);
	raw.close();
});

test('an oversized declared body is refused before it is read', async () => {
	const { app, raw, principals } = setup();
	const response = await app.request('/api/sync/v1/submissions', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'content-length': String(64 * 1024 * 1024),
		},
		body: JSON.stringify(submission(1, [setValue('theme', 'dark')])),
	});
	expect(response.status).toBe(413);
	expect(principals).toHaveLength(0);
	raw.close();
});

test('a structurally invalid submission is invalid input', async () => {
	const { app, raw } = setup();
	const response = await submit(app, { nonsense: true });
	expect(response.status).toBe(400);
	expect((await response.json()) as unknown).toEqual({
		error: 'invalid-request',
	});
	raw.close();
});

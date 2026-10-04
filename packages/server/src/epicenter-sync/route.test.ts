/**
 * Epicenter Sync HTTP Route Tests
 *
 * Verifies authenticated principal routing and request admission before an
 * exchange reaches its authority.
 *
 * Key behaviors:
 * - Valid exchanges resolve the authenticated principal's authority
 * - Malformed, legacy-shaped, and oversized JSON never call the authority
 */
import { expect, test } from 'bun:test';

import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import { createEpicenterSyncApp } from './route.js';

const LIFETIME = 'llllllllllllllllllllllll';

function setup() {
	const principals: PrincipalId[] = [];
	let exchanges = 0;
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('principal', {
			id: asPrincipalId(c.req.header('x-test-principal') ?? 'alice'),
		});
		await next();
	});
	app.route(
		'/',
		createEpicenterSyncApp((principalId) => {
			principals.push(principalId);
			return () => {
				exchanges += 1;
				return {
					lifetimeId: LIFETIME,
					through: 0,
					records: [],
					more: false,
				};
			};
		}),
	);
	return {
		app,
		principals,
		get exchanges() {
			return exchanges;
		},
	};
}

test('valid request resolves and calls the authenticated principal authority', async () => {
	const context = setup();
	const response = await context.app.request('/api/sync/v1', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-test-principal': 'bob',
		},
		body: JSON.stringify({
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			lifetimeId: null,
			after: 0,
		}),
	});
	expect(response.status).toBe(200);
	expect((await response.json()) as unknown).toEqual({
		lifetimeId: LIFETIME,
		through: 0,
		records: [],
		more: false,
	});
	expect(context.principals).toEqual([asPrincipalId('bob')]);
	expect(context.exchanges).toBe(1);
});

test('malformed, legacy-cursor, and oversized requests are refused before authority lookup', async () => {
	const context = setup();
	const malformed = await context.app.request('/api/sync/v1', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{',
	});
	expect(malformed.status).toBe(400);
	// The pre-V1 cursor request shape is malformed input, not a refusal.
	const legacy = await context.app.request('/api/sync/v1', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			after: 0,
			cursor: { through: 2, position: 1 },
		}),
	});
	expect(legacy.status).toBe(400);
	const oversized = await context.app.request('/api/sync/v1', {
		method: 'POST',
		headers: {
			'content-length': '1048577',
			'content-type': 'application/json',
		},
		body: '{}',
	});
	expect(oversized.status).toBe(413);
	expect(context.principals).toEqual([]);
	expect(context.exchanges).toBe(0);
});

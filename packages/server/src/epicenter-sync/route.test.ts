/**
 * Row-Document HTTP Route Tests
 *
 * Verifies address admission on the row-document routes. The scalar operations
 * moved to their own module when the combined exchange was deleted, and their
 * routing, refusal codes, and body limits are covered by `v1-route.test.ts`.
 *
 * Key behaviors:
 * - A malformed namespace or table segment is refused before any dispatch
 */
import { expect, test } from 'bun:test';

import { asPrincipalId } from '@epicenter/identity';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import { createDocumentSyncApp } from './route.js';

test('document routes refuse malformed namespace and table segments', async () => {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('principal', { id: asPrincipalId('alice') });
		await next();
	});
	app.route(
		'/',
		createDocumentSyncApp({
			publish: () => ({ outcome: 'accepted' }),
			pull: () => ({ kind: 'state', version: 0, state: undefined }),
		}),
	);
	const rowId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

	const malformedNamespace = await app.request(
		`/api/sync/v1/documents/invalid/notes/${rowId}`,
	);
	const malformedTable = await app.request(
		`/api/sync/v1/documents/so.epicenter.test/not-valid/${rowId}`,
		{ method: 'POST', body: new Uint8Array([1]) },
	);

	expect(malformedNamespace.status).toBe(400);
	expect(malformedTable.status).toBe(400);
});

import { expect, test } from 'bun:test';

import { Hono } from 'hono';

import { BACKUP_V1_RESTORE_REQUEST_HEADER } from '../epicenter-sync/backup-v1-route.js';
import type { Env } from '../types.js';
import { corsMiddleware } from './cors.js';

test('CORS preflight admits the Restore idempotency header', async () => {
	const trustedOrigin = 'https://home.epicenter.so';
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('trustedOrigins', [trustedOrigin]);
		await next();
	});
	app.use('*', corsMiddleware);
	app.post('/api/sync/v1/backups/:backupId/restore', (c) => c.body(null));

	const response = await app.request(
		'/api/sync/v1/backups/aaaaaaaaaaaaaaaaaaaaaaaa/restore',
		{
			method: 'OPTIONS',
			headers: {
				origin: trustedOrigin,
				'access-control-request-method': 'POST',
				'access-control-request-headers': `${BACKUP_V1_RESTORE_REQUEST_HEADER},authorization`,
			},
		},
	);

	expect(response.status).toBe(204);
	expect(response.headers.get('access-control-allow-origin')).toBe(
		trustedOrigin,
	);
	expect(
		response.headers
			.get('access-control-allow-headers')
			?.toLowerCase()
			.split(','),
	).toContain(BACKUP_V1_RESTORE_REQUEST_HEADER);
});

/**
 * Route-owned database lifetime tests.
 * Public auth shells and unrelated 404s bypass acquisition. Acquired handles
 * close once after every queued promise settles, including failure paths.
 */
import { expect, test } from 'bun:test';
import { every } from 'hono/combine';
import { createCloudContextMiddleware } from './create-cloud-context-middleware.js';
import type { Db } from './db/create-db.js';
import { mountAuthRoutes } from './routes/auth.js';
import { createServerApp } from './server-app.js';
import type { CloudEnv } from './types.js';

const origin = 'https://api.example.com';
const identity = {
	resolveOrigin: () => origin,
	resolveTrustedOrigins: () => [origin],
};
const authOptions = {
	resolveAuthSecrets: () => ({
		BETTER_AUTH_SECRET: 'cloud-context-test-secret-1234567890',
	}),
	resolveSessionCallbacks: () => [],
};

test('public shells and unrelated 404s bypass failing acquisition and auth setup', async () => {
	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
	});
	app.onError((_error, c) => c.text('Unavailable', 503));
	let acquisitions = 0;
	let drains = 0;
	const setup = createCloudContextMiddleware({
		...authOptions,
		connect: async () => {
			acquisitions++;
			throw new Error('Postgres unavailable');
		},
		afterResponse: () => {
			drains++;
		},
		resolveAuthSecrets: () => {
			throw new Error('Public shell must not construct auth');
		},
		resolveSessionCallbacks: () => [],
	});
	mountAuthRoutes(app, {
		setup,
		serveAuthUiShell: (c) => c.html('<html>Sign in</html>'),
	});
	app.on(['GET', 'POST'], '/api/protected', setup, (c) => c.text('secret'));
	// Registered after all relational routes, just like the Worker dashboard.
	app.get('/dashboard', (c) => c.html('<html>Dashboard</html>'));
	for (const path of ['/sign-in', '/session/callback', '/dashboard']) {
		const response = await app.request(path, { headers: { origin } });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(response.headers.get('access-control-allow-origin')).toBe(origin);
	}
	for (const path of ['/missing', '/api/missing']) {
		expect((await app.request(path)).status).toBe(404);
	}
	for (const headers of [
		new Headers(),
		new Headers({ origin: 'https://attacker.example' }),
	]) {
		expect(
			(await app.request('/api/protected', { method: 'POST', headers })).status,
		).toBe(403);
	}
	const preflight = await app.request('/api/protected', {
		method: 'OPTIONS',
		headers: { origin, 'access-control-request-method': 'POST' },
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
	expect(acquisitions).toBe(0);
	for (const path of ['/auth/get-session', '/api/protected']) {
		expect((await app.request(path)).status).toBe(503);
	}
	expect(acquisitions).toBe(2);
	expect(drains).toBe(0);
});

for (const handlerFails of [false, true]) {
	for (const workFails of [false, true]) {
		test(`connection closes once after all work settles (handler failure: ${handlerFails}, work failure: ${workFails})`, async () => {
			const app = createServerApp<CloudEnv>(identity);
			app.onError((_error, c) => c.text('Handler failed', 500));
			const slow = Promise.withResolvers<void>();
			const fast = Promise.withResolvers<void>();
			let closes = 0;
			let acquisitions = 0;
			const drains: Promise<unknown>[] = [];
			const database = createCloudContextMiddleware({
				...authOptions,
				connect: async () => {
					acquisitions++;
					return {
						db: {} as Db,
						close: async () => {
							closes++;
						},
					};
				},
				afterResponse: (_c, work) => {
					drains.push(work);
				},
			});
			app.get(
				'/operation',
				every(database, async (c, next) => {
					await next();
					c.var.afterResponseQueue.push(fast.promise, slow.promise);
				}),
				(c) => {
					if (handlerFails) throw new Error('Handler failed');
					return c.text('done');
				},
			);
			expect((await app.request('/operation')).status).toBe(
				handlerFails ? 500 : 200,
			);
			expect(acquisitions).toBe(1);
			expect(drains).toHaveLength(1);
			expect(closes).toBe(0);
			if (workFails) fast.reject(new Error('Queued work failed'));
			else fast.resolve();
			await fast.promise.catch(() => {});
			expect(closes).toBe(0);
			slow.resolve();
			await Promise.all(drains);
			expect(closes).toBe(1);
		});
	}
}

test('a rethrowing error handler still schedules exactly one close', async () => {
	const app = createServerApp<CloudEnv>(identity);
	const failure = new Error('Handler failed');
	app.onError((error) => {
		throw error;
	});
	let closes = 0;
	const drains: Promise<unknown>[] = [];
	app.get(
		'/operation',
		createCloudContextMiddleware({
			...authOptions,
			connect: async () => ({
				db: {} as Db,
				close: async () => {
					closes++;
				},
			}),
			afterResponse: (_c, work) => {
				drains.push(work);
			},
		}),
		() => {
			throw failure;
		},
	);
	await expect(app.request('/operation')).rejects.toBe(failure);
	expect(drains).toHaveLength(1);
	await Promise.all(drains);
	expect(closes).toBe(1);
});

test('auth construction failure closes the acquired handle without running the handler', async () => {
	const app = createServerApp<CloudEnv>(identity);
	app.onError((_error, c) => c.text('Auth unavailable', 503));
	let closes = 0;
	let handled = false;
	const drains: Promise<unknown>[] = [];
	app.get(
		'/operation',
		createCloudContextMiddleware({
			...authOptions,
			connect: async () => ({
				db: {} as Db,
				close: async () => {
					closes++;
				},
			}),
			resolveAuthSecrets: () => {
				throw new Error('Auth secrets unavailable');
			},
			afterResponse: (_c, work) => {
				drains.push(work);
			},
		}),
		(c) => {
			handled = true;
			return c.text('secret');
		},
	);
	expect((await app.request('/operation')).status).toBe(503);
	expect(handled).toBe(false);
	expect(drains).toHaveLength(1);
	await Promise.all(drains);
	expect(closes).toBe(1);
});

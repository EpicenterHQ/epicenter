/**
 * Hosted Git route tests.
 *
 * The app is the real `createServerApp` composition, so CORS and the `/api/*`
 * cookie-CSRF guard behave as deployed. A recording store stands in for
 * Artifacts: the module owns validation, forwarding, and response hygiene, and
 * the store owns repository identity and the upstream call.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { createServerApp } from '../server-app.js';
import { type GitRepositoryStore, mountGitApp } from './git.js';

const ORIGIN = 'https://api.test';
const TRUSTED = 'https://todos.test';
const REPOSITORY = 'so.epicenter.todos.0123456789abcdef';
const ADVERTISE = `${ORIGIN}/git/${REPOSITORY}.git/info/refs?service=git-upload-pack`;
const RECEIVE = `${ORIGIN}/git/${REPOSITORY}.git/git-receive-pack`;

type Served = Parameters<GitRepositoryStore['serve']>[1] & { name: string };

function setup({
	store = true,
	upstream = () => new Response('refs'),
}: {
	store?: boolean;
	upstream?: () => Response | Promise<Response>;
} = {}) {
	const connects: { principal: string; folder: string }[] = [];
	const served: Served[] = [];
	const fake: GitRepositoryStore = {
		async connect(principal, folder) {
			connects.push({ principal, folder });
			return {
				name: `${folder}.0123456789abcdef`,
				token: 'art_v2_secret?expires=1',
				expiresAt: '2026-10-14T01:00:00.000Z',
			};
		},
		async serve(name, request) {
			served.push({ name, ...request });
			return upstream();
		},
	};
	const app = createServerApp({
		resolveOrigin: () => ORIGIN,
		resolveTrustedOrigins: () => [TRUSTED],
	});
	mountGitApp(app, {
		auth: async (c, next) => {
			if (c.req.header('authorization') !== 'Bearer alice')
				return c.text('Unauthorized', 401);
			c.set('principal', { id: asPrincipalId('alice') });
			await next();
		},
		resolveStore: () => (store ? fake : null),
	});
	return { app, connects, served };
}

function connect(app: ReturnType<typeof setup>['app'], body: unknown) {
	return app.request(`${ORIGIN}/api/git/connect`, {
		method: 'POST',
		headers: {
			authorization: 'Bearer alice',
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

test('connect returns a remote on the configured origin and an uncached token', async () => {
	const { app, connects } = setup();
	const response = await app.request(
		// The inbound host differs from the configured public origin.
		'http://internal.test/api/git/connect',
		{
			method: 'POST',
			headers: { authorization: 'Bearer alice' },
			body: JSON.stringify({ folder: 'so.epicenter.todos' }),
		},
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(await response.json<Record<string, unknown>>()).toEqual({
		remote: `${ORIGIN}/git/so.epicenter.todos.0123456789abcdef.git`,
		token: 'art_v2_secret?expires=1',
		expiresAt: '2026-10-14T01:00:00.000Z',
		// Already past by the test's clock: no life left.
		expiresIn: 0,
	});
	expect(connects).toEqual([
		{ principal: 'alice', folder: 'so.epicenter.todos' },
	]);
});

test('connect refuses folders outside the managed folder grammar', async () => {
	const { app, connects } = setup();
	for (const folder of [
		'todos',
		'So.epicenter.todos',
		'so..todos',
		'so.-todos',
		'so.todos-',
		'../so.todos',
		`so.${'a'.repeat(62)}`,
		42,
		undefined,
	]) {
		const response = await connect(app, { folder });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ name: 'InvalidFolder' });
	}
	const notJson = await app.request(`${ORIGIN}/api/git/connect`, {
		method: 'POST',
		headers: { authorization: 'Bearer alice' },
		body: 'so.epicenter.todos',
	});
	expect(notJson.status).toBe(400);
	expect((await connect(app, { folder: `so.${'a'.repeat(61)}` })).status).toBe(
		200,
	);
	expect(connects).toHaveLength(1);
});

test('connect requires a session and a store', async () => {
	const anonymous = await setup().app.request(`${ORIGIN}/api/git/connect`, {
		method: 'POST',
		headers: { origin: TRUSTED },
		body: JSON.stringify({ folder: 'so.epicenter.todos' }),
	});
	expect(anonymous.status).toBe(401);
	const storeless = await connect(setup({ store: false }).app, {
		folder: 'so.epicenter.todos',
	});
	expect(storeless.status).toBe(503);
	expect(await storeless.json()).toMatchObject({ name: 'GitUnavailable' });
});

test('a failing store is a visible 502, not a missing repository', async () => {
	const store: GitRepositoryStore = {
		connect: async () => {
			throw new Error('INTERNAL_ERROR');
		},
		serve: async () => {
			throw new TypeError('network');
		},
	};
	const broken = createServerApp({
		resolveOrigin: () => ORIGIN,
		resolveTrustedOrigins: () => [TRUSTED],
	});
	mountGitApp(broken, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			await next();
		},
		resolveStore: () => store,
	});
	const connected = await connect(broken, { folder: 'so.epicenter.todos' });
	expect(connected.status).toBe(502);
	expect(await connected.json()).toMatchObject({ name: 'GitStoreFailed' });
	const forwarded = await broken.request(ADVERTISE, {
		headers: { authorization: 'Basic eDp5' },
	});
	expect(forwarded.status).toBe(502);
});

test('only the three smart-HTTP endpoints route, with exact methods and query', async () => {
	const { app, served } = setup();
	const auth = { authorization: 'Basic eDp5' };
	for (const [method, url] of [
		['GET', `${ORIGIN}/git/${REPOSITORY}.git/info/refs`],
		['GET', `${ORIGIN}/git/${REPOSITORY}.git/info/refs?service=git-archive`],
		['GET', `${ADVERTISE}&service=git-receive-pack`],
		['GET', `${ADVERTISE}&extra=1`],
		['POST', ADVERTISE],
		['GET', RECEIVE],
		['POST', `${RECEIVE}?service=git-receive-pack`],
		['POST', `${ORIGIN}/git/${REPOSITORY}.git/objects/info/packs`],
		['GET', `${ORIGIN}/git/${REPOSITORY}/info/refs?service=git-upload-pack`],
		['GET', `${ORIGIN}/git/.hidden.git/info/refs?service=git-upload-pack`],
		['GET', `${ORIGIN}/git/a%2Fb.git/info/refs?service=git-upload-pack`],
		[
			'GET',
			`${ORIGIN}/git/${'a'.repeat(129)}.git/info/refs?service=git-upload-pack`,
		],
		['GET', `${ORIGIN}/git/repos`],
	] as const) {
		const response = await app.request(url, { method, headers: auth });
		expect(response.status, `${method} ${url}`).toBe(404);
	}
	expect(served).toHaveLength(0);
});

test('a Git request without Authorization is refused before the store', async () => {
	const { app, served } = setup();
	const terminal = await app.request(ADVERTISE);
	expect(terminal.status).toBe(401);
	expect(terminal.headers.get('www-authenticate')).toStartWith('Basic');
	expect(await terminal.json()).toMatchObject({ name: 'MissingToken' });
	const browser = await app.request(ADVERTISE, {
		headers: { origin: TRUSTED },
	});
	expect(browser.status).toBe(401);
	expect(browser.headers.get('www-authenticate')).toBeNull();
	expect(browser.headers.get('access-control-allow-origin')).toBe(TRUSTED);
	expect(browser.headers.get('access-control-allow-credentials')).toBe('true');
	expect(served).toHaveLength(0);
	const storeless = await setup({ store: false }).app.request(ADVERTISE, {
		headers: { authorization: 'Basic eDp5' },
	});
	expect(storeless.status).toBe(503);
	expect(await storeless.json()).toMatchObject({ name: 'GitUnavailable' });
});

test('a browser preflight succeeds without a token', async () => {
	const { app, served } = setup();
	const response = await app.request(RECEIVE, {
		method: 'OPTIONS',
		headers: {
			origin: TRUSTED,
			'access-control-request-method': 'POST',
			'access-control-request-headers':
				'authorization, content-type, git-protocol',
		},
	});
	expect(response.status).toBe(204);
	expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
	expect(
		response.headers.get('access-control-allow-headers')?.toLowerCase(),
	).toContain('git-protocol');
	expect(served).toHaveLength(0);
});

test('a push forwards only Git headers and streams its body', async () => {
	const { app, served } = setup({
		upstream: () =>
			new Response('report', {
				headers: { 'content-type': 'application/x-git-receive-pack-result' },
			}),
	});
	const response = await app.request(RECEIVE, {
		method: 'POST',
		headers: {
			authorization: 'Basic eDp5',
			'content-type': 'application/x-git-receive-pack-request',
			'content-encoding': 'gzip',
			accept: 'application/x-git-receive-pack-result',
			'git-protocol': 'version=2',
			cookie: 'session=secret',
			'x-forwarded-for': '203.0.113.1',
			origin: TRUSTED,
		},
		body: 'pack bytes',
	});
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('report');
	expect(response.headers.get('access-control-allow-origin')).toBe(TRUSTED);
	const [request] = served;
	expect(request!.name).toBe(REPOSITORY);
	expect(request!.service).toBe('git-receive-pack');
	expect(request!.advertisement).toBe(false);
	const forwarded: Record<string, string> = {};
	request!.headers.forEach((value, key) => {
		forwarded[key] = value;
	});
	expect(forwarded).toEqual({
		authorization: 'Basic eDp5',
		'content-type': 'application/x-git-receive-pack-request',
		'content-encoding': 'gzip',
		accept: 'application/x-git-receive-pack-result',
		'git-protocol': 'version=2',
	});
	expect(await new Response(request!.body).text()).toBe('pack bytes');
});

test('an advertisement carries no body and names its service', async () => {
	const { app, served } = setup();
	const response = await app.request(
		`${ORIGIN}/git/${REPOSITORY}.git/info/refs?service=git-receive-pack`,
		{ headers: { authorization: 'Bearer art_v2_x' } },
	);
	expect(response.status).toBe(200);
	expect(served[0]).toMatchObject({
		name: REPOSITORY,
		service: 'git-receive-pack',
		advertisement: true,
		body: null,
	});
});

test('upstream cookies are dropped and its challenge is kept only for terminal Git', async () => {
	const upstream = () =>
		new Response('denied', {
			status: 401,
			headers: {
				'www-authenticate': 'Basic realm="artifacts"',
				'set-cookie': 'upstream=1',
			},
		});
	const { app } = setup({ upstream });
	const terminal = await app.request(ADVERTISE, {
		headers: { authorization: 'Basic d3Jvbmc=' },
	});
	expect(terminal.status).toBe(401);
	expect(terminal.headers.get('www-authenticate')).toBe(
		'Basic realm="artifacts"',
	);
	expect(terminal.headers.get('set-cookie')).toBeNull();
	const browser = await app.request(ADVERTISE, {
		headers: { authorization: 'Basic d3Jvbmc=', origin: TRUSTED },
	});
	expect(browser.status).toBe(401);
	expect(browser.headers.get('www-authenticate')).toBeNull();
	expect(browser.headers.get('set-cookie')).toBeNull();
	expect(browser.headers.get('access-control-allow-origin')).toBe(TRUSTED);
	expect(await browser.text()).toBe('denied');
});

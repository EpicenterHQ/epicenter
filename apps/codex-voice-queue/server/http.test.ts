/**
 * HTTP tests verify authentication, routing, validation and gateway error responses.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayState, Health } from '../src/lib/api-types.js';
import {
	type AppServerClient,
	createAppServerClient,
} from './app-server-client.js';
import { createAuth } from './auth.js';
import { createCodexService } from './codex-service.js';
import { loadConfig } from './config.js';
import { createHandler } from './http.js';
import {
	createFakeAppServer,
	type FakeMessage,
	waitFor,
} from './testing/fake-app-server.js';
import { createTranscriber } from './transcribe.js';

const token = 'a'.repeat(40);
const dirs: string[] = [];
const clients: AppServerClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) client.stop();
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
function setup(
	staticDir = '/missing-codex-voice-queue-build',
	fake = createFakeAppServer(),
	requestTimeoutMs?: number,
) {
	const config = loadConfig({
		CODEX_VOICE_QUEUE_TOKEN: token,
		STATIC_DIR: staticDir,
		CODEX_VOICE_QUEUE_ALLOWED_ORIGINS: 'https://queue.example',
	});
	const client = createAppServerClient({
		spawnProcess: () => fake.transport,
		requestTimeoutMs,
	});
	clients.push(client);
	return createHandler({
		config,
		client,
		service: createCodexService({
			client,
			sandbox: config.sandbox,
			approval: config.approval,
		}),
		transcriber: createTranscriber({ config }),
	});
}
test('requires the bearer token on every API route', async () => {
	const handler = setup();
	expect(
		(await handler(new Request('http://localhost/api/health'))).status,
	).toBe(401);
	const response = await handler(
		new Request('http://localhost/api/health', {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
});
test('limits authentication failures for ten minutes', () => {
	let now = 0;
	const auth = createAuth({ token, now: () => now });
	const request = new Request('http://localhost/api/state');
	for (let i = 0; i < 20; i++) expect(auth.check(request, 'client')).toBe(401);
	expect(auth.check(request, 'client')).toBe(429);
	now = 600_001;
	expect(auth.check(request, 'client')).toBe(401);
});
test('returns 429 through HTTP after twenty failures', async () => {
	const handler = setup();
	for (let i = 0; i < 20; i++)
		await handler(new Request('http://localhost/api/state'));
	expect(
		(await handler(new Request('http://localhost/api/state'))).status,
	).toBe(429);
});
test('allows preflight only for an allowlisted origin', async () => {
	const handler = setup();
	const allowed = await handler(
		new Request('http://localhost/api/state', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://queue.example',
				'access-control-request-method': 'GET',
			},
		}),
	);
	expect(allowed.status).toBe(204);
	expect(allowed.headers.get('access-control-allow-origin')).toBe(
		'https://queue.example',
	);
	expect(
		(
			await handler(
				new Request('http://localhost/api/state', {
					method: 'OPTIONS',
					headers: { origin: 'https://evil.example' },
				}),
			)
		).status,
	).toBe(403);
});
test('serves SPA fallback and never serves files above static root', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'cvq-http-'));
	dirs.push(dir);
	await Bun.write(join(dir, 'index.html'), '<html>queue</html>');
	const handler = setup(dir);
	const spa = await handler(new Request('http://localhost/conversation/test'));
	expect(spa.status).toBe(200);
	expect(await spa.text()).toBe('<html>queue</html>');
	expect(spa.headers.get('content-security-policy')).toContain(
		"default-src 'self'",
	);
	for (const path of [
		'/../package.json',
		'/%2e%2e/package.json',
		'/%2e%2e%2fpackage.json',
	]) {
		const response = await handler(new Request(`http://localhost${path}`));
		// Request normalizes bare dot segments; they can only resolve to the SPA.
		if (response.status === 200)
			expect(await response.text()).toBe('<html>queue</html>');
		else expect(response.status).toBe(400);
	}
});
test('rejects unsafe policies and short tokens', () => {
	expect(() => loadConfig({ CODEX_VOICE_QUEUE_TOKEN: 'short' })).toThrow(
		'at least 32',
	);
	expect(() =>
		loadConfig({ CODEX_VOICE_QUEUE_SANDBOX: 'danger-full-access' }),
	).toThrow('workspace-write or read-only');
	expect(() => loadConfig({ CODEX_VOICE_QUEUE_APPROVAL: 'never' })).toThrow(
		'on-request or untrusted',
	);
});

test('allows tunneled POST origins matching Host despite TLS termination', async () => {
	const handler = setup();
	const response = await handler(
		new Request('http://127.0.0.1:5190/api/state', {
			method: 'POST',
			headers: {
				host: 'abc.trycloudflare.com',
				origin: 'https://abc.trycloudflare.com',
				authorization: `Bearer ${token}`,
			},
		}),
	);
	// POST /api/state is not a route, but it must pass the origin check.
	expect(response.status).toBe(404);
});

test('refuses a foreign origin even with a valid bearer token', async () => {
	const handler = setup();
	const response = await handler(
		new Request('http://127.0.0.1:5190/api/state', {
			method: 'POST',
			headers: {
				host: 'abc.trycloudflare.com',
				origin: 'https://foreign.example',
				authorization: `Bearer ${token}`,
			},
		}),
	);
	expect(response.status).toBe(403);
});

function post(path: string, body: unknown) {
	return new Request(`http://localhost/api/${path}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}
function sendResult(message: FakeMessage) {
	return message.method === 'turn/start'
		? { turn: { id: 'turn1', status: 'inProgress' } }
		: { thread: { status: { type: 'idle' } } };
}

test('validates reply IDs and optional retry fields before starting a turn', async () => {
	const fake = createFakeAppServer({ onRequest: sendResult });
	const handler = setup(undefined, fake);
	for (const replyId of [
		undefined,
		'',
		'short',
		'invalid id',
		'a'.repeat(101),
		123,
	]) {
		const response = await handler(
			post('threads/A/turns', { text: 'hi', replyId }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'validation' });
	}
	for (const fields of [{ retry: 'yes' }, { bootId: 123 }]) {
		const response = await handler(
			post('threads/A/turns', { text: 'hi', replyId: 'reply_123', ...fields }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'validation' });
	}
	expect(fake.messages).toHaveLength(0);
});

test('returns receipts for lost responses and machine codes for conflicts and busy sends', async () => {
	const fake = createFakeAppServer({ onRequest: sendResult });
	const handler = setup(undefined, fake);
	const body = { text: 'hi', replyId: 'reply_123' };
	const first = await handler(post('threads/A/turns', body));
	expect(first.status).toBe(200);
	expect(await first.json()).toEqual({
		turnId: 'turn1',
		status: 'inProgress',
		replyId: body.replyId,
		duplicate: false,
	});
	const duplicate = await handler(post('threads/A/turns', body));
	expect(await duplicate.json()).toMatchObject({
		turnId: 'turn1',
		duplicate: true,
	});
	const conflict = await handler(
		post('threads/A/turns', { ...body, text: 'edited' }),
	);
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toEqual({
		error: 'This reply ID was already used for different text',
		code: 'reply_conflict',
	});
	const busy = await handler(
		post('threads/A/turns', { ...body, replyId: 'reply_456' }),
	);
	expect(busy.status).toBe(409);
	expect(await busy.json()).toMatchObject({ code: 'busy' });
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('returns outcome_unknown for timed out sends and stale gateway retries', async () => {
	const fake = createFakeAppServer({
		onRequest: (message) =>
			message.method === 'turn/start'
				? new Promise(() => {})
				: sendResult(message),
	});
	const handler = setup(undefined, fake, 10);
	const body = { text: 'hi', replyId: 'reply_123' };
	for (const fields of [{}, { retry: true }]) {
		const response = await handler(
			post('threads/A/turns', { ...body, ...fields }),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: 'outcome_unknown' });
	}
	const restarted = await handler(
		post('threads/B/turns', {
			...body,
			replyId: 'reply_456',
			retry: true,
			bootId: 'old',
		}),
	);
	expect(restarted.status).toBe(409);
	expect(await restarted.json()).toEqual({
		error:
			'The gateway restarted, so it cannot tell whether this reply was delivered',
		code: 'outcome_unknown',
	});
	expect(
		fake.messages.filter((message) => message.method === 'turn/start'),
	).toHaveLength(1);
});

test('refuses file approval acceptance without changes and permits decline', async () => {
	const fake = createFakeAppServer({ onRequest: sendResult });
	const handler = setup(undefined, fake);
	await handler(post('threads/A/turns', { text: 'hi', replyId: 'reply_123' }));
	fake.ask('approval', 'item/fileChange/requestApproval', {
		threadId: 'A',
		turnId: 'turn1',
		itemId: 'item1',
	});
	let id = '';
	for (let attempt = 0; attempt < 100 && !id; attempt++) {
		const response = await handler(
			new Request('http://localhost/api/state', {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		id = ((await response.json()) as GatewayState).approvals[0]?.id ?? '';
		if (!id) await Bun.sleep(2);
	}
	expect(id).not.toBe('');
	const accepted = await handler(
		post(`approvals/${id}`, { decision: 'accept' }),
	);
	expect(accepted.status).toBe(409);
	expect(await accepted.json()).toEqual({
		error:
			'Codex has not shared the file changes for this request; decline it or review it in Codex',
		code: 'validation',
	});
	const declined = await handler(
		post(`approvals/${id}`, { decision: 'decline' }),
	);
	expect(declined.status).toBe(200);
	await waitFor(() =>
		fake.messages.some((message) => message.id === 'approval'),
	);
	expect(
		fake.messages.find((message) => message.id === 'approval')?.result,
	).toEqual({ decision: 'decline' });
	const missing = await handler(
		post(`approvals/${id}`, { decision: 'accept' }),
	);
	expect(missing.status).toBe(404);
	expect(await missing.json()).toMatchObject({ code: 'not_found' });
});

test('exposes one boot ID in health and state and codes authentication failures', async () => {
	const handler = setup();
	const health = await handler(
		new Request('http://localhost/api/health', {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	const state = await handler(
		new Request('http://localhost/api/state', {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	const bootId = ((await health.json()) as Health).bootId;
	expect(typeof bootId).toBe('string');
	expect(((await state.json()) as GatewayState).bootId).toBe(bootId);
	const unauthorized = await handler(new Request('http://localhost/api/state'));
	expect(await unauthorized.json()).toEqual({
		error: 'unauthorized',
		code: 'unauthorized',
	});
});

test('returns app_server for RPC errors and validation for invalid body formats', async () => {
	const fake = createFakeAppServer({
		onRequest: () => {
			throw new Error('Codex refused');
		},
	});
	const handler = setup(undefined, fake);
	const refused = await handler(
		post('threads/A/turns', { text: 'hi', replyId: 'reply_123' }),
	);
	expect(refused.status).toBe(502);
	expect(await refused.json()).toMatchObject({ code: 'app_server' });
	for (const [contentType, body, status] of [
		['text/plain', '{}', 415],
		['application/json', '{', 400],
		['application/json', 'a'.repeat(100_001), 413],
	] as const) {
		const response = await handler(
			new Request('http://localhost/api/threads/A/turns', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': contentType,
				},
				body,
			}),
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ code: 'validation' });
	}
});

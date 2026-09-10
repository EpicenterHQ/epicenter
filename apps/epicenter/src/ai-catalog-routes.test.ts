/**
 * Desktop AI catalog route tests.
 * Verifies shared event snapshots, model-preview isolation and proxy boundaries.
 * Session and Origin admission belongs to the parent host router.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createAiCatalog } from './ai-catalog.js';
import { createAiCatalogRoutes } from './ai-catalog-routes.js';
import { createProcessMemoryAppSecrets } from './app-secrets.js';
const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
async function setup(fetch?: typeof globalThis.fetch) {
	const dataRoot = await mkdtemp(join(tmpdir(), 'epicenter-ai-routes-'));
	const catalog = await createAiCatalog({
		dataRoot,
		secrets: createProcessMemoryAppSecrets(),
		fetch,
	});
	const app = new Hono().route(
		'/_epicenter/ai',
		createAiCatalogRoutes(catalog),
	);
	disposals.push(async () => {
		await catalog.close();
		await rm(dataRoot, { recursive: true, force: true });
	});
	return { app, catalog };
}

test('two subscribed app windows receive initial and committed shared snapshots', async () => {
	const { app } = await setup();
	const first = (await app.request('/_epicenter/ai/events')).body!.getReader();
	const second = (await app.request('/_epicenter/ai/events')).body!.getReader();
	const decoder = new TextDecoder();
	expect(decoder.decode((await first.read()).value)).toContain('"revision":0');
	expect(decoder.decode((await second.read()).value)).toContain('"revision":0');
	const result = await app.request('/_epicenter/ai/connections', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			type: 'add',
			input: { baseUrl: 'https://models.example/v1', apiKey: 'secret' },
		}),
	});
	expect(result.status).toBe(200);
	const firstEvent = decoder.decode((await first.read()).value);
	expect(firstEvent).toContain('"revision":1');
	expect(firstEvent).not.toContain('secret');
	expect(decoder.decode((await second.read()).value)).toBe(firstEvent);
	await first.cancel();
	await second.cancel();
});

test('preview discovers models without saving and forwards only custom authorization', async () => {
	let received: Request | undefined;
	const { app, catalog } = await setup((async (input, init) => {
		received = new Request(input, init);
		return Response.json({ data: [{ id: 'model' }] });
	}) as typeof globalThis.fetch);
	const response = await app.request('/_epicenter/ai/preview', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			cookie: 'host=session',
			authorization: 'Bearer account-key',
		},
		body: JSON.stringify({
			baseUrl: 'https://models.example/v1',
			apiKey: 'custom-key',
		}),
	});
	expect(await response.json()).toEqual({ data: [{ id: 'model' }] });
	expect(received!.url).toBe('https://models.example/v1/models');
	expect(received!.headers.get('authorization')).toBe('Bearer custom-key');
	expect(received!.headers.has('cookie')).toBe(false);
	expect(catalog.getAll().connections).toEqual([]);
});

test('proxy preserves SDK path and query while malformed commands return sanitized errors', async () => {
	const destinations: string[] = [];
	const { app, catalog } = await setup((async (input) => {
		destinations.push(String(input));
		return Response.json({ data: [] });
	}) as typeof globalThis.fetch);
	await catalog.execute({
		type: 'add',
		input: { baseUrl: 'https://models.example/v1' },
	});
	const entry = catalog.getAll().connections[0]!;
	const response = await app.request(
		`/_epicenter/ai/inference/${entry.id}/${entry.accessVersion}/models?limit=10`,
	);
	expect(response.status).toBe(200);
	await response.text();
	expect(destinations).toEqual(['https://models.example/v1/models?limit=10']);
	const invalid = await app.request('/_epicenter/ai/connections', {
		method: 'POST',
		body: JSON.stringify({
			type: 'add',
			input: { baseUrl: 'https://secret:password@example.com' },
		}),
	});
	expect(invalid.status).toBe(400);
	expect(await invalid.text()).toBe('{"error":"AI catalog request failed."}');
});

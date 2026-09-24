/**
 * Desktop AI catalog route tests.
 * Verifies shared event snapshots, saved inference proxy boundaries.
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

test('force-stopping the host with a forwarded body cancels upstream and exits cleanly', async () => {
	// Bun reports a stream error during stop(true) as an unhandled failure after
	// disposal returns. A child process is needed to observe its actual exit.
	const child = Bun.spawn(
		[
			process.execPath,
			'--eval',
			`
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiCatalog } from ${JSON.stringify(new URL('./ai-catalog.ts', import.meta.url).pathname)};
import { createAiCatalogRoutes } from ${JSON.stringify(new URL('./ai-catalog-routes.ts', import.meta.url).pathname)};
import { createProcessMemoryAppSecrets } from ${JSON.stringify(new URL('./app-secrets.ts', import.meta.url).pathname)};
const dataRoot = await mkdtemp(join(tmpdir(), 'catalog-shutdown-'));
let cancelled = false;
const catalog = await createAiCatalog({dataRoot, secrets:createProcessMemoryAppSecrets(), fetch:async()=>new Response(new ReadableStream({
 start(controller){controller.enqueue(new TextEncoder().encode('partial'));},
 cancel(){cancelled=true;},
}))});
const routes = createAiCatalogRoutes(catalog);
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:routes.fetch});
try {
 await catalog.execute({type:'add',input:{baseUrl:'https://fixture.invalid/v1'}});
 const entry=catalog.getAll().connections[0];
 const response=await fetch(new URL('/inference/'+entry.id+'/'+entry.accessVersion+'/models',server.url));
 const body=response.text().catch(()=>{});
 void server.stop(true);
 await catalog.close();
 await body;
 await Bun.sleep(20);
 if(!cancelled)throw new Error('Upstream body survived shutdown');
 console.log('upstream cancelled');
} finally {await catalog.close();await server.stop(true);await rm(dataRoot,{recursive:true,force:true});}
`,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stdout).toContain('upstream cancelled');
	expect(stderr).toBe('');
	expect(code).toBe(0);
});

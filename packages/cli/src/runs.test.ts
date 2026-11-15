/**
 * Serve-owned file runs through the browser client and an in-process HTTP shim.
 * Verify durable admission, replay, observer independence, explicit cancellation,
 * recovery without execution, private inputs, and temporary-byte retention.
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, UploadedFile } from '@epicenter/app';
import { connect, pendingRuns, type RunEvent, runs } from '@epicenter/app/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { linkAppPackage } from './app-package.ts';
import { fixture } from './runner.test-support.ts';

// The CLI selects its root once per process. Give this in-process suite a
// fresh CLI module graph after earlier files have finished their own fixtures.
// App modules remain shared so action identity matches the real loader.
for (const path of Object.keys(require.cache)) {
	if (path.startsWith(`${import.meta.dir}/`) && !path.includes('.test'))
		delete require.cache[path];
}
const { createRunHost } = await import('./runs.ts');
const { createMcpServer } = await import('./mcp.ts');
const { callAction } = await import('./run.ts');

type Receipt = { size: number; sha256: string; text: string };
type Yield = { kind: string; size?: number; sha256?: string; index?: number };
type UploadAction = Action<
	{ audio: UploadedFile; chunks?: number; delayMs?: number; fail?: boolean },
	Promise<Receipt>,
	Yield
>;
const base = 'http://127.0.0.1:4747/';
const journalKey = 'epicenter.runs.prototype.v1';
const realFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	'localStorage',
);
const originalRoot = process.env.EPICENTER_ROOT;
const originalRuntime = process.env.EPICENTER_RUNTIME_DIR;
const cleanup: (() => Promise<void>)[] = [];
// The CLI selects one Epicenter per process, so this file shares its fixture.
const homeFixture = await fixture();
afterAll(() => rm(homeFixture.root, { recursive: true, force: true }));

test.skipIf(process.platform !== 'darwin')(
	'slow Time Machine integration cannot hold run-host readiness',
	async () => {
		const f = await fixture();
		try {
			const fake = await f.folder(join(f.root, 'bin'), {
				tmutil: '#!/bin/sh\nexec /bin/sleep 3\n',
			});
			await chmod(join(fake, 'tmutil'), 0o755);
			const started = performance.now();
			const child = Bun.spawn(
				[
					process.execPath,
					'-e',
					`
import { createRunHost } from ${JSON.stringify(new URL('./runs.ts', import.meta.url).href)};
const host = createRunHost();
await host.ready;
const reply = await host.handle(new Request('http://127.0.0.1:4747/.runs/files/plain/unknown-run-identifier'));
process.stdout.write(String(reply.status));
host.stop();
`,
				],
				{
					cwd: f.root,
					env: {
						...f.env,
						EPICENTER_ROOT: f.home,
						EPICENTER_RUNTIME_DIR: join(f.root, 'runtime'),
						PATH: `${fake}:${f.env.PATH}`,
					},
					stdout: 'pipe',
					stderr: 'pipe',
					timeout: 6_000,
					killSignal: 'SIGKILL',
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ code, stderr, stdout }).toEqual({
				code: 0,
				stderr: '',
				stdout: '404',
			});
			expect(performance.now() - started).toBeLessThan(2_500);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	},
	8_000,
);
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	globalThis.fetch = realFetch;
	if (storageDescriptor)
		Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
	else Reflect.deleteProperty(globalThis, 'localStorage');
	if (originalRoot === undefined) delete process.env.EPICENTER_ROOT;
	else process.env.EPICENTER_ROOT = originalRoot;
	if (originalRuntime === undefined) delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntime;
});

async function setup() {
	const f = homeFixture;
	await rm(join(f.apps, 'files'), { recursive: true, force: true });
	await f.app(
		'files',
		`
import { callSignal } from '@epicenter/app';
function sleep(ms) {
 const signal = callSignal();
 return new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new Error('Stopped by caller'));
  const stop = () => { clearTimeout(timer); reject(new Error('Stopped by caller')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
 });
}
export default defineApp({ description: 'Files', collections: {}, actions: {
 transcribe: defineAction({ description: 'Read file', annotations: { readOnlyHint: true }, input: {
  audio: field.file({ accept: ['audio/*', 'text/plain'], maxBytes: 1024 }),
  chunks: field.integer({optional:true,min:1,max:20}), delayMs: field.integer({optional:true,min:0,max:100}), fail: field.boolean(),
 }, async *run({audio,chunks=3,delayMs=1,fail=false}) {
  await folder.update('data/count.local', (text='0') => String(Number(text)+1));
  const bytes=await audio.bytes(); const text=await audio.text();
  const sha256=new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  yield {kind:'received',size:audio.size,sha256};
  if(fail) throw new Error('File work failed');
  for(let index=0;index<chunks;index++){await sleep(delayMs);yield {kind:'chunk',index};}
  return {size:bytes.length,sha256,text};
 }}),
 'private-file': defineAction({description:'Private file',privateInput:true,input:{audio:field.file()},run:()=>null}),
 private: defineAction({description:'Private',privateInput:true,input:{token:field.text()},run:()=>null}),
 plain: defineAction({description:'Plain',input:{},run:()=>null}),
} });`,
	);
	await linkAppPackage(join(f.apps, 'files', 'code'));
	const runtime = join(f.root, `runtime-${crypto.randomUUID()}`);
	cleanup.push(() => rm(runtime, { recursive: true, force: true }));
	process.env.EPICENTER_ROOT = f.home;
	process.env.EPICENTER_RUNTIME_DIR = runtime;
	const host = createRunHost();
	cleanup.push(async () => {
		// A finished event is visible before the terminal record and byte cleanup.
		// Wait for those writes before deleting this test's runtime directory.
		await eventually(async () => {
			const directory = join(runtime, 'runs', 'files');
			const ids = await readdir(directory).catch(() => []);
			for (const id of ids) {
				const record = await Bun.file(join(directory, id, 'record.json'))
					.json()
					.catch(() => undefined);
				if (
					record &&
					record.state !== 'finished' &&
					record.state !== 'interrupted'
				)
					return false;
				if (
					(await readdir(join(directory, id))).some((name) =>
						name.includes('.part-'),
					)
				)
					return false;
			}
			return true;
		});
		host.stop();
	});
	await host.ready;
	const readiness = await host.handle(
		new Request(`${base}.runs/files/transcribe/unknown-run-identifier`),
	);
	if (readiness.status === 503) throw new Error(await readiness.text());
	const entries = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return entries.size;
		},
		clear: () => entries.clear(),
		getItem: (key) => entries.get(key) ?? null,
		key: (index) => [...entries.keys()][index] ?? null,
		removeItem: (key) => {
			entries.delete(key);
		},
		setItem: (key, value) => {
			entries.set(key, value);
		},
	};
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: storage,
	});
	const requests: Request[] = [];
	let ambiguous = false;
	const shim = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		// A network fetch supplies this header for a Blob; Request alone does not.
		if (init?.body instanceof Blob)
			request.headers.set('content-length', String(init.body.size));
		requests.push(request.clone());
		const response = await host.handle(request);
		if (
			ambiguous &&
			request.method === 'POST' &&
			!request.url.endsWith('/cancel')
		)
			return new Response('', { status: 503 });
		return response;
	};
	globalThis.fetch = shim as typeof fetch;
	const app = connect<{
		actions: {
			transcribe: UploadAction;
			private: (input: { token: string }) => null;
		};
	}>({ app: 'files', url: base });
	const url = (id: string, suffix = '', action = 'transcribe') =>
		`${base}.runs/files/${action}/${id}${suffix}`;
	const recordDir = (id: string) => join(runtime, 'runs', 'files', id);
	const upload = async (id: string, text = 'hello', type = 'text/plain') => {
		const response = await fetch(url(id, '/files/audio'), {
			method: 'PUT',
			body: new Blob([text], { type }),
			headers: { 'content-type': type, 'x-epicenter-file-name': 'note.txt' },
		});
		return response;
	};
	const admit = (id: string, input: object, action = 'transcribe') =>
		fetch(url(id, '', action), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		});
	return {
		...f,
		host,
		runtime,
		requests,
		storage,
		app,
		url,
		recordDir,
		upload,
		admit,
		ambiguous() {
			ambiguous = true;
		},
	};
}

async function collect<T>(events: AsyncIterable<T>) {
	const result: T[] = [];
	for await (const event of events) result.push(event);
	return result;
}

async function eventually(check: () => Promise<boolean>) {
	const deadline = Date.now() + 3000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error('Run outcome did not arrive');
		await Bun.sleep(5);
	}
}

async function bins(directory: string) {
	return (await readdir(join(directory, 'files'))).filter((name) =>
		name.endsWith('.bin'),
	);
}

test('file receipt matches bytes, yields stay ordered, returned finish clears bytes and pending', async () => {
	const f = await setup();
	const run = runs.start(f.app.transcribe, {
		audio: new File(['hello'], 'note.txt', { type: 'text/plain' }),
	});
	expect(pendingRuns()).toHaveLength(1);
	const events = await collect(run.events());
	const sha256 = new Bun.CryptoHasher('sha256').update('hello').digest('hex');
	expect(
		events
			.filter((event) => event.type === 'yielded')
			.map((event) => event.value),
	).toEqual([
		{ kind: 'received', size: 5, sha256 },
		{ kind: 'chunk', index: 0 },
		{ kind: 'chunk', index: 1 },
		{ kind: 'chunk', index: 2 },
	]);
	expect(expectOk(await run.result())).toEqual({
		size: 5,
		sha256,
		text: 'hello',
	});
	expect(runs.pending(f.app.transcribe)).toEqual([]);
	await eventually(async () => (await bins(f.recordDir(run.id))).length === 0);
});

test('identical admission joins once; changed inputs and bytes conflict', async () => {
	const f = await setup();
	const id = crypto.randomUUID();
	const uploaded = await f.upload(id);
	const { reference } = await uploaded.json();
	const input = { audio: reference, chunks: 3, delayMs: 2 };
	expect((await f.admit(id, input)).status).toBe(202);
	expect((await f.admit(id, input)).status).toBe(200);
	expect((await f.admit(id, { ...input, chunks: 4 })).status).toBe(409);
	expect((await f.upload(id, 'changed')).status).toBe(409);
	expectOk(await runs.attach(f.app.transcribe, id).result());
	expect(await readFile(join(f.apps, 'files/data/count.local'), 'utf8')).toBe(
		'1',
	);
});

test('observer abort leaves execution alive and cursor replay has no gaps', async () => {
	const f = await setup();
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
		chunks: 5,
		delayMs: 5,
	});
	const stop = new AbortController();
	const first: RunEvent<Yield, Receipt>[] = [];
	for await (const event of run.events({ signal: stop.signal })) {
		first.push(event);
		if (event.type === 'yielded') stop.abort();
	}
	const cursor = Math.max(
		...first.map((event) => ('seq' in event ? event.seq : 0)),
	);
	const replay = await collect(
		runs.attach(f.app.transcribe, run.id).events({ after: cursor }),
	);
	const seqs = [...first, ...replay].flatMap((event) =>
		'seq' in event ? [event.seq] : [],
	);
	expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
	expect(replay.at(-1)?.type).toBe('finished');
	expectOk(await run.result());
});

test('explicit cancel is durable, stops yields, and retains bytes after failure', async () => {
	const f = await setup();
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
		chunks: 20,
		delayMs: 50,
	});
	const events: RunEvent<Yield, Receipt>[] = [];
	for await (const event of run.events()) {
		events.push(event);
		if (event.type === 'yielded') expectOk(await run.cancel());
	}
	const cancel = events.findIndex((event) => event.type === 'cancel-requested');
	expect(cancel).toBeGreaterThan(0);
	expect(
		events.slice(cancel + 1).some((event) => event.type === 'yielded'),
	).toBe(false);
	expectErr(await run.result());
	expect(await bins(f.recordDir(run.id))).toHaveLength(1);
	expect(
		await readFile(join(f.recordDir(run.id), 'events.ndjson'), 'utf8'),
	).toContain('cancel-requested');
});

test('recovery marks an abandoned record interrupted and re-admission never reruns', async () => {
	const f = await setup();
	const id = crypto.randomUUID();
	const { reference } = await (await f.upload(id)).json();
	const dir = f.recordDir(id);
	const input = { audio: reference, fail: false };
	const digest = new Bun.CryptoHasher('sha256')
		.update(JSON.stringify({ action: 'transcribe', input }))
		.digest('hex');
	await writeFile(
		join(dir, 'record.json'),
		JSON.stringify({
			version: 1,
			id,
			app: 'files',
			action: 'transcribe',
			inputDigest: digest,
			acceptedAt: new Date().toISOString(),
			state: 'running',
			files: {},
		}),
	);
	f.host.stop();
	const recovered = createRunHost();
	cleanup.push(async () => {
		recovered.stop();
	});
	await recovered.ready;
	const request = (suffix = '', method = 'GET', body?: string) =>
		recovered.handle(new Request(f.url(id, suffix), { method, body }));
	expect((await (await request()).json()).state).toBe('interrupted');
	expect((await request('', 'POST', JSON.stringify(input))).status).toBe(200);
	const events = await (await request('/events')).text();
	expect(events).toContain('interrupted');
	expect(events).not.toContain('started');
	expect(await Bun.file(join(f.apps, 'files/data/count.local')).exists()).toBe(
		false,
	);
});

test('unknown ids observe without admission and retain an uncertain journal entry', async () => {
	const f = await setup();
	f.storage.setItem(
		journalKey,
		JSON.stringify([
			{
				id: 'unknown-run-identifier',
				app: 'files',
				action: 'transcribe',
				startedAt: new Date().toISOString(),
				files: [],
			},
		]),
	);
	const events = await collect(
		runs.attach(f.app.transcribe, 'unknown-run-identifier').events(),
	);
	expect(events.map((event) => event.type)).toEqual(['unknown']);
	expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
	expect(pendingRuns()).toHaveLength(1);
});

test('size and MIME refusals send no admission; ordinary and direct calls refuse file actions', async () => {
	const f = await setup();
	expect((await f.upload(crypto.randomUUID(), 'x'.repeat(1025))).status).toBe(
		413,
	);
	expect(
		(await f.upload(crypto.randomUUID(), 'hello', 'image/png')).status,
	).toBe(415);
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['image'], { type: 'image/png' }),
	});
	expect(expectErr(await run.result()).name).toBe('Refused');
	expect(pendingRuns()).toEqual([]);
	expect(f.requests.some((request) => request.method === 'POST')).toBe(false);
	const before = f.requests.length;
	expect(
		expectErr(
			await f.app.transcribe({
				audio: new Blob(['hello']) as unknown as UploadedFile,
			}),
		).name,
	).toBe('Refused');
	expect(f.requests).toHaveLength(before);
	const answer = await callAction('files', 'transcribe', {});
	expect(answer).toMatchObject({
		error: {
			message: expect.stringContaining('only a run started from its page'),
		},
	});
	const help = await f.run('files', 'transcribe', '--help');
	expect(help.stdout).toContain('Start it from its page');
	expect(help.stdout).not.toContain('--audio');
	const listing = await f.run('files');
	expect(listing.stdout).toContain('file input: start from its page');
});

test('MCP omits file and private actions while preserving ordinary tools', async () => {
	await setup();
	const server = await createMcpServer();
	const client = new Client({ name: 'run-test', version: '1' });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
			'files_plain',
		]);
	} finally {
		await client.close();
		await server.close();
	}
});

test('journal failure makes no request and ambiguous acknowledgement is never resent', async () => {
	const f = await setup();
	const setItem = f.storage.setItem;
	f.storage.setItem = () => {
		throw new Error('storage denied');
	};
	const refused = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
	});
	expect(expectErr(await refused.result()).name).toBe('Refused');
	expect(f.requests).toEqual([]);
	f.storage.setItem = setItem;
	f.ambiguous();
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
	});
	expectOk(await run.result());
	expect(
		f.requests.filter((request) => request.method === 'POST'),
	).toHaveLength(1);
});

test('thrown work retains bytes and private input persists neither its value nor a digest', async () => {
	const f = await setup();
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
		fail: true,
	});
	expect(expectErr(await run.result()).name).toBe('Threw');
	expect(await bins(f.recordDir(run.id))).toHaveLength(1);
	const privateRun = runs.start(f.app.private, {
		token: 'private-input-sentinel',
	});
	expectOk(await privateRun.result());
	await eventually(
		async () =>
			JSON.parse(
				await readFile(join(f.recordDir(privateRun.id), 'record.json'), 'utf8'),
			).state === 'finished',
	);
	const record = await readFile(
		join(f.recordDir(privateRun.id), 'record.json'),
		'utf8',
	);
	const events = await readFile(
		join(f.recordDir(privateRun.id), 'events.ndjson'),
		'utf8',
	);
	const digest = new Bun.CryptoHasher('sha256')
		.update('private-input-sentinel')
		.digest('hex');
	for (const text of [record, events]) {
		expect(text).not.toContain('private-input-sentinel');
		expect(text).not.toContain(digest);
		expect(text).not.toContain('inputDigest');
	}
	expect(
		(
			await f.admit(
				privateRun.id,
				{ token: 'changed-private-input' },
				'private',
			)
		).status,
	).toBe(200);
});

test('private file admission omits the JSON input digest and retains file hashes', async () => {
	const f = await setup();
	const id = crypto.randomUUID();
	const content = 'private-file-sentinel';
	const response = await fetch(f.url(id, '/files/audio', 'private-file'), {
		method: 'PUT',
		body: new Blob([content], { type: 'text/plain' }),
		headers: { 'content-type': 'text/plain' },
	});
	const { reference } = await response.json();
	expect((await f.admit(id, { audio: reference }, 'private-file')).status).toBe(
		202,
	);
	await (await fetch(f.url(id, '/events', 'private-file'))).text();
	await eventually(
		async () =>
			JSON.parse(await readFile(join(f.recordDir(id), 'record.json'), 'utf8'))
				.state === 'finished',
	);
	const digest = new Bun.CryptoHasher('sha256').update(content).digest('hex');
	const record = JSON.parse(
		await readFile(join(f.recordDir(id), 'record.json'), 'utf8'),
	);
	expect(record.files.audio.sha256).toBe(digest);
	expect(record).not.toHaveProperty('inputDigest');
	for (const path of ['record.json', 'events.ndjson']) {
		const text = await readFile(join(f.recordDir(id), path), 'utf8');
		expect(text).not.toContain(content);
		expect(text).not.toContain('inputDigest');
	}
	const metadata = JSON.parse(
		await readFile(join(f.recordDir(id), 'files', '617564696f.json'), 'utf8'),
	);
	expect(metadata.sha256).toBe(digest);
	await eventually(async () => (await bins(f.recordDir(id))).length === 0);
});

test('runtime directories inside the Epicenter are refused before creation', async () => {
	const f = await setup();
	const inside = join(f.home, 'run-runtime');
	process.env.EPICENTER_RUNTIME_DIR = inside;
	const rejected = createRunHost();
	cleanup.push(async () => {
		rejected.stop();
	});
	await rejected.ready;
	const response = await rejected.handle(
		new Request(f.url('unknown-run-identifier')),
	);
	expect(response.status).toBe(503);
	expect((await response.json()).error.message).toContain('inside');
	expect(await Bun.file(join(inside, 'runs')).exists()).toBe(false);
});

/**
 * Serve-owned file runs through the browser client and an in-process HTTP shim.
 * Verify durable admission, replay, observer independence, explicit cancellation,
 * recovery without execution, private inputs, and temporary-byte retention.
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	chmod,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, UploadedFile } from '@epicenter/app';
import {
	connect,
	pendingRuns,
	type RunEvent,
	runs,
} from '@epicenter/app/client';
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
 noop: defineAction({description:'No operation',input:{},run:()=>null}),
 'big-yield': defineAction({description:'Oversized yield',input:{},async *run(){yield 'x'.repeat(256*1024+1); return null;}}),
 'big-answer': defineAction({description:'Oversized answer',input:{},run:()=> 'x'.repeat(5*1024*1024)}),
 'tiny-yields': defineAction({description:'Many tiny updates',input:{},async *run(){for(let i=0;i<15000;i++)yield i;return true;}}),
 wait: defineAction({description:'Wait',input:{},async run(){try {await sleep(120000);} finally {await folder.update('data/finally.local', () => 'yes');} return null;}}),
 plain: defineAction({description:'Plain',input:{},async run(){await folder.update('data/count.local', (text='0') => String(Number(text)+1)); return null;}}),
} });`,
	);
	await linkAppPackage(join(f.apps, 'files', 'code'));
	const runtime = join(f.root, `runtime-${crypto.randomUUID()}`);
	cleanup.push(() => rm(runtime, { recursive: true, force: true }));
	process.env.EPICENTER_ROOT = f.home;
	process.env.EPICENTER_RUNTIME_DIR = runtime;
	const host = createRunHost();
	cleanup.push(async () => {
		await eventually(async () => {
			const db = new Database(join(runtime, 'runs.sqlite'), { readonly: true });
			try {
				return (
					(db
						.query<{ count: number }, []>(
							"SELECT count(*) AS count FROM runs WHERE state IN ('accepted','running')",
						)
						.get()?.count ?? 0) === 0
				);
			} finally {
				db.close();
			}
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
	const responses: Promise<string>[] = [];
	let ambiguous = false;
	const shim = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		// A network fetch supplies this header for a Blob; Request alone does not.
		if (init?.body instanceof Blob)
			request.headers.set('content-length', String(init.body.size));
		requests.push(request.clone());
		const response = await host.handle(request);
		if (
			request.method === 'POST' &&
			!request.url.endsWith('/cancel') &&
			response.status === 200
		)
			responses.push(response.clone().text());
		if (
			ambiguous &&
			request.method === 'POST' &&
			!request.url.endsWith('/cancel')
		)
			throw new Error('Admission acknowledgement lost');
		return response;
	};
	globalThis.fetch = shim as typeof fetch;
	const app = connect<{
		actions: {
			transcribe: UploadAction;
			private: (input: { token: string }) => null;
			noop: () => null;
			wait: () => Promise<null>;
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
		responses,
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
	const first = await f.admit(id, input);
	expect(first.status).toBe(200);
	const joined = await f.admit(id, input);
	expect(joined.status).toBe(200);
	const frames = (await first.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(frames.map((frame) => frame.type)).toEqual([
		'accepted',
		'started',
		'yielded',
		'yielded',
		'yielded',
		'yielded',
		'finished',
	]);
	expect(
		(await joined.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line)),
	).toEqual(frames);
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
	expect(await (await fetch(f.url(run.id, '/events'))).text()).toContain(
		'cancel-requested',
	);
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
	await writeFile(
		join(dir, 'events.ndjson'),
		`${JSON.stringify({ seq: 1, at: new Date().toISOString(), type: 'accepted' })}\n{torn`,
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
	expect(await bins(dir)).toHaveLength(1);
	recovered.stop();
	const again = createRunHost();
	await again.ready;
	expect(
		await (await again.handle(new Request(f.url(id, '/events')))).text(),
	).toBe(events);
	expect(await bins(dir)).toHaveLength(1);
	again.stop();
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

test('size and MIME refusals send no admission; ordinary calls upload files', async () => {
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
	expectOk(
		await f.app.transcribe({
			audio: new Blob(['hello'], { type: 'text/plain' }),
		}),
	);
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
			'files_noop',
			'files_big-yield',
			'files_big-answer',
			'files_tiny-yields',
			'files_wait',
			'files_plain',
		]);
	} finally {
		await client.close();
		await server.close();
	}
});

test('storage failure permits a run and ambiguous acknowledgement is never resent', async () => {
	const f = await setup();
	const setItem = f.storage.setItem;
	f.storage.setItem = () => {
		throw new Error('storage denied');
	};
	const refused = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
	});
	expect(refused.isRemembered()).toBe(false);
	expectOk(await refused.result());
	f.requests.length = 0;
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
	const db = new Database(join(f.runtime, 'runs.sqlite'), { readonly: true });
	const rows = [
		...db.query('SELECT * FROM runs').all(),
		...db.query('SELECT * FROM events').all(),
	];
	const payloads = db
		.query<{ gzip: number; body: Uint8Array }, []>(
			'SELECT gzip, body FROM payloads',
		)
		.all();
	const decoded = payloads.map(({ gzip, body }) =>
		Buffer.from(gzip ? Bun.gunzipSync(new Uint8Array(body)) : body).toString(),
	);
	const digest = new Bun.CryptoHasher('sha256')
		.update('private-input-sentinel')
		.digest('hex');
	const inputDigest = new Bun.CryptoHasher('sha256')
		.update(
			JSON.stringify({
				action: 'private',
				input: { token: 'private-input-sentinel' },
			}),
		)
		.digest('hex');
	const contents = [JSON.stringify(rows), ...decoded];
	for (const suffix of ['', '-wal', '-shm'])
		contents.push(
			await readFile(join(f.runtime, `runs.sqlite${suffix}`))
				.then((data) => data.toString('latin1'))
				.catch(() => ''),
		);
	for (const text of contents) {
		expect(text).not.toContain('private-input-sentinel');
		expect(text).not.toContain(digest);
		expect(text).not.toContain(inputDigest);
	}
	expect(
		db
			.query<{ input_digest: string | null }, [string]>(
				'SELECT input_digest FROM runs WHERE id=?',
			)
			.get(privateRun.id)?.input_digest,
	).toBeNull();
	db.close();
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
		200,
	);
	await (await fetch(f.url(id, '/events', 'private-file'))).text();
	const digest = new Bun.CryptoHasher('sha256').update(content).digest('hex');
	const db = new Database(join(f.runtime, 'runs.sqlite'), { readonly: true });
	const row = db
		.query<{ files: string; input_digest: string | null }, [string]>(
			'SELECT files,input_digest FROM runs WHERE id=?',
		)
		.get(id)!;
	expect(JSON.parse(row.files).audio.sha256).toBe(digest);
	expect(row.input_digest).toBeNull();
	db.close();
	const metadata = JSON.parse(
		await readFile(join(f.recordDir(id), 'files', '617564696f.json'), 'utf8'),
	);
	expect(metadata.sha256).toBe(digest);
	await eventually(async () => (await bins(f.recordDir(id))).length === 0);
});

test('ordinary and explicit calls share one streamed admission', async () => {
	const f = await setup();
	for (const explicit of [false, true]) {
		f.requests.length = 0;
		f.responses.length = 0;
		const input = {
			audio: new Blob(['hello'], { type: 'text/plain' }),
			chunks: 2,
		};
		const answer = explicit
			? await runs.start(f.app.transcribe, input).result()
			: await f.app.transcribe(input);
		expectOk(answer);
		expect(
			f.requests.filter((request) => request.method === 'POST'),
		).toHaveLength(1);
		expect(
			f.requests.filter((request) => request.method === 'GET'),
		).toHaveLength(0);
		const frames = (await f.responses[0]!)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(frames.map((frame) => frame.type)).toEqual([
			'accepted',
			'started',
			'yielded',
			'yielded',
			'yielded',
			'finished',
		]);
	}
});

test('ordinary and explicit no-file calls need no GET', async () => {
	const f = await setup();
	for (const explicit of [false, true]) {
		f.requests.length = 0;
		const answer = explicit
			? await runs.start(f.app.noop, {}).result()
			: await f.app.noop();
		expectOk(answer);
		expect(
			f.requests.filter((request) => request.method === 'POST'),
		).toHaveLength(1);
		expect(
			f.requests.filter((request) => request.method === 'GET'),
		).toHaveLength(0);
	}
});

test('onYield failure stops observation while the host completes the run', async () => {
	const f = await setup();
	const bug = new Error('callback failed');
	await expect(
		f.app.transcribe(
			{
				audio: new Blob(['hello'], { type: 'text/plain' }),
				chunks: 4,
				delayMs: 5,
			},
			{
				onYield() {
					throw bug;
				},
			},
		),
	).rejects.toBe(bug);
	const post = f.requests.find((request) => request.method === 'POST')!;
	await eventually(
		async () =>
			(await (await f.host.handle(new Request(post.url))).json()).state ===
			'finished',
	);
	expect(
		await (await f.host.handle(new Request(`${post.url}/events`))).text(),
	).toContain('finished');
});

test('a cut admission stream reconnects after the last frame without resubmitting', async () => {
	const f = await setup();
	const fetchHost = globalThis.fetch;
	let cut = false;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const response = await fetchHost(input, init);
		if (
			!cut &&
			init?.method === 'POST' &&
			response.status === 200 &&
			response.body
		) {
			cut = true;
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffered = '';
			return new Response(
				new ReadableStream({
					async start(controller) {
						while (true) {
							const part = await reader.read();
							if (part.done) break;
							buffered += decoder.decode(part.value, { stream: true });
							const lines = buffered.split('\n');
							buffered = lines.pop() ?? '';
							for (const line of lines) {
								controller.enqueue(new TextEncoder().encode(`${line}\n`));
								if (JSON.parse(line).type === 'yielded') {
									void reader.cancel();
									controller.close();
									return;
								}
							}
						}
						controller.close();
					},
				}),
			);
		}
		return response;
	}) as typeof fetch;
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
		chunks: 5,
		delayMs: 5,
	});
	const frames = await collect(run.events());
	const seq = frames.flatMap((event) => ('seq' in event ? [event.seq] : []));
	expect(seq).toEqual(
		Array.from({ length: seq.length }, (_, index) => index + 1),
	);
	expect(frames.at(-1)?.type).toBe('finished');
	expect(
		f.requests.filter((request) => request.method === 'POST'),
	).toHaveLength(1);
	expect(
		f.requests.some(
			(request) =>
				request.method === 'GET' &&
				new URL(request.url).searchParams.get('after') !== '0',
		),
	).toBe(true);
});

test('1100 ordinary calls proceed while three unobserved runs remain active', async () => {
	const f = await setup();
	const active = Array.from({ length: 3 }, () => runs.start(f.app.wait, {}));
	await eventually(async () =>
		(
			await Promise.all(
				active.map(
					async (run) =>
						(
							await f.host.handle(new Request(f.url(run.id, '', 'wait')))
						).status,
				),
			)
		).every((status) => status === 200),
	);
	const saved = Array.from({ length: f.storage.length }, (_, i) =>
		f.storage.key(i),
	).sort();
	try {
		for (let offset = 0; offset < 1104; offset += 8) {
			const results = await Promise.all(
				Array.from({ length: 8 }, () => f.app.noop()),
			);
			for (const result of results) expectOk(result);
		}
		expect(
			Array.from({ length: f.storage.length }, (_, i) =>
				f.storage.key(i),
			).sort(),
		).toEqual(saved);
	} finally {
		await Promise.all(active.map((run) => run.cancel()));
	}
}, 180_000);

test('terminal cursor replays the terminal frame and later observers replay the log', async () => {
	const f = await setup();
	const id = crypto.randomUUID();
	const response = await f.admit(id, {}, 'plain');
	const first = (await response.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(first.map((event) => event.type)).toEqual([
		'accepted',
		'started',
		'finished',
	]);
	const last = first.at(-1);
	const atEnd = await (
		await fetch(f.url(id, `/events?after=${last.seq}`, 'plain'))
	).text();
	expect(JSON.parse(atEnd.trim())).toEqual(last);
	const replay = await (await fetch(f.url(id, '/events', 'plain'))).text();
	expect(
		replay
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line)),
	).toEqual(first);
});

test('oversized yields and answers finish with bounded errors', async () => {
	const f = await setup();
	for (const action of ['big-yield', 'big-answer']) {
		const id = crypto.randomUUID();
		const response = await f.admit(id, {}, action);
		const frames = (await response.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(frames.some((event) => event.type === 'yielded')).toBe(false);
		expect(frames.at(-1).type).toBe('finished');
		expect(frames.at(-1).answer).not.toHaveProperty('returned');
		const db = new Database(join(f.runtime, 'runs.sqlite'), { readonly: true });
		expect(
			db
				.query<{ log_bytes: number }, [string]>(
					'SELECT log_bytes FROM runs WHERE id=?',
				)
				.get(id)!.log_bytes,
		).toBeLessThanOrEqual(4 * 1024 * 1024);
		db.close();
	}
});

test('capacity refuses the thirty-third active run and cancellation reaches finally', async () => {
	const f = await setup();
	const ids: string[] = [];
	for (let i = 0; i < 32; i++) {
		const id = crypto.randomUUID();
		ids.push(id);
		expect((await f.admit(id, {}, 'wait')).status).toBe(200);
	}
	const rejected = await f.admit(crypto.randomUUID(), {}, 'wait');
	expect(rejected.status).toBe(429);
	expect((await rejected.json()).admitted).toBe(false);
	expect(
		(
			await fetch(f.url(crypto.randomUUID(), '/cancel', 'wait'), {
				method: 'POST',
			})
		).status,
	).toBe(404);
	for (const id of ids)
		expect(
			(await fetch(f.url(id, '/cancel', 'wait'), { method: 'POST' })).status,
		).toBe(202);
	await eventually(
		async () =>
			await Bun.file(join(f.apps, 'files/data/finally.local')).exists(),
	);
	const frames = await (await fetch(f.url(ids[0]!, '/events', 'wait'))).text();
	expect(frames).toContain('cancel-requested');
}, 15000);

test('budget refusal is definitive', async () => {
	const f = await setup();
	expect((await stat(f.runtime)).mode & 0o777).toBe(0o700);
	f.host.stop();
	const host = createRunHost({ limits: { runtimeBytes: 1024 } });
	await host.ready;
	const response = await host.handle(
		new Request(f.url(crypto.randomUUID(), '', 'plain'), {
			method: 'POST',
			body: '{}',
		}),
	);
	expect(response.status).toBe(507);
	expect((await response.json()).admitted).toBe(false);
	host.stop();
});

test('the shared admission threshold refuses new work while preserving accepted replay', async () => {
	const f = await setup();
	f.host.stop();
	let now = Date.now();
	const options = {
		limits: { runtimeBytes: 4.5 * 1024 * 1024 },
		now: () => now,
	};
	let host = createRunHost(options);
	await host.ready;
	try {
		const id = crypto.randomUUID();
		const address = f.url(id, '', 'tiny-yields');
		const response = await host.handle(
			new Request(address, { method: 'POST', body: '{}' }),
		);
		expect(response.status).toBe(200);
		const frames = (await response.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(frames.filter((frame) => frame.type === 'yielded')).toHaveLength(
			15000,
		);
		expect(frames.at(-1)?.answer).toEqual({ returned: true });
		const sizes = await Promise.all(
			['', '-wal', '-shm'].map(
				async (suffix) =>
					(await stat(join(f.runtime, `runs.sqlite${suffix}`))).size,
			),
		);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(
			options.limits.runtimeBytes,
		);
		const refused = await host.handle(
			new Request(f.url(crypto.randomUUID(), '', 'noop'), {
				method: 'POST',
				body: '{}',
			}),
		);
		expect(refused.status).toBe(507);
		expect((await refused.json()).admitted).toBe(false);
		const upload = await host.handle(
			new Request(f.url(crypto.randomUUID(), '/files/audio'), {
				method: 'PUT',
				body: 'test',
				headers: { 'content-type': 'text/plain', 'content-length': '4' },
			}),
		);
		expect(upload.status).toBe(507);
		const replay = await host.handle(new Request(`${address}/events`));
		expect((await replay.text()).trim().split('\n')).toEqual(
			frames.map((frame) => JSON.stringify(frame)),
		);
		host.stop();
		now += 25 * 60 * 60 * 1000;
		host = createRunHost(options);
		await host.ready;
		expect((await host.handle(new Request(address))).status).toBe(404);
		const resumed = await host.handle(
			new Request(f.url(crypto.randomUUID(), '', 'noop'), {
				method: 'POST',
				body: '{}',
			}),
		);
		expect(resumed.status).toBe(200);
		expect(await resumed.text()).toContain('"returned":null');
	} finally {
		host.stop();
	}
}, 30_000);

test('startup expiry removes old runs and their retained upload directories', async () => {
	const f = await setup();
	const run = runs.start(f.app.transcribe, {
		audio: new Blob(['hello'], { type: 'text/plain' }),
		fail: true,
	});
	expectErr(await run.result());
	expect(await bins(f.recordDir(run.id))).toHaveLength(1);
	f.host.stop();
	const db = new Database(join(f.runtime, 'runs.sqlite'));
	db.run('UPDATE runs SET ended_at=? WHERE id=?', [
		Date.now() - 25 * 60 * 60 * 1000,
		run.id,
	]);
	db.close();
	const restarted = createRunHost();
	await restarted.ready;
	expect((await restarted.handle(new Request(f.url(run.id)))).status).toBe(404);
	expect(
		await Bun.file(
			join(f.recordDir(run.id), 'files', '617564696f.bin'),
		).exists(),
	).toBe(false);
	restarted.stop();
});

test('retired ordinary route asks the page to reload without executing', async () => {
	const f = await setup();
	const { staleCallResponse } = await import('./http.ts');
	const response = await staleCallResponse(
		new Request(`${base}files/plain`, { method: 'POST', body: '{}' }),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('application/x-ndjson');
	expect(JSON.parse((await response.text()).trim()).answer.error.message).toBe(
		'This page is out of date. Reload it to keep using files.',
	);
	expect(await Bun.file(join(f.apps, 'files/data/count.local')).exists()).toBe(
		false,
	);
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

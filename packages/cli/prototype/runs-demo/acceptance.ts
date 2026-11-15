/** PROTOTYPE: Exercise the real browser SDK against a disposable serve process. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_FILE_BYTES } from '@epicenter/app';
import { connect, type Run, type RunEvent } from '@epicenter/app/client';
import type demo from './app/epicenter.js';

/** PROTOTYPE: Browser journal without browser globals, also used by socket-free checks. */
export function memoryStorage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear() {
			entries.clear();
		},
		getItem(key) {
			return entries.get(key) ?? null;
		},
		key(index) {
			return [...entries.keys()][index] ?? null;
		},
		removeItem(key) {
			entries.delete(key);
		},
		setItem(key, value) {
			entries.set(key, String(value));
		},
	};
}

type Scenario =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm';

/** PROTOTYPE: The same scenarios can inspect createRunHost through a temporary fetch shim. */
export async function exerciseRuns({
	base,
	scenarios = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'],
	restart,
}: {
	base: string;
	scenarios?: Scenario[];
	restart?: () => Promise<void>;
}) {
	const originalFetch = globalThis.fetch;
	const storageDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		'localStorage',
	);
	const journal = memoryStorage();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: journal,
	});
	const admissions = new Map<string, string>();
	let requests = 0;
	let admissionRequests = 0;
	let ack: 'normal' | 'ambiguous' | 'blackholed' = 'normal';
	const replies: { method: string; status: number }[] = [];
	const counted = async (...args: Parameters<typeof fetch>) => {
		requests++;
		const [input, options] = args;
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			base,
		);
		const method =
			options?.method ?? (input instanceof Request ? input.method : 'GET');
		if (
			method === 'POST' &&
			/^\/\.runs\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
		) {
			admissionRequests++;
			if (typeof options?.body === 'string')
				admissions.set(url.pathname, options.body);
		}
		const response = await originalFetch(...args);
		if (
			method === 'POST' &&
			/^\/\.runs\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
		) {
			if (ack === 'ambiguous') return new Response('', { status: 503 });
			if (ack === 'blackholed') {
				const signal =
					options?.signal ??
					(input instanceof Request ? input.signal : undefined);
				assert(signal, 'Admission must have a timeout signal');
				return await new Promise<Response>((_resolve, reject) => {
					if (signal.aborted) return reject(signal.reason);
					signal.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				});
			}
		}
		replies.push({ method, status: response.status });
		return response;
	};
	globalThis.fetch = Object.assign(counted, originalFetch);
	const app = connect<typeof demo>({ app: 'runs-demo', url: `${base}/` });
	const pathOf = (id: string) => `/.runs/runs-demo/transcribe/${id}`;
	const sha256 = (bytes: Uint8Array) =>
		new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
	const binary = () =>
		new File(['PROTOTYPE bytes'], 'audio.bin', {
			type: 'application/octet-stream',
		});
	async function collect<Y, O>(
		run: Run<Y, O>,
		label: string,
		options?: { after?: number; signal?: AbortSignal },
	) {
		const events: RunEvent<Y, O>[] = [];
		for await (const event of run.events(options)) {
			console.log(`${label}: ${JSON.stringify(event)}`);
			events.push(event);
		}
		return events;
	}
	function contiguous(events: { seq: number }[], start = 1) {
		assert.deepEqual(
			events.map((event) => event.seq),
			Array.from({ length: events.length }, (_, index) => start + index),
		);
	}
	const passed: string[] = [];
	const pass = (scenario: string, message: string) => {
		passed.push(scenario);
		console.log(`PROTOTYPE ${scenario}: PASS: ${message}`);
	};
	try {
		if (scenarios.includes('a')) {
			const bytes = new TextEncoder().encode('hello from Epicenter');
			const run = app.transcribe.start({
				audio: new File([bytes], 'words.txt', { type: 'text/plain' }),
				delayMs: 5,
			});
			assert(app.transcribe.pending().some((pending) => pending.id === run.id));
			console.log(`a: pending ${JSON.stringify(app.transcribe.pending())}`);
			const events = await collect(run, 'a');
			assert.deepEqual(
				events.map((event) => event.type),
				[
					'uploading',
					'uploaded',
					'accepted',
					'started',
					'yielded',
					'yielded',
					'yielded',
					'yielded',
					'finished',
				],
			);
			const yields = events
				.filter((event) => event.type === 'yielded')
				.map((event) => event.value);
			const receipt = yields[0];
			assert(receipt?.kind === 'received');
			assert.equal(receipt.type.split(';')[0], 'text/plain');
			assert.deepEqual(receipt, {
				kind: 'received',
				name: 'words.txt',
				type: receipt.type,
				size: bytes.length,
				sha256: sha256(bytes),
			});
			assert.deepEqual(
				yields.slice(1),
				['hello', 'from', 'Epicenter'].map((chunk, index) => ({
					kind: 'text',
					index,
					chunk,
				})),
			);
			contiguous(events.filter((event) => 'seq' in event));
			const result = await run.result();
			assert.equal(result.error, null);
			assert.deepEqual(result.data, {
				text: 'hello from Epicenter',
				size: bytes.length,
				sha256: sha256(bytes),
			});
			assert(
				!app.transcribe.pending().some((pending) => pending.id === run.id),
			);
			pass(
				'a',
				'file receipt, ordered chunks, final result, and journal removal',
			);
		}
		if (scenarios.includes('b')) {
			const run = app.transcribe.start({
				audio: binary(),
				chunks: 3,
				delayMs: 5,
			});
			assert.equal((await run.result()).error, null);
			const path = pathOf(run.id);
			const input = admissions.get(path);
			assert(input);
			const same = await fetch(`${base}${path}`, {
				method: 'POST',
				body: input,
			});
			assert.equal(same.status, 200);
			const state = (await same.json()) as { id: string; state: string };
			assert.deepEqual(state, { id: run.id, state: 'finished' });
			assert.equal(
				(
					await fetch(`${base}${path}`, {
						method: 'POST',
						body: JSON.stringify({ ...JSON.parse(input), chunks: 4 }),
					})
				).status,
				409,
			);
			assert.equal(
				(
					await fetch(`${base}${path}/files/audio`, {
						method: 'PUT',
						headers: {
							'content-type': 'application/octet-stream',
							'content-length': '9',
							'x-epicenter-file-name': 'audio.bin',
						},
						body: 'different',
					})
				).status,
				409,
			);
			const events = await collect(app.transcribe.attach(run.id), 'b');
			assert.equal(
				events.filter((event) => event.type === 'started').length,
				1,
			);
			pass(
				'b',
				`duplicate state ${JSON.stringify(state)}; conflicts never re-execute`,
			);
		}
		if (scenarios.includes('c')) {
			const run = app.transcribe.start({
				audio: binary(),
				chunks: 10,
				delayMs: 300,
			});
			const stop = new AbortController();
			const before: Awaited<ReturnType<typeof collect>> = [];
			let yields = 0;
			let lastSeq = 0;
			for await (const event of run.events({ signal: stop.signal })) {
				console.log(`c before: ${JSON.stringify(event)}`);
				before.push(event);
				if ('seq' in event) lastSeq = event.seq;
				if (event.type === 'yielded' && ++yields === 2) stop.abort();
			}
			await Bun.sleep(1000);
			const after = await collect(app.transcribe.attach(run.id), 'c after', {
				after: lastSeq,
			});
			contiguous(
				after.filter((event) => 'seq' in event),
				lastSeq + 1,
			);
			const finished = after.at(-1);
			assert(finished?.type === 'finished');
			assert.equal(finished.result.error, null);
			assert.equal(
				finished.result.data?.text,
				Array.from(
					{ length: 10 },
					(_, index) => `chunk ${index + 1} of 10`,
				).join(' '),
			);
			const replay = await collect(app.transcribe.attach(run.id), 'c replay');
			assert.equal(
				replay.filter(
					(event) => event.type === 'yielded' && event.value.kind === 'text',
				).length,
				10,
			);
			contiguous([...before, ...after].filter((event) => 'seq' in event));
			pass(
				'c',
				'observer abort left execution alive; resume has no sequence gaps and all ten chunks',
			);
		}
		if (scenarios.includes('d')) {
			const run = app.transcribe.start({
				audio: binary(),
				chunks: 20,
				delayMs: 300,
			});
			const events = [];
			let cancelled = false;
			for await (const event of run.events()) {
				console.log(`d: ${JSON.stringify(event)}`);
				events.push(event);
				if (event.type === 'yielded' && !cancelled) {
					cancelled = true;
					assert.equal((await run.cancel()).error, null);
				}
			}
			const requested = events.findIndex(
				(event) => event.type === 'cancel-requested',
			);
			assert(requested >= 0 && requested < events.length - 1);
			assert.equal(events.at(-1)?.type, 'finished');
			assert.notEqual((await run.result()).error, null);
			assert(
				events.filter(
					(event) => event.type === 'yielded' && event.value.kind === 'text',
				).length < 20,
			);
			pass(
				'd',
				'cancel request precedes terminal Err and stops remaining chunks',
			);
		}
		if (scenarios.includes('e')) {
			assert(restart, 'Restart scenario needs a process restart callback');
			const run = app.transcribe.start({
				audio: binary(),
				chunks: 20,
				delayMs: 300,
			});
			const stop = new AbortController();
			for await (const event of run.events({ signal: stop.signal })) {
				console.log(`e before: ${JSON.stringify(event)}`);
				if (event.type === 'yielded' && event.value.kind === 'text') {
					stop.abort();
					break;
				}
			}
			const path = pathOf(run.id);
			const input = admissions.get(path);
			assert(input);
			await restart();
			const attached = app.transcribe.attach(run.id);
			assert.notEqual((await attached.result()).error, null);
			const events = await collect(attached, 'e recovered');
			assert.equal(events.at(-1)?.type, 'interrupted');
			assert.equal(
				events.filter((event) => event.type === 'started').length,
				1,
			);
			const duplicate = await fetch(`${base}${path}`, {
				method: 'POST',
				body: input,
			});
			assert.equal(duplicate.status, 200);
			assert.deepEqual(await duplicate.json(), {
				id: run.id,
				state: 'interrupted',
			});
			const again = await collect(
				app.transcribe.attach(run.id),
				'e after duplicate',
			);
			assert.equal(again.filter((event) => event.type === 'started').length, 1);
			assert.equal(again.at(-1)?.type, 'interrupted');
			pass(
				'e',
				'SIGKILL recovery interrupts; duplicate admission never reruns',
			);
		}
		if (scenarios.includes('f')) {
			const before = admissionRequests;
			const run = app.transcribe.attach(crypto.randomUUID());
			const events = await collect(run, 'f');
			assert.deepEqual(
				events.map((event) => event.type),
				['unknown'],
			);
			assert.notEqual((await run.result()).error, null);
			assert.equal(admissionRequests, before);
			pass('f', 'unknown id produces Err without admission');
		}
		if (scenarios.includes('g')) {
			for (const [audio, status] of [
				[
					new Blob([new Uint8Array(MAX_FILE_BYTES + 1)], { type: 'audio/wav' }),
					413,
				],
				[new Blob(['png'], { type: 'image/png' }), 415],
			] as const) {
				const events = await collect(
					app.transcribe.start({ audio }),
					`g ${status}`,
				);
				const failed = events.at(-1);
				assert(failed?.type === 'failed');
				assert.equal(failed.error.name, 'Refused');
				assert.equal(
					replies.findLast((reply) => reply.method === 'PUT')?.status,
					status,
				);
			}
			const before = requests;
			// @ts-expect-error PROTOTYPE: Deliberately exercise an ordinary call with a browser file instead of a host UploadedFile.
			const ordinary = await app.transcribe({ audio: binary() });
			assert.equal(ordinary.error?.name, 'Refused');
			assert.equal(requests, before);
			const direct = await fetch(`${base}/runs-demo/transcribe`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ audio: 'epicenter-file:fake' }),
			});
			const lines = (await direct.text())
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			assert.match(lines.at(-1)?.answer?.error?.message ?? '', /takes a file/);
			const listed = await fetch(`${base}/`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: {},
				}),
			});
			assert.equal(listed.status, 200);
			const tools = (await listed.json()) as {
				result: { tools: { name: string }[] };
			};
			assert(
				!tools.result.tools.some(
					(tool) => tool.name === 'runs-demo_transcribe',
				),
			);
			pass(
				'g',
				'size/type refusals, ordinary Blob guard, direct HTTP refusal, MCP omission',
			);
		}
		if (scenarios.includes('h')) {
			Object.defineProperty(globalThis, 'localStorage', {
				configurable: true,
				value: {
					...memoryStorage(),
					setItem() {
						throw new Error('PROTOTYPE: browser storage refused');
					},
				},
			});
			try {
				const before = requests;
				const events = await collect(
					app.transcribe.start({ audio: binary() }),
					'h',
				);
				assert.deepEqual(
					events.map((event) => event.type),
					['failed'],
				);
				assert.equal(requests, before);
			} finally {
				Object.defineProperty(globalThis, 'localStorage', {
					configurable: true,
					value: journal,
				});
			}
			pass('h', 'journal write failure sends no request');
		}
		if (scenarios.includes('i')) {
			const response = await fetch(`${base}${pathOf(crypto.randomUUID())}`, {
				headers: { Origin: 'http://evil.example' },
			});
			assert.equal(response.status, 403);
			pass('i', 'cross-origin run request refused by existing guards');
		}
		const runtime =
			process.env.EPICENTER_RUNTIME_DIR ??
			'/tmp/epicenter-runs-acceptance-runtime';
		const runDir = (id: string) => join(runtime, 'runs', 'runs-demo', id);
		for (const scenario of ['j', 'k'] as const) {
			if (!scenarios.includes(scenario)) continue;
			const before = admissionRequests;
			ack = scenario === 'j' ? 'ambiguous' : 'blackholed';
			const startedAt = Date.now();
			try {
				const run = app.transcribe.start({
					audio: binary(),
					chunks: 1,
					delayMs: 10,
				});
				const events = [];
				for await (const event of run.events({
					signal: AbortSignal.timeout(30_000),
				})) {
					console.log(`${scenario}: ${JSON.stringify(event)}`);
					events.push(event);
					assert.equal(
						app.transcribe.pending().some((entry) => entry.id === run.id),
						event.type !== 'finished',
					);
				}
				assert.deepEqual(
					events.map((event) => event.type),
					[
						'uploading',
						'uploaded',
						'accepted',
						'started',
						'yielded',
						'yielded',
						'finished',
					],
				);
				const last = events.at(-1);
				assert(last?.type === 'finished');
				assert.equal(last.result.error, null);
				assert.equal(admissionRequests - before, 1);
				const log = (
					await readFile(join(runDir(run.id), 'events.ndjson'), 'utf8')
				)
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line));
				assert.equal(
					log.filter((event) => event.type === 'accepted').length,
					1,
				);
				assert.equal(log.filter((event) => event.type === 'started').length, 1);
				assert(Date.now() - startedAt < 30_000);
				if (scenario === 'k') assert(Date.now() - startedAt >= 19_000);
				pass(scenario, `${ack} ack observes one execution and finishes Ok`);
			} finally {
				ack = 'normal';
			}
		}
		if (scenarios.includes('l')) {
			const before = admissionRequests;
			const id = crypto.randomUUID();
			journal.setItem(
				'epicenter.runs.prototype.v1',
				JSON.stringify([
					...app.transcribe.pending(),
					{
						id,
						app: 'runs-demo',
						action: 'transcribe',
						startedAt: new Date().toISOString(),
						files: [],
					},
				]),
			);
			const run = app.transcribe.attach(id);
			const events = await collect(run, 'l');
			assert.deepEqual(
				events.map((event) => event.type),
				['unknown'],
			);
			assert(app.transcribe.pending().some((entry) => entry.id === id));
			const lookups = requests;
			assert.notEqual((await run.result()).error, null);
			assert(requests > lookups, 'Unknown must not be memoized on the Run');
			assert(app.transcribe.pending().some((entry) => entry.id === id));
			assert.equal(admissionRequests, before);
			pass(
				'l',
				'unknown keeps the journal, rechecks on result, and sends no admission',
			);
		}
		if (scenarios.includes('m')) {
			const happy = app.transcribe.start({
				audio: binary(),
				chunks: 1,
				delayMs: 5,
			});
			assert.equal((await happy.result()).error, null);
			const bins = async (id: string) =>
				(await readdir(join(runDir(id), 'files'))).filter((name) =>
					name.endsWith('.bin'),
				);
			// The terminal log is published before the executor finishes record/file cleanup.
			const deadline = Date.now() + 2000;
			while ((await bins(happy.id)).length && Date.now() < deadline)
				await Bun.sleep(10);
			assert.deepEqual(await bins(happy.id), []);
			const cancelled = app.transcribe.start({
				audio: binary(),
				chunks: 20,
				delayMs: 300,
			});
			let requested = false;
			for await (const event of cancelled.events()) {
				if (event.type === 'yielded' && !requested) {
					requested = true;
					assert.equal((await cancelled.cancel()).error, null);
				}
			}
			assert(requested);
			assert.notEqual((await cancelled.result()).error, null);
			const log = (
				await readFile(join(runDir(cancelled.id), 'events.ndjson'), 'utf8')
			)
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			assert(Object.hasOwn(log.at(-1).answer, 'threw'));
			assert.equal((await bins(cancelled.id)).length, 1);
			pass(
				'm',
				'returned finish deletes input bytes; cancelled threw finish retains them',
			);
		}
		console.log(
			`PROTOTYPE acceptance: ${passed.length}/${scenarios.length} scenarios passed (${passed.join(', ')})`,
		);
	} finally {
		globalThis.fetch = originalFetch;
		if (storageDescriptor)
			Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
		else Reflect.deleteProperty(globalThis, 'localStorage');
	}
}

if (import.meta.main) {
	let child: ReturnType<typeof Bun.spawn> | undefined;
	try {
		const args = Bun.argv.slice(2);
		if (args.length && (args.length !== 2 || args[0] !== '--port'))
			throw new Error('Usage: acceptance.ts [--port 4798]');
		const port = args.length ? Number(args[1]) : 4798;
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error('Invalid acceptance port');
		const base = `http://127.0.0.1:${port}`;
		async function launch(fresh: boolean) {
			let output = '';
			child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, 'serve.ts'),
					'--port',
					String(port),
					'--root',
					'/tmp/epicenter-runs-acceptance',
					'--runtime',
					'/tmp/epicenter-runs-acceptance-runtime',
					...(fresh ? ['--fresh'] : []),
				],
				{ env: process.env, stdout: 'pipe', stderr: 'pipe' },
			);
			const processStarted = child;
			let announced = false;
			for (const stream of [processStarted.stdout, processStarted.stderr])
				if (stream && typeof stream !== 'number') {
					void (async () => {
						const reader = stream.getReader();
						const decoder = new TextDecoder();
						try {
							for (;;) {
								const { done, value } = await reader.read();
								output += decoder.decode(value, { stream: !done });
								announced = output.includes(`PROTOTYPE UI: ${base}/runs-demo/`);
								if (done) break;
							}
						} finally {
							reader.releaseLock();
						}
					})().catch((cause) => {
						output += String(cause);
					});
				}
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				if (processStarted.exitCode !== null) {
					await processStarted.exited;
					await Bun.sleep(10);
					throw new Error(`Serve exited before readiness:\n${output}`);
				}
				try {
					const response = await fetch(`${base}/`, {
						signal: AbortSignal.timeout(1000),
					});
					if (announced && response.ok) return;
				} catch {
					/* The scratch server may still be building. */
				}
				await Bun.sleep(100);
			}
			throw new Error(`Serve was not ready within 20 seconds:\n${output}`);
		}
		await launch(true);
		await exerciseRuns({
			base,
			restart: async () => {
				assert(child);
				child.kill('SIGKILL');
				await child.exited;
				await launch(false);
			},
		});
	} catch (cause) {
		console.error(
			`PROTOTYPE acceptance failed: ${cause instanceof Error ? cause.stack : String(cause)}`,
		);
		process.exitCode = 1;
	} finally {
		if (child && child.exitCode === null) {
			child.kill('SIGTERM');
			await Promise.race([child.exited, Bun.sleep(3000)]);
			if (child.exitCode === null) {
				child.kill('SIGKILL');
				await child.exited;
			}
		}
	}
}

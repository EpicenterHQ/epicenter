/**
 * Measure two days of page runs through the in-process host and browser client.
 * With --trace-slow, --trace-loop also samples event-loop delays.
 */
import { Database } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@epicenter/app/client';
import type { Ok } from 'wellcrafted/result';
import { linkAppPackage } from '../app-package.ts';
import { fixture, gitIn } from '../runner.test-support.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(name);
	return index < 0 ? fallback : (args[index + 1] ?? fallback);
};
const polls = Number(option('--polls', '51840'));
if (!Number.isSafeInteger(polls) || polls < 1)
	throw new Error('--polls must be a positive integer');
const slowArgument = args.includes('--trace-slow')
	? Number(option('--trace-slow', ''))
	: undefined;
if (
	slowArgument !== undefined &&
	(!Number.isFinite(slowArgument) || slowArgument <= 0)
)
	throw new Error('--trace-slow must be a positive number of milliseconds');
const traceContext = new AsyncLocalStorage<number>();
const traces = new Map<
	number,
	{
		id?: string;
		requests: { method: string; status: number; elapsedMs: number }[];
		frames: { type: string; at: string }[];
	}
>();
let finishedCalls = 0;
const requestCounts = new Map<string, number>();
let longestHostRequest = 0;
const out = option('--out', join(tmpdir(), 'epicenter-runs-bench.log'));
await writeFile(out, '');
async function log(message: string) {
	process.stdout.write(`${message}\n`);
	await appendFile(out, `${message}\n`);
}
let lastTick = performance.now();
const loopMonitor =
	slowArgument === undefined || !args.includes('--trace-loop')
		? undefined
		: setInterval(() => {
				const nowTick = performance.now();
				const lag = nowTick - lastTick - 100;
				lastTick = nowTick;
				if (lag > 250)
					void log(
						`event-loop at=${new Date().toISOString()} lagMs=${lag.toFixed(3)}`,
					);
			}, 100);
loopMonitor?.unref();
const percentile = (values: number[], fraction: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
};
const metrics = (values: number[]) =>
	`p50=${percentile(values, 0.5).toFixed(3)}ms p95=${percentile(values, 0.95).toFixed(3)}ms max=${Math.max(0, ...values).toFixed(3)}ms`;
const f = await fixture();
await gitIn(f.home, 'init', '-q');
const runtime = join(f.root, 'runtime');
process.env.EPICENTER_ROOT = f.home;
process.env.EPICENTER_RUNTIME_DIR = runtime;
await f.app(
	'bench',
	`
const base = Array.from({length: 240}, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('Message ' + i + ': ' + 'A deterministic chat history. '.repeat(32)).slice(0, 975) }));
export default defineApp({ description:'Benchmark', collections:{}, actions:{
 poll: defineAction({ description:'Read chat', input:{ version:field.integer() }, run:({version}) => Ok(({ messages: [...base, ...Array.from({length:version}, (_, i) => ({role:'assistant', content:'Appended message ' + i}))] })) }),
 stream: defineAction({ description:'Stream tokens', input:{}, async *run() { const latency = []; for (let i=0; i<500; i++) { const started = performance.now(); yield {token:'token', index:i}; latency.push(performance.now()-started); } return Ok(latency); } }),
} });`,
);
await linkAppPackage(join(f.apps, 'bench', 'code'));
const { createRunHost } = await import('../runs.ts');
let now = Date.now();
let host = createRunHost({ now: () => now });
await host.ready;
const originalFetch = globalThis.fetch;
let refusals = 0;
const ids: string[] = [];
globalThis.fetch = (async (
	input: string | URL | Request,
	init?: RequestInit,
) => {
	const request = new Request(input, init);
	const path = new URL(request.url).pathname;
	if (request.method === 'POST' && !request.url.endsWith('/cancel'))
		ids.push(path.split('/').at(-1)!);
	const index = traceContext.getStore();
	const trace = index === undefined ? undefined : traces.get(index);
	if (trace && request.method === 'POST') trace.id = path.split('/').at(-1);
	const started = performance.now();
	const response = await host.handle(request);
	const elapsedMs = performance.now() - started;
	const method = `${request.method}${path.endsWith('/events') ? ' /events' : ''}`;
	trace?.requests.push({ method, status: response.status, elapsedMs });
	if (trace) {
		const key = `${method} ${response.status}`;
		requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
		longestHostRequest = Math.max(longestHostRequest, elapsedMs);
	}
	if (!trace || !response.body || !response.ok) return response;
	const decoder = new TextDecoder();
	let buffered = '';
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				let end = buffered.indexOf('\n');
				while (end >= 0) {
					const line = buffered.slice(0, end);
					buffered = buffered.slice(end + 1);
					const type = /"type":"([^"]+)"/.exec(line.slice(0, 200))?.[1];
					if (type) trace.frames.push({ type, at: new Date().toISOString() });
					end = buffered.indexOf('\n');
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}) as typeof fetch;
const app = connect<{
	actions: {
		poll: (input: { version: number }) => Ok<{ messages: unknown[] }>;
		stream: () => Promise<Ok<number[]>>;
	};
}>({ app: 'bench', url: 'http://127.0.0.1:4747/' });
const dbPath = join(runtime, 'runs.sqlite');
async function sizes() {
	return Promise.all(
		['', '-wal', '-shm'].map(
			async (suffix) =>
				(await stat(dbPath + suffix).catch(() => undefined))?.size ?? 0,
		),
	);
}
async function sizeLine(label: string) {
	const [db, wal, shm] = await sizes();
	await log(`${label}: db=${db} wal=${wal} shm=${shm} bytes`);
}
function counts() {
	const db = new Database(dbPath, { readonly: true });
	try {
		return {
			payloads: db
				.query<{ n: number }, []>('SELECT count(*) AS n FROM payloads')
				.get()!.n,
			events: db
				.query<{ n: number }, []>('SELECT count(*) AS n FROM events')
				.get()!.n,
		};
	} finally {
		db.close();
	}
}
async function checkpoint() {
	const db = new Database(dbPath);
	try {
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	} finally {
		db.close();
	}
}
async function batch(day: number) {
	const latencies: number[] = [];
	const start = performance.now();
	let next = 0;
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			for (;;) {
				const index = next++;
				if (index >= polls) return;
				const at = performance.now();
				const startedAt = new Date().toISOString();
				const traceId = (day - 1) * polls + index;
				if (slowArgument !== undefined)
					traces.set(traceId, { requests: [], frames: [] });
				const result =
					slowArgument === undefined
						? await app.poll({ version: Math.floor(index / 60) })
						: await traceContext.run(traceId, () =>
								app.poll({ version: Math.floor(index / 60) }),
							);
				const elapsedMs = performance.now() - at;
				const endedAt = new Date().toISOString();
				latencies.push(elapsedMs);
				if (result.error !== null) refusals++;
				if (slowArgument !== undefined) {
					const trace = traces.get(traceId);
					traces.delete(traceId);
					const completed = ++finishedCalls;
					if (elapsedMs >= slowArgument)
						await log(
							`slow day=${day} index=${index} start=${startedAt} end=${endedAt} elapsedMs=${elapsedMs.toFixed(3)} id=${trace?.id ?? 'unknown'} reconnects=${trace?.requests.filter((request) => request.method === 'GET /events').length ?? 0} requests=${JSON.stringify(trace?.requests ?? [])} frames=${JSON.stringify(trace?.frames ?? [])}`,
						);
					if (completed % 1000 === 0) {
						const memory = process.memoryUsage();
						await log(
							`memory completed=${completed} at=${endedAt} heapUsed=${memory.heapUsed} rss=${memory.rss}`,
						);
					}
				}
			}
		}),
	);
	const elapsed = (performance.now() - start) / 1000;
	if (slowArgument !== undefined)
		await log(
			`request-summary day=${day} counts=${JSON.stringify(Object.fromEntries(requestCounts))} maxHostMs=${longestHostRequest.toFixed(3)}`,
		);
	await log(
		`day ${day}: polls=${polls} wall=${elapsed.toFixed(3)}s calls/s=${(polls / elapsed).toFixed(2)} latency ${metrics(latencies)} refusals=${refusals}`,
	);
}
try {
	await log(
		`bun=${Bun.version} node=${process.version} polls=${polls} concurrency=8`,
	);
	await batch(1);
	const dayOne = ids[0]!;
	const stream: number[] = [];
	let streamIndex = 0;
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			while (streamIndex++ < 20) {
				const result = await app.stream();
				if (result.error !== null)
					throw new Error(JSON.stringify(result.error));
				stream.push(...result.data);
			}
		}),
	);
	await log(
		`stream: runs=20 yields=${stream.length} latency ${metrics(stream)}`,
	);
	await sizeLine('day 1 running');
	const first = counts();
	await log(`day 1 rows: payloads=${first.payloads} events=${first.events}`);
	host.stop();
	await Bun.sleep(20);
	await sizeLine('day 1 stopped');
	await checkpoint();
	await sizeLine('day 1 checkpoint');
	now += 25 * 60 * 60 * 1000;
	host = createRunHost({ now: () => now });
	await host.ready;
	const gone = await host.handle(
		new Request(`http://127.0.0.1:4747/.runs/bench/poll/${dayOne}`),
	);
	await log(`day 1 after GC: status=${gone.status}`);
	const firstDayTwo = ids.length;
	await batch(2);
	const dayTwo = ids[firstDayTwo]!;
	await sizeLine('day 2 running');
	const second = counts();
	await log(`day 2 rows: payloads=${second.payloads} events=${second.events}`);
	host.stop();
	await Bun.sleep(20);
	await sizeLine('day 2 stopped');
	await checkpoint();
	await sizeLine('day 2 checkpoint');
	now += 24 * 60 * 60 * 1000;
	host = createRunHost({ now: () => now });
	await host.ready;
	await sizeLine('day 3 at 24h');
	const replay = await host.handle(
		new Request(`http://127.0.0.1:4747/.runs/bench/poll/${dayTwo}/events`),
	);
	const frames = (await replay.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	await log(
		`day 2 replay: status=${replay.status} terminal=${frames.at(-1)?.type}`,
	);
	const terminal = frames.at(-1);
	const answer = terminal?.answer;
	const result = answer?.result ?? answer;
	if (
		gone.status !== 404 ||
		replay.status !== 200 ||
		terminal?.type !== 'finished' ||
		result?.error !== null ||
		refusals
	)
		throw new Error('Benchmark verification failed');
	host.stop();
	await Bun.sleep(20);
	now += 60 * 60 * 1000;
	host = createRunHost({ now: () => now });
	await host.ready;
	await sizeLine('day 3 after 25h GC');
	const expired = await host.handle(
		new Request(`http://127.0.0.1:4747/.runs/bench/poll/${dayTwo}`),
	);
	await log(`day 2 after 25h GC: status=${expired.status}`);
	if (expired.status !== 404)
		throw new Error('Day 2 did not expire after 25 hours');
} finally {
	clearInterval(loopMonitor);
	host.stop();
	globalThis.fetch = originalFetch;
	await Bun.sleep(20);
	await rm(f.root, { recursive: true, force: true });
}

/**
 * Open Benchmark: how long a replica of many notes takes to open in Bun,
 * and how much JavaScript heap it keeps and peaks at.
 *
 * Builds (once, cached under the system's temporary directory) a replica
 * database of N synced notes, each a small Markdown note with frontmatter
 * and a body of a few hundred bytes, written straight into the replica's
 * tables. Then opens it in a fresh process, so nothing of the build is in
 * the heap, and reports:
 *
 * - open: milliseconds for `openReplica` (schema, views, start-up reads)
 * - heap after open: the heap (with the memory its strings hold outside
 *   it) once a full collection has run: what the open replica keeps
 * - peak heap: the largest heap sampled while opening and after it (every
 *   allocation the open made before a collection could free it)
 * - peak RSS: the process's maximum resident set
 *
 * Run: bun scripts/bench-open.ts [notes=100000]
 *
 * Three more cases, each in two fresh processes (one unsampled for its
 * time, one sampled for its peak), report time and peak heap
 * (the heap at every read, and with what its strings hold outside it at
 * most every 25 ms, since that measure itself takes milliseconds):
 *
 * - session: a page session over the opened replica with the notes in a
 *   `memory: false` collection: its snapshot, then 200 writes each heard
 *   as a delta (paths only, no rows)
 * - catch-up: a fresh replica's full catch-up from a server holding the
 *   notes (the server is built first, then the heap measured from there)
 * - reset: the opened replica's full catch-up from a server that holds none
 *   of them (a server reset), so every local note is absent from the listing
 */

import { heapSize, heapStats } from 'bun:jsc';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unwrap } from 'wellcrafted/result';
import { openBunSqlite } from '../src/bun/sqlite.js';
import { servePage } from '../src/client/page.js';
import {
	openReplica,
	type Replica,
	type Reply,
	type Request,
} from '../src/client/replica.js';
import { commitId } from '../src/core/commit.js';
import { fold } from '../src/core/door.js';
import { gitBlobHash } from '../src/core/hash.js';
import { compileTemplate } from '../src/core/templates.js';
import type { Server } from '../src/server/server.js';
import { createTestServer, writer } from '../src/sim/harness.js';

// The account every hello names: the server's sessions are 'reader'.
const binding = { repository: 'bench', server: null, account: 'reader' };
const options = (filename: string) => ({
	driver: openBunSqlite(filename),
	binding,
	device: 'bench',
	app: {
		lenses: [
			{
				name: 'notes',
				view: `CREATE TEMP VIEW "notes" AS SELECT path, json_extract(fields, '$."title"') AS "title", body FROM "epicenter/files" WHERE text IS NOT NULL AND path LIKE 'notes/%'`,
			},
		],
	},
	after: () => {},
	now: () => 0,
});

function note(i: number) {
	const words = Array.from(
		{ length: 60 },
		(_, w) => `word${(i * 31 + w * 7) % 997}`,
	).join(' ');
	return `---\ntitle: Note ${i}\ncreatedAt: 2026-01-01T00:00:00Z\ndone: ${i % 2 === 0}\n---\n${words}\n`;
}

function build(filename: string, count: number) {
	const opened = openReplica(options(filename));
	if (opened.error !== null) throw new Error(opened.error.message);
	opened.data.close();
	const driver = openBunSqlite(filename);
	const columns = new Set(
		driver
			.all<{ name: string }>(`PRAGMA table_info("epicenter/files")`)
			.map((c) => c.name),
	);
	const withFold = columns.has('fold');
	driver.transaction(() => {
		for (let i = 0; i < count; i++) {
			const path = `notes/n${String(i).padStart(6, '0')}.md`;
			const text = note(i);
			const fields = JSON.stringify({
				title: `Note ${i}`,
				createdAt: '2026-01-01T00:00:00Z',
				done: i % 2 === 0,
			});
			if (withFold)
				driver.run(
					'INSERT INTO "epicenter/files" (path, fold, text, fields, base, hash) VALUES (?, ?, ?, ?, ?, ?)',
					[path, fold(path), text, fields, text, gitBlobHash(text)],
				);
			else
				driver.run(
					'INSERT INTO "epicenter/files" (path, text, fields, base, hash) VALUES (?, ?, ?, ?, ?)',
					[path, text, fields, text, gitBlobHash(text)],
				);
		}
		driver.run(
			`INSERT OR REPLACE INTO "epicenter/replica" (key, value) VALUES ('position', 'p1')`,
		);
	});
	driver.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	driver.close();
}

/** The JavaScript heap in use, with the memory its strings and buffers hold outside it. */
const used = () => {
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
};

function measure(filename: string) {
	Bun.gc(true);
	const before = used();
	let peak = before;
	const sample = () => {
		const size = used();
		if (size > peak) peak = size;
	};
	const sampler = setInterval(sample, 1);
	const started = performance.now();
	// Sample inside the open too: the driver's reads are where it allocates.
	const driver = openBunSqlite(filename);
	const sampled: typeof driver = {
		...driver,
		all: (sql, params) => {
			const rows = driver.all(sql, params);
			sample();
			return rows as never;
		},
	};
	const opened = openReplica({ ...options(filename), driver: sampled });
	const open = performance.now() - started;
	sample();
	clearInterval(sampler);
	if (opened.error !== null) throw new Error(opened.error.message);
	Bun.gc(true);
	const after = used();
	sample();
	// The replica must stay reachable through the collection above.
	const paths = opened.data.paths().length;
	opened.data.close();
	console.log(
		JSON.stringify({
			notes: paths,
			openMs: Math.round(open),
			heapAfterOpen: mb(after - before),
			peakHeap: mb(peak - before),
			peakRss: mb(process.resourceUsage().maxRSS * 1024),
		}),
	);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Run `work`, sampling the heap every millisecond and at each `sample()` it calls; report its time and peak above where it started. */
async function peakOf(label: string, work: (sample: () => void) => unknown) {
	// Sampling costs time that grows with the heap (the catch-up's server is in this process): a case runs once for its time, unsampled, and once for its peak.
	if (process.env.BENCH_SAMPLE === '0') {
		const started = performance.now();
		const result = await work(() => {});
		console.log(
			JSON.stringify({
				case: label,
				ms: Math.round(performance.now() - started),
				...(result as object),
			}),
		);
		return;
	}
	Bun.gc(true);
	const before = used();
	let peak = before;
	let last = 0;
	const take = () => {
		const size = used();
		if (size > peak) peak = size;
	};
	// The full measure (strings held outside the heap too) costs milliseconds as the heap grows: the heap alone at each read, the full measure at most every 25 ms.
	const sample = () => {
		const size = heapSize();
		if (size > peak) peak = size;
		const now = performance.now();
		if (now - last < 25) return;
		take();
		last = performance.now();
	};
	const sampler = setInterval(take, 25);
	const started = performance.now();
	const result = await work(sample);
	const ms = performance.now() - started;
	take();
	clearInterval(sampler);
	console.log(
		JSON.stringify({
			case: label,
			sampledMs: Math.round(ms),
			peakHeap: mb(peak - before),
			peakRss: mb(process.resourceUsage().maxRSS * 1024),
			...(result as object),
		}),
	);
}

/** A driver that samples the heap after each read. */
function sampling(filename: string | undefined, sample: () => void) {
	const driver = openBunSqlite(filename);
	return {
		...driver,
		all: ((sql: string, params?: never[]) => {
			const rows = driver.all(sql, params);
			sample();
			return rows;
		}) as typeof driver.all,
	};
}

const NOTES = {
	name: 'notes',
	view: options('').app.lenses[0]?.view ?? '',
	template: unwrap(compileTemplate('notes/{stem}.md')),
	memory: false,
};

async function session(filename: string) {
	await peakOf('session', (sample) => {
		const replica = unwrap(
			openReplica({ ...options(filename), driver: sampling(filename, sample) }),
		);
		const page = servePage(replica, [NOTES]);
		const snapshot = page.snapshot();
		let deltas = 0;
		let rows = 0;
		page.watch((delta) => {
			deltas++;
			rows += Object.keys(delta.rows).length;
			sample();
		});
		const count =
			replica.query<{ n: number }>('SELECT count(*) AS n FROM notes')[0]?.n ??
			1;
		for (let i = 0; i < 200; i++)
			page.change([
				{
					kind: 'patch',
					path: `notes/n${String((i * 397) % count).padStart(6, '0')}.md`,
					fields: { done: i % 3 === 0 },
				},
			]);
		replica.close();
		return { snapshotRows: snapshot.rows.length, deltas, deltaRows: rows };
	});
}

/** Answer what `replica` sends from `server`, until it sends nothing. */
function serve(
	replica: Replica,
	server: Server,
	user: string,
	sample: () => void,
) {
	const sent: Request[] = [];
	replica.attach((request) => sent.push(request));
	unwrap(
		replica.hello({
			repository: 'bench',
			server: 'bench',
			user,
			main: server.main(),
		}),
	);
	for (
		let request = sent.shift();
		request !== undefined;
		request = sent.shift()
	) {
		const reply: Reply =
			request.type === 'push'
				? {
						type: 'answer',
						rid: request.rid,
						answer: server.push(request.commit, writer(user)),
					}
				: request.type === 'catch-up'
					? {
							type: 'caught-up',
							rid: request.rid,
							catchUp: server.catchUp(request),
						}
					: {
							type: 'fetched',
							rid: request.rid,
							texts: server.fetch(request.hashes),
						};
		sample();
		replica.reply(reply);
	}
}

const unlimited = { burst: 1e9, rate: 1e9, readBurst: 1e9, readRate: 1e9 };

async function catchUp(count: number) {
	const server = createTestServer({ limits: unlimited });
	for (let start = 0; start < count; start += 1000) {
		const files = Array.from(
			{ length: Math.min(1000, count - start) },
			(_, k) => ({
				path: `notes/n${String(start + k).padStart(6, '0')}.md`,
				text: note(start + k),
			}),
		);
		const body = {
			parent: server.main(),
			author: { user: 'seed', device: 'seed' },
			time: new Date(0).toISOString(),
			files,
		};
		server.push({ id: commitId(body), ...body }, writer('seed'));
	}
	await peakOf('catch-up', (sample) => {
		const replica = unwrap(
			openReplica({ ...options(''), driver: sampling(undefined, sample) }),
		);
		serve(replica, server, 'reader', sample);
		const notes = replica.paths().length;
		replica.close();
		return { notes };
	});
}

async function reset(filename: string) {
	const server = createTestServer({ limits: unlimited });
	await peakOf('reset', (sample) => {
		const replica = unwrap(
			openReplica({ ...options(filename), driver: sampling(filename, sample) }),
		);
		serve(replica, server, 'reader', sample);
		const left = replica.paths().length;
		replica.close();
		return { notesLeft: left };
	});
}

const [mode, arg] = process.argv.slice(2);
if (mode === '--open' && arg !== undefined) measure(arg);
else if (mode === '--session' && arg !== undefined) await session(arg);
else if (mode === '--catch-up' && arg !== undefined) await catchUp(Number(arg));
else if (mode === '--reset' && arg !== undefined) await reset(arg);
else {
	const count = Number(mode ?? 100_000);
	const directory = join(tmpdir(), 'epicenter-bench-open');
	mkdirSync(directory, { recursive: true });
	const filename = join(
		directory,
		`replica-${count}-${process.env.BENCH_SCHEMA ?? 'current'}.sqlite`,
	);
	if (process.env.BENCH_REBUILD === '1' || !existsSync(filename)) {
		for (const suffix of ['', '-wal', '-shm'])
			rmSync(filename + suffix, { force: true });
		const started = performance.now();
		build(filename, count);
		console.log(
			`built ${count} notes in ${Math.round(performance.now() - started)} ms: ${filename}`,
		);
	}
	const once = (sample: string, args: string[]) =>
		process.stdout.write(
			Bun.spawnSync(['bun', import.meta.path, ...args], {
				stdout: 'pipe',
				stderr: 'inherit',
				env: { ...process.env, BENCH_SAMPLE: sample },
			}).stdout.toString(),
		);
	const run = (...args: string[]) => once('1', args);
	for (let i = 0; i < 3; i++) run('--open', filename);
	const scratch = `${filename}.scratch`;
	const copy = () => {
		for (const suffix of ['', '-wal', '-shm'])
			rmSync(scratch + suffix, { force: true });
		copyFileSync(filename, scratch);
	};
	for (const kind of process.env.BENCH_CASES?.split(',') ?? [
		'session',
		'catch-up',
		'reset',
	])
		for (const sample of ['0', '1']) {
			if (kind === 'catch-up') once(sample, ['--catch-up', String(count)]);
			else {
				// Each case writes, so it runs on a copy of the built replica.
				copy();
				once(sample, [`--${kind}`, scratch]);
			}
		}
}

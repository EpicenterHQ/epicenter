/**
 * Repository Benchmarks (phase 0a: live commits, no stored notices, a retention window)
 *
 * 1. A busy note: 2, 5 and 10 people type into their own line of one note
 *    at 5 keystrokes a second, saved every 300 ms, at 150 ms one-way latency,
 *    with no loss. Each save commits (amending while a commit is in
 *    flight). Reports requests per applied commit (pushes,
 *    catch-ups, reads by hash), how long until typing is on the server and
 *    on every device, the longest any typist's text stays off the server,
 *    and the live history written per minute. Virtual time; the server
 *    answers instantly.
 * 2. Catch-up from a position as a tree diff: a server of 5,000 or 50,000
 *    notes, a device 1, 100 or 5,000 commits behind (one changed note each),
 *    every position inside the retention window, and a device whose position
 *    left it (a full listing). Reports the server's time for all pages, the
 *    pages, reply bytes (paths, hashes and the commit ids passed) and the
 *    texts read by hash.
 *
 * Run: bun run src/sim/bench.ts
 */
import { commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { createTestServer, createWorld, EPOCH, STAMP, writer } from './harness.js';
import { LIMITS } from '../server/server.js';

// ============================================================================
// 1. A busy note
// ============================================================================

const PATH = 'notes/shared.md';
const percentile = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
};

function typists(count: number, { seconds = 20, latency = 150, seed = 1 } = {}) {
	const world = createWorld({ seed, latency: { min: latency - 10, max: latency + 10 } });
	const devices = Array.from({ length: count }, (_, i) => world.device(`typist${i}`));
	const first = devices[0];
	if (first === undefined) throw new Error('no typists');
	world.net.runFor(1_000);
	first.replica.write(PATH, `---\ntitle: Shared\n---\n${devices.map((d) => `${d.name}:`).join('\n')}\n`);
	world.net.runFor(3_000);
	const baseline = world.counts();
	const history0 = world.server.history();
	const stats0 = devices.map((d) => d.replica.stats());

	const lineOf = (text: string | null, name: string) => text?.split('\n').find((line) => line.startsWith(`${name}:`)) ?? '';
	/** Saves: who, how long their line is after it, when it was saved, and when it reached the server and everyone. */
	const chunks: { name: string; length: number; at: number; server?: number; everyone?: number }[] = [];
	const start = world.net.now();
	const end = start + seconds * 1_000;
	devices.forEach((device, i) => {
		let typed = 0;
		const tick = () => {
			if (world.net.now() >= end) return;
			// 5 keystrokes a second, saved every 300 ms: 1 or 2 characters a save.
			const keys = typed % 2 === 0 ? 1 : 2;
			typed++;
			const text = device.replica.read(PATH) ?? '';
			const line = lineOf(text, device.name);
			const next = line + 'x'.repeat(keys);
			device.replica.write(PATH, text.replace(`${line}\n`, `${next}\n`));
			chunks.push({ name: device.name, length: next.length, at: world.net.now() });
			world.net.after(300, tick);
		};
		world.net.after((i * 300) / count, tick);
	});

	const watch = () => {
		const server = world.server.read(PATH);
		const now = world.net.now();
		for (const chunk of chunks) {
			if (chunk.server === undefined && lineOf(server, chunk.name).length >= chunk.length) chunk.server = now;
			if (chunk.everyone === undefined && devices.every((d) => lineOf(d.replica.read(PATH), chunk.name).length >= chunk.length))
				chunk.everyone = now;
		}
	};
	const equal = () => {
		const server = world.server.read(PATH);
		return devices.every((d) => {
			const file = d.replica.files().get(PATH);
			return file?.mine === server && file?.base === server && !d.replica.busy();
		});
	};
	while (world.net.now() < end) {
		world.net.runFor(10);
		watch();
	}
	while (!equal() && world.net.now() < end + 120_000) {
		world.net.runFor(10);
		watch();
	}
	const quiet = world.net.now() - end;

	const counts = world.counts();
	const applied = devices.map((d, i) => {
		const s = d.replica.stats();
		const s0 = stats0[i];
		return s.applied + s.merged - (s0 === undefined ? 0 : s0.applied + s0.merged);
	});
	const total = applied.reduce((a, b) => a + b, 0);
	const requests = counts.push - baseline.push + (counts['catch-up'] - baseline['catch-up']) + (counts.fetch - baseline.fetch);
	const toServer = chunks.flatMap((c) => (c.server === undefined ? [] : [c.server - c.at]));
	const toEveryone = chunks.flatMap((c) => (c.everyone === undefined ? [] : [c.everyone - c.at]));
	const text = world.server.read(PATH) ?? '';
	const history = world.server.history();
	const minutes = (world.net.now() - start) / 60_000;
	return {
		typists: count,
		saves: chunks.length,
		'applied commits': total,
		'per typist min/max': `${Math.min(...applied)}/${Math.max(...applied)}`,
		pushes: counts.push - baseline.push,
		'catch-ups': counts['catch-up'] - baseline['catch-up'],
		'reads by hash': counts.fetch - baseline.fetch,
		'requests / applied commit': +(requests / total).toFixed(2),
		'to server p50/p95 ms': `${percentile(toServer, 50)}/${percentile(toServer, 95)}`,
		'to everyone p50/p95 ms': `${percentile(toEveryone, 50)}/${percentile(toEveryone, 95)}`,
		'worst save ms': Math.max(...toServer),
		'quiet after typing ms': quiet,
		'live commits / min': Math.round((history.commits - history0.commits) / minutes),
		'live KB / min': Math.round((history.bytes - history0.bytes) / 1024 / minutes),
		conflicts: (text.match(/<<<<<<< /g) ?? []).length,
		'all typed kept': devices.every((d) => lineOf(text, d.name).length >= Math.max(...chunks.filter((c) => c.name === d.name).map((c) => c.length))),
	};
}

console.log('\n1. A busy note, 150 ms one-way, 5 keys/s saved every 300 ms, 20 s of typing\n');
console.table([2, 5, 10].map((n) => typists(n)));

// ============================================================================
// 2. Catch-up as a tree diff
// ============================================================================

const body = (i: number, v = 0) => `---\ntitle: Note ${i}\nversion: ${v}\n---\n${'Some words of a note, about a line long. '.repeat(4)}\n`;
const author = { user: 'bench', device: 'bench' };

function catchUp(total: number, behind: number | 'outside the window') {
	let clock = 0;
	const server = createTestServer({
		clock: () => EPOCH + clock,
		// Seeding writes every note in one commit, so the request limits are lifted; the page stays at its default.
		limits: { request: Number.POSITIVE_INFINITY, files: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY },
	});
	const session = writer('bench');
	const path = (i: number) => `notes/${(i % 256).toString(16).padStart(2, '0')}/n${i}.md`;
	const commit = (files: LiveCommit['files']) => {
		const draft = { parent: server.main(), mode: 'fast-forward' as const, author, time: STAMP, files };
		const answer = server.push({ id: commitId(draft), ...draft }, session);
		if (answer.kind !== 'applied') throw new Error(`seeding failed: ${answer.kind}`);
	};
	commit(Array.from({ length: total }, (_, i) => ({ path: path(i), text: body(i) })));
	const position = server.main();
	const count = behind === 'outside the window' ? 100 : behind;
	for (let i = 0; i < count; i++) commit([{ path: path(i), text: body(i, 1) }]);
	if (behind === 'outside the window') {
		clock += LIMITS.window + 1;
		commit([{ path: path(0), text: body(0, 2) }]);
	}
	const all = () => {
		const pages = [server.catchUp({ from: position })];
		for (let page = pages[0]; page?.next != null; ) {
			page = server.catchUp({ from: position, to: pages[0]?.main, after: page.next });
			pages.push(page);
		}
		return pages;
	};
	const runs = 5;
	let pages = all();
	const t0 = performance.now();
	for (let n = 0; n < runs; n++) pages = all();
	const ms = (performance.now() - t0) / runs;
	const files = pages.flatMap((page) => page.files);
	const hashes = files.flatMap((f) => (f.hash === null ? [] : [f.hash]));
	const texts = server.fetch(hashes);
	const ids = JSON.stringify(pages.flatMap((page) => page.commits)).length;
	return {
		files: total,
		'commits behind': behind,
		full: pages[0]?.full,
		pages: pages.length,
		'paths in reply': files.length,
		'server ms': +ms.toFixed(2),
		'reply KB': +(JSON.stringify(pages).length / 1024).toFixed(1),
		'of which commit ids KB': +(ids / 1024).toFixed(1),
		'texts read': hashes.length,
		'read KB': +(JSON.stringify(texts).length / 1024).toFixed(1),
		check: hashes.every((h) => gitBlobHash(texts[h] ?? '') === h),
	};
}

console.log('\n2. Catch-up as a tree diff (256 directories, one changed note per commit, 1,000 paths a page)\n');
console.table([5_000, 50_000].flatMap((total) => ([1, 100, 5_000, 'outside the window'] as const).map((behind) => catchUp(total, behind))));

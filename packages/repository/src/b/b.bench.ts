/**
 * Design B Benchmarks
 *
 * 1. Typists on one note: 2, 5 and 10 people type into their own line of one
 *    note at 5 keystrokes a second, saved every 300 ms, at 150 ms one-way
 *    latency, with no loss. Reports requests per accepted write (writes,
 *    catch-ups and reads by hash), stale answers, how long until a chunk is
 *    on the server and on every device, and how long until everything is
 *    equal once typing stops, with and without a device yielding a random
 *    0-300 ms after each applied write. Virtual time; the server answers
 *    instantly.
 * 2. Catch-up by tree diff: a server of 5,000 or 50,000 notes, a device whose
 *    tree is 1, 100 or 5,000 changes behind. Reports the server's time to
 *    diff, directory entries compared, the catch-up reply's bytes, and the
 *    texts read by hash; also what one write costs to rehash the tree. Flat
 *    `notes/{stem}.md` (the app's layout) and sharded `notes/{xx}/{stem}.md`.
 *
 * Run: bun run src/b/b.bench.ts
 */
import { gitBlobHash } from '../hash.js';
import { createWorld } from './harness.js';
import { createServer } from './server.js';

// ============================================================================
// 1. Typists on one note
// ============================================================================

const PATH = 'notes/shared.md';
const percentile = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
};

function typists(count: number, { seconds = 20, latency = 150, seed = 1, yieldMs = 0 } = {}) {
	const world = createWorld({
		seed,
		latency: { min: latency - 10, max: latency + 10 },
		...(yieldMs === 0 ? {} : { yieldAfter: (random) => random.int(0, yieldMs) }),
	});
	const devices = Array.from({ length: count }, (_, i) => world.device(`typist${i}`));
	const first = devices[0];
	if (first === undefined) throw new Error('no typists');
	world.net.runFor(1_000);
	first.replica.write({ [PATH]: `---\ntitle: Shared\n---\n${devices.map((d) => `${d.name}:`).join('\n')}\n` });
	world.net.runFor(2_000);
	const baseline = world.counts();
	const stats0 = devices.map((d) => d.replica.stats());

	const lineOf = (text: string | null, name: string) => text?.split('\n').find((line) => line.startsWith(`${name}:`)) ?? '';
	/** Chunks typed: who, how long their line is after it, when it was saved, and when it reached the server and everyone. */
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
			device.replica.write({ [PATH]: text.replace(`${line}\n`, `${next}\n`) });
			chunks.push({ name: device.name, length: next.length, at: world.net.now() });
			world.net.after(300, tick);
		};
		world.net.after((i * 300) / count, tick);
	});

	/** Per typist: since when the server has been missing some of their typing, and the longest such stretch. */
	const behindSince = devices.map((): number | null => null);
	const longest = devices.map(() => 0);
	const watch = () => {
		const server = world.server.read(PATH);
		const now = world.net.now();
		devices.forEach((d, i) => {
			if (lineOf(server, d.name).length < lineOf(d.replica.read(PATH), d.name).length) {
				behindSince[i] ??= now;
				longest[i] = Math.max(longest[i] ?? 0, now - (behindSince[i] ?? now));
			} else behindSince[i] = null;
		});
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
	const sum = (key: 'writes' | 'applied' | 'stale' | 'catchUps' | 'fetches' | 'timeouts') =>
		devices.reduce((n, d, i) => n + d.replica.stats()[key] - (stats0[i]?.[key] ?? 0), 0);
	const applied = sum('applied');
	const requests = counts.write - baseline.write + (counts['catch-up'] - baseline['catch-up']) + (counts.fetch - baseline.fetch);
	const toServer = chunks.flatMap((c) => (c.server === undefined ? [] : [c.server - c.at]));
	const toEveryone = chunks.flatMap((c) => (c.everyone === undefined ? [] : [c.everyone - c.at]));
	const text = world.server.read(PATH) ?? '';
	const perTypist = devices.map((d, i) => d.replica.stats().applied - (stats0[i]?.applied ?? 0));
	return {
		typists: count,
		'yield ms': yieldMs === 0 ? 'none' : `0-${yieldMs}`,
		chunks: chunks.length,
		'applied writes': applied,
		'write requests': counts.write - baseline.write,
		'catch-ups': counts['catch-up'] - baseline['catch-up'],
		'reads by hash': counts.fetch - baseline.fetch,
		'applied per typist min/max': `${Math.min(...perTypist)}/${Math.max(...perTypist)}`,
		'requests / applied write': +(requests / applied).toFixed(2),
		'stale / write': +(sum('stale') / (counts.write - baseline.write)).toFixed(2),
		'to server p50/p95 ms': `${percentile(toServer, 50)}/${percentile(toServer, 95)}`,
		'to everyone p50/p95 ms': `${percentile(toEveryone, 50)}/${percentile(toEveryone, 95)}`,
		'longest unsynced ms': Math.max(...longest),
		'quiet after typing ms': quiet,
		conflicts: (text.match(/<<<<<<< /g) ?? []).length,
		'all typed kept': devices.every((d) => lineOf(text, d.name).length >= Math.max(...chunks.filter((c) => c.name === d.name).map((c) => c.length))),
	};
}

console.log('\n1. Typists on one note, 150 ms one-way, 5 keys/s saved every 300 ms, 20 s of typing\n');
console.table([0, 300].flatMap((yieldMs) => [2, 5, 10].map((n) => typists(n, { yieldMs }))));

// ============================================================================
// 2. Catch-up by tree diff
// ============================================================================

const body = (i: number, v = 0) => `---\ntitle: Note ${i}\nversion: ${v}\n---\n${'Some words of a note, about a line long. '.repeat(4)}\n`;

function catchUp(total: number, changed: number, layout: 'flat' | 'sharded') {
	const server = createServer();
	const path = (i: number) => (layout === 'flat' ? `notes/n${i}.md` : `notes/${(i % 256).toString(16).padStart(2, '0')}/n${i}.md`);
	const t0 = performance.now();
	server.write(
		'seed',
		Array.from({ length: total }, (_, i) => ({ path: path(i), expected: null, text: body(i) })),
	);
	const seeded = performance.now() - t0;
	const from = server.tree();
	// One write's cost: rehashing the tree from the changed file up to the root.
	const writes = 20;
	const trees = [from];
	const w0 = performance.now();
	for (let i = 0; i < writes; i++) {
		server.write('w', [{ path: path(i), expected: hashOf(server.read(path(i))), text: body(i, 1) }]);
		trees.push(server.tree());
	}
	const perWrite = (performance.now() - w0) / writes;
	// The rest of the changes, as one write.
	const rest = Array.from({ length: Math.max(0, changed - writes) }, (_, k) => k + writes);
	if (rest.length > 0) server.write('w', rest.map((i) => ({ path: path(i), expected: hashOf(server.read(path(i))), text: body(i, 1) })));
	// A device that many changes behind: before everything, or a few single writes back.
	const behind = changed >= writes ? from : (trees[writes - changed] as string);
	const runs = 10;
	let reply = server.catchUp({ from: behind });
	const c0 = performance.now();
	for (let n = 0; n < runs; n++) reply = server.catchUp({ from: behind });
	const diffMs = (performance.now() - c0) / runs;
	const hashes = reply.files.flatMap((f) => (f.hash === null ? [] : [f.hash]));
	const f0 = performance.now();
	const texts = server.fetch(hashes);
	const fetchMs = performance.now() - f0;
	return {
		layout,
		files: total,
		changed,
		'paths in reply': reply.files.length,
		'entries compared': reply.compared,
		'diff ms': +diffMs.toFixed(2),
		'reply KB': +(JSON.stringify(reply).length / 1024).toFixed(1),
		'texts read': hashes.length,
		'read KB': +(JSON.stringify(texts).length / 1024).toFixed(1),
		'read ms': +fetchMs.toFixed(2),
		'one write ms': +perWrite.toFixed(2),
		'seed ms': Math.round(seeded),
	};
}

const hashOf = (text: string | null) => (text === null ? null : gitBlobHash(text));

console.log('\n2. Catch-up by tree diff\n');
const rows = [];
for (const layout of ['flat', 'sharded'] as const)
	for (const total of [5_000, 50_000]) for (const changed of [1, 100, 5_000]) rows.push(catchUp(total, changed, layout));
console.table(rows);

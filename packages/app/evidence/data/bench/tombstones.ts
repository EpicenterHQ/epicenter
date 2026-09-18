/**
 * What a deleted row costs forever, and whether the deletion PATTERN matters.
 *
 * Run: `bun run evidence/bench/tombstones.ts`
 *
 * The authority's log growing is one accumulation and it is measured elsewhere
 * (`never-compact.ts`): the server has 10 GB and the log costs about 4 MB a
 * year. A tombstone is a DIFFERENT accumulation and a worse-shaped one, because
 * it is paid by every device, in memory, on every load, forever. A phone does
 * not have 10 GB of RAM.
 *
 * The number that decides it is not bytes. `evidence/bench/memory.ts` found
 * that memory tracks STRUCT COUNT rather than encoded size, at roughly 1 KB of
 * rss per item. So the question is whether a tombstone stays an item.
 *
 * METHOD, following `memory.ts` for the same reason it does:
 *   - One OS PROCESS PER CASE. Measuring several shapes in one process reports
 *     the allocator's high-water mark for the first and near zero after.
 *   - The corpus is built once and written to disk; the measuring process only
 *     reads bytes, so building never peaks inside the measurement.
 *   - Baseline after a forced GC, and both `rss` and `heapUsed` reported.
 *   - Every case is paired with a CONTROL shape that must differ, so a run
 *     where deletion silently did nothing cannot read as a good result.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from '@y/y';

import { putRow, rowAt, type ValuesType } from '../raw-document.js';

const RECORDING = {
	audioBlobId: 'blob_01JQ8ZXY3M4N5P6Q7R8S9T0V',
	title: 'Recording 2026-08-07 14:32',
	recordedAt: '2026-08-07T14:32:11.000Z',
	transcript: 'a couple of sentences of transcript text that is fairly typical',
	duration: 42.5,
};

type Pattern = 'none' | 'burst' | 'scattered' | 'interleaved' | 'dropped';

type Case = {
	label: string;
	/** Rows that exist at the end. */
	live: number;
	/** Rows created and then deleted. */
	dead: number;
	pattern: Pattern;
	note: string;
};

const CASES: Case[] = [
	{
		label: 'baseline',
		live: 1_000,
		dead: 0,
		pattern: 'none',
		note: '1,000 live, nothing ever deleted',
	},
	{
		label: 'burst',
		live: 1_000,
		dead: 9_000,
		pattern: 'burst',
		note: '9,000 created together, deleted together',
	},
	{
		label: 'scattered',
		live: 1_000,
		dead: 9_000,
		pattern: 'scattered',
		note: '9,000 deleted one at a time, spread out',
	},
	{
		label: 'interleaved',
		live: 1_000,
		dead: 9_000,
		pattern: 'interleaved',
		note: 'create one, delete one, ten thousand times',
	},
	{
		label: 'ten years',
		live: 2_000,
		dead: 73_000,
		pattern: 'interleaved',
		note: '20 recordings a day for a decade',
	},
	{
		label: 'ten/dropped',
		live: 2_000,
		dead: 73_000,
		pattern: 'dropped',
		note: 'the same decade, deleting the CONTAINER instead',
	},
];

/**
 * Build one shape.
 *
 * `deleteRow` here is what the store does: clear the fields and flag the row
 * absent (ADR-0212's clear-and-flag), not `deleteAttr` on the container. The
 * two reclaim differently, so measuring the wrong one would flatter the result.
 */
function buildDoc({ live, dead, pattern }: Case): Y.Doc {
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('recordings');
	let minted = 0;
	const id = () => `r${String(minted++).padStart(23, '0')}`;

	const create = (key: string) => {
		const row: ValuesType = new Y.Type();
		putRow(root, key, row);
		row.setAttr('!presence', 'present');
		for (const [field, value] of Object.entries(RECORDING)) {
			row.setAttr(field, value);
		}
	};
	const kill = (key: string) => {
		if (pattern === 'dropped') {
			// The alternative ADR-0212 left open: drop the container off the table
			// root instead of clearing it and flagging it absent. The row's whole
			// subtree goes with it, so what remains is one deleted map key rather
			// than a surviving container plus a tombstone per field.
			root.deleteAttr(key);
			return;
		}
		const row = rowAt(root, key);
		if (row === undefined) return;
		for (const field of [...row.attrKeys()]) {
			if (field !== '!presence') row.deleteAttr(field);
		}
		row.setAttr('!presence', 'absent');
	};

	if (pattern === 'none') {
		doc.transact(() => {
			for (let index = 0; index < live; index += 1) create(id());
		});
	} else if (pattern === 'burst') {
		const doomed: string[] = [];
		doc.transact(() => {
			for (let index = 0; index < dead; index += 1) {
				const key = id();
				doomed.push(key);
				create(key);
			}
		});
		doc.transact(() => {
			for (const key of doomed) kill(key);
		});
		doc.transact(() => {
			for (let index = 0; index < live; index += 1) create(id());
		});
	} else if (pattern === 'scattered') {
		// eslint-disable-line
		// Everything created together, then deleted one transaction at a time.
		const keys: string[] = [];
		doc.transact(() => {
			for (let index = 0; index < dead + live; index += 1) {
				const key = id();
				keys.push(key);
				create(key);
			}
		});
		for (let index = 0; index < dead; index += 1) {
			// Every other row, so the survivors sit between the casualties.
			doc.transact(() =>
				kill(keys[index * Math.floor(keys.length / dead)] ?? keys[index]!),
			);
		}
	} else {
		// The realistic shape: a device that makes something and throws something
		// away, over and over, for years. Every create and every delete is its own
		// transaction, so their clocks interleave.
		const alive: string[] = [];
		for (let index = 0; index < dead; index += 1) {
			const key = id();
			doc.transact(() => create(key));
			alive.push(key);
			if (alive.length > live) {
				const victim = alive.shift() as string;
				doc.transact(() => kill(victim));
			}
		}
		while (alive.length > live) {
			const victim = alive.shift() as string;
			doc.transact(() => kill(victim));
		}
		for (let index = alive.length; index < live; index += 1) {
			const key = id();
			doc.transact(() => create(key));
			alive.push(key);
		}
	}

	return doc;
}

/** The same shape, encoded, for a measuring process to read from disk. */
function build(testCase: Case): Uint8Array {
	const doc = buildDoc(testCase);
	const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	doc.destroy();
	return bytes;
}

/** Structs the engine is holding, which is what memory actually tracks. */
function itemCount(doc: Y.Doc): number {
	const clients = (
		doc as unknown as {
			store?: { clients?: Map<number, { length: number }[]> };
		}
	).store?.clients;
	let total = 0;
	for (const structs of clients?.values() ?? []) total += structs.length;
	return total;
}

/** Rows a workspace would actually return, so "live" is not taken on trust. */
function liveRows(doc: Y.Doc): number {
	const root = doc.get('recordings');
	let alive = 0;
	for (const key of root.attrKeys()) {
		const row = rowAt(root, String(key));
		// A dropped row leaves no key at all, so mere presence of the container
		// counts; a cleared row leaves the key and says so on the flag.
		const flag = row?.getAttr('!presence');
		if (flag === undefined || flag === 'present') alive += 1;
	}
	return alive;
}

if (process.argv[2] === '--measure') {
	const path = process.argv[3] ?? '';
	const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	Bun.gc(true);
	const before = process.memoryUsage();
	const started = performance.now();
	const doc = new Y.Doc({ gc: true });
	Y.applyUpdateV2(doc, bytes);
	const openMs = performance.now() - started;
	Bun.gc(true);
	const after = process.memoryUsage();
	console.log(
		JSON.stringify({
			encoded: bytes.length,
			rss: after.rss - before.rss,
			heap: after.heapUsed - before.heapUsed,
			items: itemCount(doc),
			live: liveRows(doc),
			openMs,
		}),
	);
	process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'epicenter-tomb-'));
try {
	console.log(
		`runtime  bun ${Bun.version} (${process.platform}/${process.arch}), JavaScriptCore`,
	);
	console.log(
		'a row is 6 fields plus a presence flag; deletion is clear-and-flag\n',
	);
	console.log(
		`  ${'shape'.padEnd(12)} ${'live'.padStart(6)} ${'dead'.padStart(7)} ${'encoded'.padStart(9)} ${'items'.padStart(9)} ${'rss'.padStart(8)} ${'heap'.padStart(8)} ${'open'.padStart(8)}  reads back`,
	);

	const measured: { testCase: Case; result: Record<string, number> }[] = [];
	for (const testCase of CASES) {
		const path = join(directory, `${testCase.label}.bin`);
		await Bun.write(path, build(testCase));
		const proc = Bun.spawnSync([
			process.execPath,
			import.meta.path,
			'--measure',
			path,
		]);
		const out = proc.stdout.toString().trim();
		if (!out) {
			console.log(
				`  ${testCase.label}: FAILED\n${proc.stderr.toString().slice(0, 400)}`,
			);
			continue;
		}
		const result = JSON.parse(out) as Record<string, number>;
		measured.push({ testCase, result });
		const mb = (n: number) =>
			Math.abs(n) >= 1048576
				? `${(n / 1048576).toFixed(1)} MB`
				: `${Math.round(n / 1024)} KB`;
		console.log(
			`  ${testCase.label.padEnd(12)} ${String(testCase.live).padStart(6)} ${testCase.dead.toLocaleString().padStart(7)} ${mb(result.encoded ?? 0).padStart(9)} ${(result.items ?? 0).toLocaleString().padStart(9)} ${mb(result.rss ?? 0).padStart(8)} ${mb(result.heap ?? 0).padStart(8)} ${`${(result.openMs ?? 0).toFixed(0)} ms`.padStart(8)}  ${(result.live ?? 0).toLocaleString()} rows`,
		);
	}

	console.log(
		'\n  what a single dead row costs, against the baseline of the same live set:',
	);
	const baseline = measured.find((entry) => entry.testCase.pattern === 'none');
	for (const { testCase, result } of measured) {
		if (baseline === undefined || testCase.dead === 0) continue;
		const extraBytes = (result.encoded ?? 0) - (baseline.result.encoded ?? 0);
		const extraItems = (result.items ?? 0) - (baseline.result.items ?? 0);
		console.log(
			`    ${testCase.label.padEnd(12)} ${(extraBytes / testCase.dead).toFixed(1).padStart(6)} B   ${(extraItems / testCase.dead).toFixed(3).padStart(6)} items   ${testCase.note}`,
		);
	}

	console.log('\n  CONTROLS');
	const control = (label: string, held: boolean) =>
		console.log(`    ${held ? 'held  ' : 'FAILED'}  ${label}`);
	// Deletion has to have actually happened, or every number above is a
	// measurement of nothing.
	control(
		'every shape reads back only its live rows',
		measured.every((entry) => entry.result.live === entry.testCase.live),
	);
	// A tombstone has to cost LESS than the row it replaces, or clear-and-flag is
	// not reclaiming and the comparison is measuring live data.
	const tenYears = measured.find(
		(entry) => entry.testCase.label === 'ten years',
	);
	const perLiveRow =
		(baseline?.result.encoded ?? 0) / Math.max(baseline?.testCase.live ?? 1, 1);
	control(
		`a dead row costs far less than a live one (${perLiveRow.toFixed(0)} B)`,
		tenYears !== undefined &&
			baseline !== undefined &&
			((tenYears.result.encoded ?? 0) - (baseline.result.encoded ?? 0)) /
				tenYears.testCase.dead <
				perLiveRow / 2,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

/**
 * Does rolling the log over reclaim any of this?
 *
 * This is the measurement the whole design turns on. Both rollovers show the
 * same rows to a person and differ in exactly one way, and that way decides
 * whether a device's offline work survives.
 */
{
	console.log('\n  rolling the log over, on the aged decade:');
	const aged = buildDoc({
		label: 'aged',
		live: 2_000,
		dead: 73_000,
		pattern: 'dropped',
		note: '',
	});

	// SNAPSHOT: re-encode the same structs. Identities survive, so a device
	// arriving with an offline edit merges onto the row it already knew.
	const genA = new Y.Doc({ gc: true });
	Y.applyUpdateV2(
		genA,
		new Uint8Array(Y.encodeStateAsUpdateV2(aged)) as Uint8Array<ArrayBuffer>,
	);

	// FUTURE COMPACT: write the values into a fresh document. New structs at new
	// identities, so an offline edit has nothing to attach to.
	const genB = new Y.Doc({ gc: true });
	const source = aged.get('recordings');
	genB.transact(() => {
		const root = genB.get('recordings');
		for (const key of source.attrKeys()) {
			const row = rowAt(source, String(key));
			if (row === undefined) continue;
			const fresh: ValuesType = new Y.Type();
			putRow(root, String(key), fresh);
			for (const field of row.attrKeys()) {
				fresh.setAttr(field, row.getAttr(field) ?? null);
			}
		}
	});

	const line = (label: string, doc: Y.Doc) =>
		console.log(
			`    ${label.padEnd(26)} ${itemCount(doc).toLocaleString().padStart(9)} items   ${(Y.encodeStateAsUpdateV2(doc).length / 1048576).toFixed(1).padStart(5)} MB`,
		);
	line('aged document', aged);
	line('rolled over by SNAPSHOT', genA);
	line('rolled over by FUTURE COMPACT', genB);
	console.log(
		`    ${'reclaimed by snapshot'.padEnd(26)} ${(itemCount(aged) - itemCount(genA)).toLocaleString().padStart(9)} items`,
	);
	console.log(
		`    ${'reclaimed by future Compact'.padEnd(26)} ${(itemCount(aged) - itemCount(genB)).toLocaleString().padStart(9)} items`,
	);

	const keysOf = (doc: Y.Doc) => [...doc.get('recordings').attrKeys()].length;
	// Both must show a person the same thing, or they are not alternatives and
	// the comparison is meaningless.
	console.log(
		`    ${keysOf(genA) === keysOf(genB) ? 'held  ' : 'FAILED'}  CONTROL both rollovers show the same ${keysOf(genA).toLocaleString()} rows`,
	);
	// And the aged document must really have been carrying tombstones.
	console.log(
		`    ${itemCount(aged) > keysOf(aged) * 10 ? 'held  ' : 'FAILED'}  CONTROL the aged document was mostly tombstone`,
	);
	aged.destroy();
	genA.destroy();
	genB.destroy();
}

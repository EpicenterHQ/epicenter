/**
 * What a hydrated application document costs in memory.
 *
 * Run: `bun run evidence/bench/memory.ts`
 *
 * METHOD, stated because the previous version of this number did not reproduce.
 * An earlier record reported 48 MB for a case an independent reviewer measured
 * at 182 MB, and neither of us had written down what we were measuring.
 *
 *   - One OS PROCESS PER CASE. Measuring several shapes in one process reports
 *     the allocator's high-water mark for the first one and near zero after,
 *     which is how the earlier figures went wrong.
 *   - The corpus is built once, written to disk as encoded bytes, and each
 *     measuring process reads those bytes. Building in-process peaks memory
 *     before the measurement starts.
 *   - The baseline is taken AFTER the bytes are read and a forced GC, so what
 *     is reported is the document, not the file.
 *   - Both `rss` and `heapUsed` are reported, because they disagree and hiding
 *     that is what made the earlier number unfalsifiable.
 *   - ITEMS is the engine-independent number and the one to quote. Memory here
 *     is driven by struct count rather than by bytes, and an item costs whatever
 *     the engine charges for a small object. Bun is JavaScriptCore; a Tauri
 *     WebView is JSC on macOS and Linux and V8 on Windows, so bytes-per-item is
 *     a property of the platform and items are a property of the data.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from '@y/y';

const NOTE = {
	title: 'A note title of typical length',
	tags: ['work', 'idea'],
	date: '2026-08-07',
};
const RECORDING = {
	audioBlobId: 'blob_01JQ8ZXY3M4N5P6Q7R8S9T0V',
	uploadedAt: null,
	title: 'Recording 2026-08-07 14:32',
	recordedAt: '2026-08-07T14:32:11.000Z',
	recordedAtZone: 'America/Los_Angeles',
	transcript: 'a couple of sentences of transcript text that is fairly typical',
	polishedTranscript: null,
	duration: 42.5,
	transcription: {
		status: 'completed',
		completedAt: '2026-08-07T14:32:59.000Z',
	},
};
const BODY = 'x'.repeat(2800);

type Case = { label: string; rows: number; fields: object; body: boolean };
const CASES: Case[] = [
	{ label: 'notes+bodies', rows: 986, fields: NOTE, body: true },
	{ label: 'notes+bodies', rows: 5000, fields: NOTE, body: true },
	{ label: 'notes+bodies', rows: 10000, fields: NOTE, body: true },
	{ label: 'recordings', rows: 5000, fields: RECORDING, body: false },
	{ label: 'recordings', rows: 10000, fields: RECORDING, body: false },
	{ label: 'recordings', rows: 25000, fields: RECORDING, body: false },
];

function build({ rows, fields, body }: Case): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('notes');
	doc.transact(() => {
		for (let index = 0; index < rows; index += 1) {
			const row = new Y.Type();
			root.setAttr(
				`r${String(index).padStart(23, '0')}` as never,
				row as never,
			);
			row.setAttr('!presence' as never, 'present' as never);
			for (const [key, value] of Object.entries(fields)) {
				row.setAttr(key as never, value as never);
			}
			if (body) {
				const container = new Y.Type();
				row.setAttr('!doc' as never, container as never);
				const text = new Y.Type('text' as never);
				container.setAttr('editor' as never, text as never);
				text.applyDelta(text.change.insert(BODY) as never);
			}
		}
	});
	const bytes = Y.encodeStateAsUpdateV2(doc);
	doc.destroy();
	return bytes;
}

/**
 * Every struct the document holds.
 *
 * `store.clients` is internal, like `pendingStructs`, and read here for the same
 * reason: it is the only way to get the number that actually explains the
 * memory, and a number nobody can attribute is what this benchmark exists to
 * replace.
 */
function itemCount(doc: Y.Doc): number {
	const clients = (
		doc as unknown as { store?: { clients?: Map<number, unknown[]> } }
	).store?.clients;
	let total = 0;
	for (const structs of clients?.values() ?? []) total += structs.length;
	return total;
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
	const items = itemCount(doc);
	// Touch the document so nothing above can be optimised away.
	const live = doc.get('notes').attrKeys().next().done === false;
	console.log(
		JSON.stringify({
			encoded: bytes.length,
			rss: after.rss - before.rss,
			heap: after.heapUsed - before.heapUsed,
			items,
			openMs,
			live,
		}),
	);
	process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'epicenter-mem-'));
try {
	console.log(
		`runtime  bun ${Bun.version} (${process.platform}/${process.arch})`,
	);
	console.log('engine   JavaScriptCore\n');
	console.log(
		`  ${'shape'.padEnd(13)} ${'rows'.padStart(6)} ${'encoded'.padStart(9)} ${'items'.padStart(9)} ${'rss'.padStart(8)} ${'heap'.padStart(8)} ${'B/item'.padStart(7)} ${'open'.padStart(8)}`,
	);
	for (const testCase of CASES) {
		const path = join(directory, `${testCase.label}-${testCase.rows}.bin`);
		await Bun.write(path, build(testCase));
		const proc = Bun.spawnSync([
			process.execPath,
			import.meta.path,
			'--measure',
			path,
		]);
		const out = proc.stdout.toString().trim();
		if (!out) {
			console.log(`  ${testCase.label} ${testCase.rows}: FAILED`);
			continue;
		}
		const r = JSON.parse(out) as {
			encoded: number;
			rss: number;
			heap: number;
			items: number;
			openMs: number;
		};
		const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
		console.log(
			`  ${testCase.label.padEnd(13)} ${String(testCase.rows).padStart(6)} ${mb(r.encoded).padStart(9)} ${r.items.toLocaleString().padStart(9)} ${mb(r.rss).padStart(8)} ${mb(r.heap).padStart(8)} ${String(Math.round(r.rss / r.items)).padStart(7)} ${`${r.openMs.toFixed(0)} ms`.padStart(8)}`,
		);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}

/**
 * What it would cost the authority to look at an update before storing it.
 *
 * Run: `bun run evidence/bench/validate.ts`
 *
 * This bench exists because it was cited before it existed. `src/sync/authority.ts`
 * and `evidence/workerd/results.md` both quoted figures from a script that was
 * never committed, which makes a number an assertion wearing a measurement's
 * clothes. Everything here is reproducible or it does not belong in a comment.
 *
 * The authority makes no Yjs call at all. `evidence/validation.test.ts` covers
 * whether a check could ever be CORRECT, and finds that none can: every
 * candidate is a filter rather than a proof, because whether bytes throw depends
 * on the structs the receiver holds. This file covers the other half, what a
 * check would COST, and it is the half that turned out to be decisive.
 *
 * METHOD, following `evidence/bench/memory.ts` for the same reason it does:
 *   - One OS PROCESS PER CELL. Measuring several candidates in one process
 *     reports the allocator's high-water mark for the first and near zero after.
 *     The first version of this measurement did exactly that and produced
 *     negative heap deltas, which is the tell.
 *   - The corpus is built once and written to disk; the measuring process reads
 *     bytes, so building never peaks inside the measurement.
 *   - Baseline after a forced GC. BOTH `rss` and `heapUsed` are reported,
 *     because they disagree and the disagreement is the finding. A Durable
 *     Object's 128 MB is documented as "the JavaScript heap and WebAssembly
 *     allocations", so `heapUsed` is what a ceiling derived from this table
 *     should use; `rss` is the process's whole footprint and overstates the
 *     object's by two to three times (ADR-0294 caught exactly that error being
 *     made from an earlier run of this file).
 *   - The answer is discarded exactly as an authority would discard it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from '@y/y';

/** The constant the removed filter diffed against: an empty state vector. */
const EMPTY_STATE_VECTOR = new Uint8Array([0]);

type Candidate = 'diff' | 'state-vector' | 'sha256' | 'hydrate';

const CANDIDATES: { key: Candidate; label: string }[] = [
	{ key: 'state-vector', label: 'encodeStateVectorFromUpdateV2' },
	{ key: 'diff', label: 'diffUpdateV2 (the one that shipped)' },
	{ key: 'sha256', label: 'sha-256 over the bytes' },
	{ key: 'hydrate', label: 'applyUpdateV2 into a throwaway Doc' },
];

/** Notes with body text, which is the shape a real vault has. */
function build(rows: number): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('notes');
	doc.transact(() => {
		for (let index = 0; index < rows; index += 1) {
			const row = new Y.Type();
			root.setAttr(
				`r${String(index).padStart(23, '0')}` as never,
				row as never,
			);
			row.setAttr('title' as never, 'A note title of typical length' as never);
			const container = new Y.Type();
			row.setAttr('!doc' as never, container as never);
			const text = new Y.Type('text' as never);
			container.setAttr('editor' as never, text as never);
			text.applyDelta(text.change.insert('x'.repeat(2800)) as never);
		}
	});
	const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	doc.destroy();
	return bytes;
}

function run(candidate: Candidate, bytes: Uint8Array): unknown {
	switch (candidate) {
		case 'state-vector':
			return Y.encodeStateVectorFromUpdateV2(bytes as Uint8Array<ArrayBuffer>);
		case 'diff':
			return Y.diffUpdateV2(
				bytes as Uint8Array<ArrayBuffer>,
				EMPTY_STATE_VECTOR as Uint8Array<ArrayBuffer>,
			);
		case 'sha256':
			return new Bun.CryptoHasher('sha256').update(bytes).digest();
		case 'hydrate': {
			const doc = new Y.Doc({ gc: true });
			Y.applyUpdateV2(doc, bytes as Uint8Array<ArrayBuffer>);
			return doc;
		}
	}
}

if (process.argv[2] === '--measure') {
	const candidate = process.argv[3] as Candidate;
	const bytes = new Uint8Array(
		await Bun.file(process.argv[4] ?? '').arrayBuffer(),
	);
	Bun.gc(true);
	const before = process.memoryUsage();
	const started = performance.now();
	let answer: unknown;
	let threw = false;
	try {
		answer = run(candidate, bytes);
	} catch {
		threw = true;
	}
	const ms = performance.now() - started;
	Bun.gc(true);
	const after = process.memoryUsage();
	// Touch the answer so nothing above can be optimised away, then drop it.
	const produced = answer === undefined || answer === null ? 0 : 1;
	console.log(
		JSON.stringify({
			ms,
			rss: after.rss - before.rss,
			heap: after.heapUsed - before.heapUsed,
			produced,
			threw,
		}),
	);
	process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'epicenter-validate-'));
try {
	console.log(
		`runtime  bun ${Bun.version} (${process.platform}/${process.arch}), JavaScriptCore`,
	);
	console.log(
		'one OS process per cell; the answer is discarded, as an authority would\n',
	);

	for (const rows of [986, 5_000, 10_000]) {
		const path = join(directory, `${rows}.bin`);
		const bytes = build(rows);
		await Bun.write(path, bytes);
		console.log(
			`  ${rows.toLocaleString()} notes with bodies, ${(bytes.length / 1048576).toFixed(1)} MB encoded`,
		);
		for (const { key, label } of CANDIDATES) {
			const proc = Bun.spawnSync([
				process.execPath,
				import.meta.path,
				'--measure',
				key,
				path,
			]);
			const out = proc.stdout.toString().trim();
			if (!out) {
				console.log(`    ${label.padEnd(34)} FAILED`);
				continue;
			}
			const result = JSON.parse(out) as {
				ms: number;
				rss: number;
				heap: number;
				produced: number;
				threw: boolean;
			};
			const mb = (value: number) => `${(value / 1048576).toFixed(1)} MB`;
			console.log(
				`    ${label.padEnd(34)} ${`${result.ms.toFixed(1)} ms`.padStart(9)} ${mb(result.heap).padStart(9)} heap ${mb(result.rss).padStart(9)} rss${result.threw ? '   THREW' : ''}`,
			);
		}
		console.log('');
	}

	console.log('  reading this table:');
	console.log(
		'    The 986-row heap deltas read 0.0 MB and the rss deltas do not. That is',
	);
	console.log(
		"    JSC's accounting granularity at that size, not a free hydration; the two",
	);
	console.log(
		'    agree from 5,000 rows up, which is where a ceiling should be read.',
	);
	console.log(
		'    The filter that shipped for a while, `diffUpdateV2`, decodes the whole',
	);
	console.log(
		'    stream and re-encodes a full copy before discarding it, so it allocates',
	);
	console.log(
		'    roughly the size of the update several times over. That it costs MORE',
	);
	console.log(
		'    than building the document it was chosen to avoid building is the',
	);
	console.log('    measurement that removed it.');
} finally {
	await rm(directory, { recursive: true, force: true });
}

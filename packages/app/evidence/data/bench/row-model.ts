/**
 * Three candidate row models, measured head to head.
 *
 * Run: `bun run evidence/bench/row-model.ts [rowCounts...]`
 * Method: `@y/y@14.0.0-rc.24`, `gc: true`, Bun's default allocator, one process.
 * Times are the median of three runs. Sizes are `encodeStateAsUpdateV2` length.
 *
 * ROOT   one Yjs root per row, named `<table>/<rowId>`.
 * NESTED one root per table, each row a nested type under it. (Shipped today.)
 * FLAT   one root per table, each field a `<rowId>.<field>` attribute on it.
 *
 * The question each answers, and why it matters:
 *   - encode time: ADR-0212 refuses ROOT because `Item.write` calls
 *     `findRootTypeKey`, a linear scan of `doc.share`, so encoding is claimed to
 *     be quadratic in rows. That claim is the entire reason rows are nested.
 *   - dead row cost: NESTED can drop a container and collect the subtree; FLAT
 *     must tombstone every field, and field names are not deduplicated.
 *   - concurrent creation: NESTED mints a struct-addressed container, so two
 *     devices creating one address lose a subtree. ROOT and FLAT are
 *     name-addressed and should merge.
 */
import * as Y from '@y/y';

import { putRow, rowAt, type ValuesType } from '../raw-document.js';

const FIELDS = {
	title: 'A note title of typical length',
	tags: ['work', 'idea'],
	date: '2026-08-07',
};
const ROW_IDS = (count: number) =>
	Array.from({ length: count }, (_, i) => `r${String(i).padStart(23, '0')}`);

type Shape = {
	name: string;
	build(ids: readonly string[]): Y.Doc;
	deleteAll(doc: Y.Doc, ids: readonly string[]): void;
	/** Two devices independently create the SAME id. Does either side survive? */
	concurrentCreate(): { phone: unknown; laptop: unknown; lost: boolean };
};

const ROOT: Shape = {
	name: 'ROOT',
	build(ids) {
		const doc = new Y.Doc({ gc: true });
		doc.transact(() => {
			for (const id of ids) {
				const row = doc.get(`notes/${id}`);
				row.setAttr('!presence' as never, 'present' as never);
				for (const [k, v] of Object.entries(FIELDS))
					row.setAttr(k as never, v as never);
			}
		});
		return doc;
	},
	deleteAll(doc, ids) {
		// A root can never be removed, so the only deletion available is to clear
		// it. The root itself stays in `doc.share` forever.
		doc.transact(() => {
			for (const id of ids) {
				const row = doc.get(`notes/${id}`);
				for (const key of [...row.attrKeys()]) {
					if (key !== '!presence') row.deleteAttr(key as string);
				}
				row.setAttr('!presence' as never, 'absent' as never);
			}
		});
	},
	concurrentCreate() {
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() =>
			phone.get('notes/n1').setAttr('title' as never, 'phone' as never),
		);
		laptop.transact(() =>
			laptop.get('notes/n1').setAttr('date' as never, 'laptop' as never),
		);
		exchange(phone, laptop);
		const read = (d: Y.Doc) => d.get('notes/n1').getAttrs();
		const merged = read(phone) as Record<string, unknown>;
		return {
			phone: merged,
			laptop: read(laptop),
			lost: Object.keys(merged).length < 2,
		};
	},
};

const NESTED: Shape = {
	name: 'NESTED',
	build(ids) {
		const doc = new Y.Doc({ gc: true });
		const root = doc.get('notes');
		doc.transact(() => {
			for (const id of ids) {
				const row = new Y.Type();
				root.setAttr(id as never, row as never);
				row.setAttr('!presence' as never, 'present' as never);
				for (const [k, v] of Object.entries(FIELDS))
					row.setAttr(k as never, v as never);
			}
		});
		return doc;
	},
	deleteAll(doc, ids) {
		const root = doc.get('notes');
		doc.transact(() => {
			for (const id of ids) root.deleteAttr(id);
		});
	},
	concurrentCreate() {
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		for (const [doc, key, value] of [
			[phone, 'title', 'phone'],
			[laptop, 'date', 'laptop'],
		] as const) {
			doc.transact(() => {
				const row: ValuesType = new Y.Type();
				putRow(doc.get('notes'), 'n1', row);
				row.setAttr(key, value);
			});
		}
		exchange(phone, laptop);
		const read = (d: Y.Doc) => rowAt(d.get('notes'), 'n1')?.getAttrs() ?? {};
		const merged = read(phone) as Record<string, unknown>;
		return {
			phone: merged,
			laptop: read(laptop),
			lost: Object.keys(merged).length < 2,
		};
	},
};

const FLAT: Shape = {
	name: 'FLAT',
	build(ids) {
		const doc = new Y.Doc({ gc: true });
		const root = doc.get('notes');
		doc.transact(() => {
			for (const id of ids) {
				root.setAttr(`${id}.!presence` as never, 'present' as never);
				for (const [k, v] of Object.entries(FIELDS)) {
					root.setAttr(`${id}.${k}` as never, v as never);
				}
			}
		});
		return doc;
	},
	deleteAll(doc, ids) {
		const root = doc.get('notes');
		doc.transact(() => {
			for (const id of ids) {
				for (const key of Object.keys(FIELDS)) root.deleteAttr(`${id}.${key}`);
				root.setAttr(`${id}.!presence` as never, 'absent' as never);
			}
		});
	},
	concurrentCreate() {
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() =>
			phone.get('notes').setAttr('n1.title' as never, 'phone' as never),
		);
		laptop.transact(() =>
			laptop.get('notes').setAttr('n1.date' as never, 'laptop' as never),
		);
		exchange(phone, laptop);
		const read = (d: Y.Doc) => {
			const out: Record<string, unknown> = {};
			for (const key of d.get('notes').attrKeys()) {
				if (String(key).startsWith('n1.'))
					out[String(key)] = d.get('notes').getAttr(key as never);
			}
			return out;
		};
		const merged = read(phone);
		return {
			phone: merged,
			laptop: read(laptop),
			lost: Object.keys(merged).length < 2,
		};
	},
};

function exchange(a: Y.Doc, b: Y.Doc): void {
	const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
	const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
	Y.applyUpdateV2(b, fromA);
	Y.applyUpdateV2(a, fromB);
}

function median(samples: number[]): number {
	const sorted = [...samples].sort((x, y) => x - y);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timed(run: () => void): number {
	return median(
		Array.from({ length: 3 }, () => {
			const start = performance.now();
			run();
			return performance.now() - start;
		}),
	);
}

const counts = process.argv
	.slice(2)
	.map(Number)
	.filter((n) => Number.isFinite(n) && n > 0);
const rowCounts = counts.length > 0 ? counts : [1000, 5000, 20000];

console.log('correctness: two devices independently create the SAME row id\n');
for (const shape of [ROOT, NESTED, FLAT]) {
	const { phone, lost } = shape.concurrentCreate();
	console.log(
		`  ${shape.name.padEnd(7)} ${lost ? 'LOSES a write' : 'both survive  '}  ${JSON.stringify(phone)}`,
	);
}

console.log('\nperformance\n');
console.log(
	`  ${'rows'.padStart(6)}  ${'shape'.padEnd(7)} ${'build'.padStart(9)} ${'encode'.padStart(9)} ${'size'.padStart(9)} ${'dead row'.padStart(9)} ${'share'.padStart(7)}`,
);
for (const rows of rowCounts) {
	const ids = ROW_IDS(rows);
	for (const shape of [ROOT, NESTED, FLAT]) {
		let doc!: Y.Doc;
		const build = timed(() => {
			doc?.destroy();
			doc = shape.build(ids);
		});
		const encode = timed(() => void Y.encodeStateAsUpdateV2(doc));
		const size = Y.encodeStateAsUpdateV2(doc).length;
		shape.deleteAll(doc, ids);
		const deadPerRow = Y.encodeStateAsUpdateV2(doc).length / rows;
		const share = doc.share.size;
		doc.destroy();
		console.log(
			`  ${String(rows).padStart(6)}  ${shape.name.padEnd(7)} ${`${build.toFixed(0)} ms`.padStart(9)} ${`${encode.toFixed(1)} ms`.padStart(9)} ${`${(size / 1024).toFixed(0)} KB`.padStart(9)} ${`${deadPerRow.toFixed(0)} B`.padStart(9)} ${String(share).padStart(7)}`,
		);
	}
}

/**
 * What the REAL IndexedDB port costs, per operation, as the chain grows.
 *
 * `write-cost` measured a store written for the benchmark. This one drives
 * `openIdbBacking` itself, because the question that matters is not what an
 * append log costs in principle but what THIS port costs, and the two ports
 * behind `DurablePort` do the same work by different means:
 *
 * ```txt
 *   append   idb: put(record, id)          sql: INSERT
 *   ack      idb: openCursor + update EACH sql: one UPDATE … WHERE
 *   fold     idb: openCursor walk          sql: SELECT … WHERE
 *   open     idb: getAll + getAllKeys      sql: SELECT … ORDER BY
 * ```
 *
 * The ack is the row that should worry you, and measuring it is the point.
 * `SNAPSHOT_FOLD_THRESHOLD` is a module constant, so rather than rebuild the
 * bundle per value this measures the primitives the threshold scales -- ack
 * width, chain length at open, batch size -- and lets the curve answer what a
 * threshold would cost.
 */
import * as Y from '@y/y';
import { openIdbBacking } from '../../../../src/data/store/browser.js';
import type { DurableOp } from '../../../../src/data/store/persistence.js';

const out: string[] = [];
function say(line: string): void {
	out.push(line);
	const node = document.getElementById('out');
	if (node !== null) node.textContent = out.join('\n');
}

function ms(value: number): string {
	return `${value.toFixed(1)} ms`;
}

/** A workspace document of roughly the requested encoded size. */
function workspace(
	notes: number,
	words: number,
): {
	doc: Y.Doc;
	edit: () => Uint8Array;
} {
	const doc = new Y.Doc({ gc: true });
	const table = doc.get('tables:notes');
	const bodies: Y.Type[] = [];
	doc.transact(() => {
		for (let i = 0; i < notes; i += 1) {
			const row = new Y.Type();
			const content = new Y.Type();
			content.insert(
				0,
				'lorem ipsum dolor sit amet consectetur '.repeat(words / 6),
			);
			row.setAttr('content', content as never);
			table.setAttr(`n${i}`, row as never);
			bodies.push(content);
		}
	});
	let pending: Uint8Array | undefined;
	doc.on('updateV2', (update: Uint8Array) => {
		pending = update;
	});
	let at = 0;
	return {
		doc,
		edit(): Uint8Array {
			pending = undefined;
			const body = bodies[at % bodies.length];
			at += 1;
			if (body !== undefined) {
				doc.transact(() => body.insert(body.length, 'more words here '));
			}
			return pending ?? new Uint8Array();
		},
	};
}

let address = 0;
async function backing() {
	address += 1;
	const name = `port-cost/${address}`;
	const { data, error } = await openIdbBacking(name);
	if (error !== null) throw new Error(String(error.message));
	return { ...data, name };
}

async function reopen(name: string) {
	const { data, error } = await openIdbBacking(name);
	if (error !== null) throw new Error(String(error.message));
	return data;
}

/**
 * The ack walk, isolated: how long does stamping N owed rows take?
 *
 * This is the operation a longer chain makes worse, and the one where the two
 * ports differ most: one statement against a cursor walk with a write per row.
 */
async function ackWidth(): Promise<void> {
	say('\n## ack cost by how many owed rows it stamps  (syncs: true)');
	say('  owed rows      append batch          ack        per row');
	for (const owed of [10, 50, 200, 1000, 4000]) {
		const store = await backing();
		const { edit } = workspace(200, 120);
		let id = 1;
		const ops: DurableOp[] = [];
		for (let i = 0; i < owed; i += 1) {
			ops.push({
				kind: 'append',
				id: id++,
				bytes: edit(),
				authoritySeq: undefined,
			});
		}
		const appendStart = performance.now();
		await store.port.commit(ops);
		const appendMs = performance.now() - appendStart;

		const ackStart = performance.now();
		await store.port.commit([
			{ kind: 'ack', throughId: id - 1, authoritySeq: owed },
		]);
		const ackMs = performance.now() - ackStart;
		store.close();
		say(
			`  ${String(owed).padStart(9)}   ${ms(appendMs).padStart(12)}   ${ms(ackMs).padStart(10)}   ${(ackMs / owed).toFixed(3)} ms`,
		);
	}
}

/** Open cost, which is `getAll()` over the whole chain plus a hydrating replay. */
async function openCost(): Promise<void> {
	say('\n## open cost by chain length  (syncs: true, nothing folded)');
	say('  chain rows      reopen      hydrate       total');
	for (const rows of [10, 64, 250, 1000, 4000]) {
		const store = await backing();
		const { edit } = workspace(200, 120);
		let id = 1;
		const ops: DurableOp[] = [];
		// Acknowledged as they go, so nothing is owed and the chain is pure
		// history rather than backlog. Under the fold threshold either way here.
		for (let i = 0; i < rows; i += 1) {
			ops.push({
				kind: 'append',
				id: id++,
				bytes: edit(),
				authoritySeq: undefined,
			});
		}
		await store.port.commit(ops);
		store.close();

		const openStart = performance.now();
		const again = await reopen(store.name);
		const openMs = performance.now() - openStart;

		const hydrateStart = performance.now();
		const rebuilt = new Y.Doc({ gc: true });
		for (const update of again.loaded.updates)
			Y.applyUpdateV2(rebuilt, update, null);
		const hydrateMs = performance.now() - hydrateStart;
		again.close();
		say(
			`  ${String(rows).padStart(10)}   ${ms(openMs).padStart(9)}   ${ms(hydrateMs).padStart(10)}   ${ms(openMs + hydrateMs).padStart(9)}`,
		);
	}
}

/** Whether batching appends into one commit is worth anything on this port. */
async function batching(): Promise<void> {
	say('\n## append cost by batch size  (60 appends, syncs: true)');
	say('  per commit     commits         total     per append');
	for (const batch of [1, 5, 25, 60]) {
		const store = await backing();
		const { edit } = workspace(200, 120);
		let id = 1;
		let ops: DurableOp[] = [];
		let commits = 0;
		const start = performance.now();
		for (let i = 0; i < 60; i += 1) {
			ops.push({
				kind: 'append',
				id: id++,
				bytes: edit(),
				authoritySeq: undefined,
			});
			if (ops.length === batch) {
				await store.port.commit(ops);
				ops = [];
				commits += 1;
			}
		}
		if (ops.length > 0) {
			await store.port.commit(ops);
			commits += 1;
		}
		const total = performance.now() - start;
		store.close();
		say(
			`  ${String(batch).padStart(10)}   ${String(commits).padStart(7)}   ${ms(total).padStart(11)}   ${(total / 60).toFixed(3)} ms`,
		);
	}
}

/** The fold itself, on a store with no authority, so everything is foldable. */
async function foldCost(): Promise<void> {
	say('\n## the commit that folds  (syncs: false, threshold 64)');
	say('  document        fold commit    plain commit');
	for (const [notes, words] of [
		[200, 120],
		[800, 300],
		[2500, 400],
	] as const) {
		const store = await backing();
		const { doc, edit } = workspace(notes, words);
		const size = Y.encodeStateAsUpdateV2(doc).byteLength;
		let id = 1;
		await store.port.commit([
			{
				kind: 'append',
				id: id++,
				bytes: new Uint8Array(Y.encodeStateAsUpdateV2(doc)),
				authoritySeq: undefined,
			},
		]);
		// Up to 62 rows, so the NEXT append makes the chain 63 and the one after
		// it makes 64, which is the append that folds.
		for (let i = 0; i < 61; i += 1) {
			await store.port.commit([
				{ kind: 'append', id: id++, bytes: edit(), authoritySeq: undefined },
			]);
		}
		const plainStart = performance.now();
		await store.port.commit([
			{ kind: 'append', id: id++, bytes: edit(), authoritySeq: undefined },
		]);
		const plainMs = performance.now() - plainStart;
		const foldStart = performance.now();
		await store.port.commit([
			{ kind: 'append', id: id++, bytes: edit(), authoritySeq: undefined },
		]);
		const foldMs = performance.now() - foldStart;
		store.close();
		say(
			`  ${`${(size / 1024).toFixed(0)} KB`.padStart(8)}   ${ms(foldMs).padStart(14)}   ${ms(plainMs).padStart(13)}`,
		);
	}
}

async function main(): Promise<void> {
	say('# openIdbBacking, measured directly');
	await batching();
	await ackWidth();
	await openCost();
	await foldCost();
	say('\nDONE');
}

void main().catch((cause: unknown) => {
	say(`\nFAILED: ${String(cause)}`);
});

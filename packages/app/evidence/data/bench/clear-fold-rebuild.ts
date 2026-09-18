/**
 * Same-lineage folding versus clear-and-repopulate versus a fresh rebuild.
 *
 * Run: `bun packages/app/evidence/data/bench/clear-fold-rebuild.ts`
 *
 * This benchmark deliberately measures three different operations over the
 * same logical final workspace:
 *
 *   FOLD    replay the complete aged state into a fresh runtime Y.Doc and
 *           encode it. This is the existing same-lineage snapshot fold.
 *   CLEAR   delete the visible rows and body text, then write the same logical
 *           values back into the same Yjs lineage.
 *   FRESH   read the visible values and write them into new Y.Doc instances.
 *
 * FOLD and CLEAR retain the old client/clock identity space. FRESH does not.
 * The benchmark reports encoded bytes, state-vector bytes, retained structs,
 * and what an old offline replica contributes after each operation. It does
 * not claim to measure SQLite page overhead, allocator RSS, or a full store
 * envelope; those are separate measurements.
 */

import * as Y from '@y/y';

import { rowAt } from '../raw-document.js';

const LIVE_ROWS = 1_000;
const DEAD_ROWS = 5_000;
const BODY_DOCUMENTS = 200;
const BODY_CHARS = 2_000;
const requestedBodyEdits = Number(process.argv[2]);
const BODY_EDITS = Number.isFinite(requestedBodyEdits)
	? Math.max(0, Math.floor(requestedBodyEdits))
	: 20;

type Row = { id: string; title: string; ordinal: number };
type Workspace = { index: Y.Doc; bodies: Y.Doc[] };
type LogicalState = { rows: Row[]; bodies: string[] };
type Metrics = {
	bytes: number;
	stateVectorBytes: number;
	items: number;
	encodeMs: number;
	loadMs: number;
};

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

function encode(doc: Y.Doc): Uint8Array {
	return new Uint8Array(Y.encodeStateAsUpdateV2(doc));
}

function clone(doc: Y.Doc): Y.Doc {
	const copy = new Y.Doc({ gc: true });
	Y.applyUpdateV2(copy, encode(doc));
	return copy;
}

function docsOf(workspace: Workspace): Y.Doc[] {
	return [workspace.index, ...workspace.bodies];
}

function median(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(workspace: Workspace): Metrics {
	const encoded = () => {
		let bytes = 0;
		for (const doc of [workspace.index, ...workspace.bodies]) {
			bytes += encode(doc).length;
		}
		return bytes;
	};
	const encodeMs = median(
		Array.from({ length: 3 }, () => {
			const started = performance.now();
			encoded();
			return performance.now() - started;
		}),
	);
	const loadMs = median(
		Array.from({ length: 3 }, () => {
			const started = performance.now();
			const copies = docsOf(workspace).map(clone);
			for (const copy of copies) copy.destroy();
			return performance.now() - started;
		}),
	);
	return {
		bytes: encoded(),
		stateVectorBytes: docsOf(workspace).reduce(
			(total, doc) => total + Y.encodeStateVector(doc).length,
			0,
		),
		items: docsOf(workspace).reduce((total, doc) => total + itemCount(doc), 0),
		encodeMs,
		loadMs,
	};
}

function bytesOf(docs: readonly Y.Doc[]): number {
	return docs.reduce((total, doc) => total + encode(doc).length, 0);
}

function itemsOf(docs: readonly Y.Doc[]): number {
	return docs.reduce((total, doc) => total + itemCount(doc), 0);
}

function replayHistoryMs(historyEntries: readonly Uint8Array[][]): number {
	return median(
		Array.from({ length: 3 }, () => {
			const started = performance.now();
			for (const entries of historyEntries) {
				const doc = new Y.Doc({ gc: true });
				for (const update of entries) Y.applyUpdateV2(doc, update);
				doc.destroy();
			}
			return performance.now() - started;
		}),
	);
}

function titleFor(index: number): string {
	return `note ${index} with a typical title`;
}

function bodyFor(index: number): string {
	return `body ${index} ` + 'x'.repeat(BODY_CHARS);
}

function addRow(root: Y.Type, row: Row): void {
	const value = new Y.Type();
	root.setAttr(row.id as never, value as never);
	value.setAttr('!presence' as never, 'present' as never);
	value.setAttr('title' as never, row.title as never);
	value.setAttr('ordinal' as never, row.ordinal as never);
}

function makeBody(index: number): {
	doc: Y.Doc;
	historyBytes: number;
	history: Uint8Array[];
} {
	const doc = new Y.Doc({ gc: true });
	let historyBytes = 0;
	const history: Uint8Array[] = [];
	doc.on('updateV2', (update: Uint8Array) => {
		historyBytes += update.length;
		history.push(new Uint8Array(update));
	});
	const text = doc.get('body', 'text');
	doc.transact(() =>
		text.applyDelta(text.change.insert(bodyFor(index)) as never),
	);
	for (let edit = 0; edit < BODY_EDITS; edit += 1) {
		doc.transact(() =>
			text.applyDelta(
				text.change
					.retain(Math.floor(text.length / 2))
					.insert(` edit-${edit}`) as never,
			),
		);
	}
	return { doc, historyBytes, history };
}

function buildAged(): {
	workspace: Workspace;
	historyBytes: number;
	historyEntries: Uint8Array[][];
} {
	const index = new Y.Doc({ gc: true });
	let historyBytes = 0;
	const indexHistory: Uint8Array[] = [];
	index.on('updateV2', (update: Uint8Array) => {
		historyBytes += update.length;
		indexHistory.push(new Uint8Array(update));
	});
	const root = index.get('notes');

	// Interleave creation and deletion so the aged document carries the same
	// kind of long-lived row churn the existing tombstone benchmark measures.
	for (let rowIndex = 0; rowIndex < DEAD_ROWS; rowIndex += 1) {
		const id = `dead-${String(rowIndex).padStart(8, '0')}`;
		const row = { id, title: titleFor(rowIndex), ordinal: rowIndex };
		index.transact(() => addRow(root, row));
		index.transact(() => root.deleteAttr(id));
	}

	const rows = Array.from({ length: LIVE_ROWS }, (_, rowIndex) => ({
		id: `live-${String(rowIndex).padStart(8, '0')}`,
		title: titleFor(DEAD_ROWS + rowIndex),
		ordinal: DEAD_ROWS + rowIndex,
	}));
	index.transact(() => {
		for (const row of rows) addRow(root, row);
	});

	const builtBodies = Array.from({ length: BODY_DOCUMENTS }, (_, index) =>
		makeBody(index),
	);
	const bodies = builtBodies.map(({ doc }) => doc);
	for (const body of builtBodies) historyBytes += body.historyBytes;
	return {
		workspace: { index, bodies },
		historyBytes,
		historyEntries: [
			indexHistory,
			...builtBodies.map(({ history }) => history),
		],
	};
}

function readLogicalState(workspace: Workspace): LogicalState {
	const root = workspace.index.get('notes');
	const rows: Row[] = [];
	for (const key of root.attrKeys()) {
		const value = root.getAttr(key as never) as unknown;
		if (!(value instanceof Y.Type)) continue;
		if (value.getAttr('!presence' as never) !== 'present') continue;
		rows.push({
			id: String(key),
			title: String(value.getAttr('title' as never)),
			ordinal: Number(value.getAttr('ordinal' as never)),
		});
	}
	return {
		rows,
		bodies: workspace.bodies.map((doc) => doc.get('body', 'text').toString()),
	};
}

function clearAndRepopulate(workspace: Workspace, logical: LogicalState): void {
	const root = workspace.index.get('notes');
	workspace.index.transact(() => {
		for (const key of [...root.attrKeys()]) root.deleteAttr(String(key));
	});
	workspace.index.transact(() => {
		for (const row of logical.rows) addRow(root, row);
	});

	for (const [index, doc] of workspace.bodies.entries()) {
		const text = doc.get('body', 'text');
		const replacement = logical.bodies[index];
		if (replacement === undefined) throw new Error('body state is incomplete');
		doc.transact(() => {
			text.applyDelta(
				text.change.delete(text.length).insert(replacement) as never,
			);
		});
	}
}

function freshRebuild(logical: LogicalState): Workspace {
	const index = new Y.Doc({ gc: true });
	const root = index.get('notes');
	index.transact(() => {
		for (const row of logical.rows) addRow(root, row);
	});
	const bodies = logical.bodies.map((value) => {
		const doc = new Y.Doc({ gc: true });
		const text = doc.get('body', 'text');
		doc.transact(() => text.applyDelta(text.change.insert(value) as never));
		return doc;
	});
	return { index, bodies };
}

function fold(workspace: Workspace): Workspace {
	return {
		index: clone(workspace.index),
		bodies: workspace.bodies.map(clone),
	};
}

function syncBytes(from: Workspace, to: Workspace): number {
	const fromDocs = docsOf(from);
	const toDocs = docsOf(to);
	let bytes = 0;
	for (let index = 0; index < fromDocs.length; index += 1) {
		bytes += encodeDiff(fromDocs[index]!, toDocs[index]!).length;
	}
	return bytes;
}

function bidirectionalSyncBytes(a: Workspace, b: Workspace): number {
	return syncBytes(a, b) + syncBytes(b, a);
}

function sync(a: Workspace, b: Workspace): void {
	const aDocs = docsOf(a);
	const bDocs = docsOf(b);
	for (let index = 0; index < aDocs.length; index += 1) {
		const fromA = encodeDiff(aDocs[index]!, bDocs[index]!);
		const fromB = encodeDiff(bDocs[index]!, aDocs[index]!);
		Y.applyUpdateV2(bDocs[index]!, fromA);
		Y.applyUpdateV2(aDocs[index]!, fromB);
	}
}

function encodeDiff(from: Y.Doc, to: Y.Doc): Uint8Array {
	return new Uint8Array(Y.encodeStateAsUpdateV2(from, Y.encodeStateVector(to)));
}

function visibleRows(workspace: Workspace): number {
	const root = workspace.index.get('notes');
	let count = 0;
	for (const key of root.attrKeys()) {
		const row = root.getAttr(key as never) as unknown;
		if (
			row instanceof Y.Type &&
			row.getAttr('!presence' as never) === 'present'
		)
			count += 1;
	}
	return count;
}

function bodyChars(workspace: Workspace): number {
	return workspace.bodies.reduce(
		(total, doc) => total + doc.get('body', 'text').length,
		0,
	);
}

function addOfflineEdits(workspace: Workspace): void {
	const root = workspace.index.get('notes');
	const first = [...root.attrKeys()][0];
	if (first === undefined) throw new Error('workspace has no rows');
	const row = rowAt(root, String(first));
	workspace.index.transact(() =>
		row?.setAttr('title', 'offline edit after the export point'),
	);
	const body = workspace.bodies[0];
	if (body === undefined) throw new Error('workspace has no body');
	const text = body.get('body', 'text');
	body.transact(() =>
		text.applyDelta(
			text.change.retain(text.length).insert(' OFFLINE') as never,
		),
	);
}

function destroy(workspace: Workspace): void {
	workspace.index.destroy();
	for (const body of workspace.bodies) body.destroy();
}

function mb(bytes: number): string {
	return `${(bytes / 1048576).toFixed(2)} MB`;
}

const aged = buildAged();
const logical = readLogicalState(aged.workspace);
const offline = fold(aged.workspace);
const folded = fold(aged.workspace);
const baseline = fold(aged.workspace);
clearAndRepopulate(aged.workspace, logical);
const cleared = aged.workspace;
const fresh = freshRebuild(logical);

const cases = [
	['aged', baseline],
	['fold', folded],
	['clear + repopulate', cleared],
	['fresh rebuild', fresh],
] as const;

console.log(
	`workspace: ${LIVE_ROWS.toLocaleString()} live rows, ${DEAD_ROWS.toLocaleString()} deleted rows, ${BODY_DOCUMENTS} type-field bodies, ${BODY_CHARS} chars/body, ${BODY_EDITS} edits/body`,
);
console.log(
	`append-only update bytes: ${mb(aged.historyBytes)} across ${aged.historyEntries.reduce((total, entries) => total + entries.length, 0).toLocaleString()} updates`,
);
console.log(
	`append-only replay: ${replayHistoryMs(aged.historyEntries).toFixed(1)} ms; folded full-state load is measured below\n`,
);
console.log(
	`  ${'case'.padEnd(20)} ${'snapshot bytes'.padStart(16)} ${'state vectors'.padStart(15)} ${'items'.padStart(12)} ${'encode'.padStart(10)} ${'load'.padStart(10)} ${'rows'.padStart(8)} ${'body chars'.padStart(12)}`,
);
for (const [label, workspace] of cases) {
	const metrics = measure(workspace);
	console.log(
		`  ${label.padEnd(20)} ${mb(metrics.bytes).padStart(16)} ${String(metrics.stateVectorBytes).padStart(15)} ${metrics.items.toLocaleString().padStart(12)} ${`${metrics.encodeMs.toFixed(1)} ms`.padStart(10)} ${`${metrics.loadMs.toFixed(1)} ms`.padStart(10)} ${String(visibleRows(workspace)).padStart(8)} ${bodyChars(workspace).toLocaleString().padStart(12)}`,
	);
}

console.log('\nindex versus independent body documents:');
for (const [label, workspace] of cases) {
	const indexBytes = bytesOf([workspace.index]);
	const bodyBytes = bytesOf(workspace.bodies);
	console.log(
		`  ${label.padEnd(20)} index ${mb(indexBytes).padStart(10)} / ${itemsOf([workspace.index]).toLocaleString().padStart(8)} structs, bodies ${mb(bodyBytes).padStart(10)} / ${itemsOf(workspace.bodies).toLocaleString().padStart(8)} structs`,
	);
}

console.log('\nold offline replica, behind but with no new edits:');
for (const [label, workspace] of [
	['fold', folded],
	['clear + repopulate', cleared],
] as const) {
	const replica = fold(offline);
	const target = fold(workspace);
	const bytesToReplica = bidirectionalSyncBytes(target, replica);
	sync(replica, target);
	const metrics = measure(target);
	console.log(
		`  ${label.padEnd(20)} ${mb(bytesToReplica).padStart(10)} sent, ${String(visibleRows(target)).padStart(8)} rows, ${bodyChars(target).toLocaleString().padStart(10)} body chars, ${mb(metrics.bytes).padStart(10)} after sync`,
	);
	destroy(replica);
	destroy(target);
}

console.log('\nold offline replica with edits after the export point:');
for (const [label, workspace] of [
	['fold', folded],
	['clear + repopulate', cleared],
] as const) {
	const replica = fold(offline);
	addOfflineEdits(replica);
	const target = fold(workspace);
	const bytesToTarget = bidirectionalSyncBytes(target, replica);
	sync(replica, target);
	const firstBody = target.bodies[0]?.get('body', 'text').toString() ?? '';
	console.log(
		`  ${label.padEnd(20)} ${mb(bytesToTarget).padStart(10)} sent, ${firstBody.includes('OFFLINE') ? 'offline edit retained' : 'offline edit absent'}, ${firstBody.length} chars in first body`,
	);
	destroy(replica);
	destroy(target);
}

console.log(
	`  ${'fresh rebuild'.padEnd(20)} ${mb(measure(fresh).bytes).padStart(10)} full-state bytes; it must replace, not merge, the old local document`,
);

const unsafeFreshReplica = fold(offline);
const unsafeFreshTarget = fold(fresh);
const unsafeFreshBytes = bidirectionalSyncBytes(
	unsafeFreshReplica,
	unsafeFreshTarget,
);
sync(unsafeFreshReplica, unsafeFreshTarget);
console.log(
	`  ${'fresh + old merge'.padEnd(20)} ${mb(unsafeFreshBytes).padStart(10)} exchanged, ${bodyChars(unsafeFreshTarget).toLocaleString()} body chars after merging incompatible state`,
);
destroy(unsafeFreshReplica);
destroy(unsafeFreshTarget);

console.log('\nrepeated same-lineage clear cycles:');
const repeated = cleared;
for (let cycle = 1; cycle <= 3; cycle += 1) {
	clearAndRepopulate(repeated, logical);
	const metrics = measure(repeated);
	console.log(
		`  cycle ${cycle}: ${mb(metrics.bytes)}, ${metrics.items.toLocaleString()} structs, ${metrics.stateVectorBytes} state-vector bytes`,
	);
}

console.log('\ncontrols:');
console.log(
	`  ${visibleRows(folded) === LIVE_ROWS ? 'held  ' : 'FAILED'} fold preserves ${LIVE_ROWS} visible rows`,
);
console.log(
	`  ${visibleRows(cleared) === LIVE_ROWS ? 'held  ' : 'FAILED'} clear + repopulate preserves ${LIVE_ROWS} visible rows`,
);
console.log(
	`  ${visibleRows(fresh) === LIVE_ROWS ? 'held  ' : 'FAILED'} fresh rebuild imports ${LIVE_ROWS} visible rows`,
);

for (const [, workspace] of cases) destroy(workspace);
destroy(offline);

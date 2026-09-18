/**
 * What it costs to never compact the authority's log.
 *
 * Run: `bun run evidence/bench/never-compact.ts`
 * Method: `@y/y@14.0.0-rc.24`, `gc: true`, Bun, one process. Byte counts are
 * `updateV2` lengths as they would be appended; replay is a fresh document
 * applying every entry in order.
 *
 * The question this answers is whether refusing compaction is affordable. If it
 * is, the authority never needs to prove that a replacement covers what it
 * replaces, which is the requirement every failed design so far has been trying
 * to satisfy cheaply.
 *
 * The variable that turns out to matter most is not on the authority at all. A
 * client may merge its OWN unsent updates before sending, which it can always
 * do correctly because it owns them, and which needs no proof from anybody. So
 * the log grows with SENDS, not with transactions, and the send rate is a
 * client-side choice.
 */
import * as Y from '@y/y';

import { rowAt, typeAt } from '../raw-document.js';

/** One day of use, as transactions a real editor would dispatch. */
const DAY = {
	/** Notes whose value fields change: renames, tags, dates. */
	fieldEdits: 20,
	/** Characters typed into the node. ProseMirror dispatches roughly per keystroke. */
	charsTyped: 2000,
};

type Policy = {
	label: string;
	/** How many transactions are coalesced into one appended update. */
	batch: number;
};

const POLICIES: Policy[] = [
	{ label: 'per transaction', batch: 1 },
	{ label: 'coalesce 10', batch: 10 },
	{ label: 'coalesce 100', batch: 100 },
	{ label: 'per second (~40)', batch: 40 },
];

function simulate(days: number, policy: Policy) {
	const doc = new Y.Doc({ gc: true });
	const root = doc.get('notes');
	// A vault the size of the real one, created once.
	doc.transact(() => {
		for (let i = 0; i < 986; i += 1) {
			const row = new Y.Type();
			root.setAttr(`r${String(i).padStart(23, '0')}` as never, row as never);
			row.setAttr('!presence' as never, 'present' as never);
			row.setAttr('title' as never, 'A note title of typical length' as never);
			const container = new Y.Type();
			row.setAttr('!doc' as never, container as never);
			const text = new Y.Type('text' as never);
			container.setAttr('editor' as never, text as never);
			text.applyDelta(text.change.insert('x'.repeat(2800)) as never);
		}
	});

	const log: number[] = [];
	let bytes = 0;
	let pending: Uint8Array[] = [];
	let mark = Y.encodeStateVector(doc);

	const flush = () => {
		if (pending.length === 0) return;
		const merged =
			pending.length === 1
				? pending[0]!
				: Y.mergeUpdatesV2(pending as Uint8Array<ArrayBuffer>[]);
		log.push(merged.length);
		bytes += merged.length;
		pending = [];
	};

	// The vault's creation is itself the first entry.
	flush();
	const seed = Y.encodeStateAsUpdateV2(doc);
	log.push(seed.length);
	bytes += seed.length;
	mark = Y.encodeStateVector(doc);

	let sinceFlush = 0;
	const transaction = (run: () => void) => {
		doc.transact(run);
		const full = Y.encodeStateAsUpdateV2(doc);
		pending.push(Y.diffUpdateV2(full, mark));
		mark = Y.encodeStateVector(doc);
		sinceFlush += 1;
		if (sinceFlush >= policy.batch) {
			flush();
			sinceFlush = 0;
		}
	};

	for (let day = 0; day < days; day += 1) {
		for (let edit = 0; edit < DAY.fieldEdits; edit += 1) {
			const id = `r${String((day * 7 + edit) % 986).padStart(23, '0')}`;
			transaction(() => {
				rowAt(root, id)?.setAttr('title', `edited on day ${day}`);
			});
		}
		for (let keystroke = 0; keystroke < DAY.charsTyped; keystroke += 1) {
			const id = `r${String((day * 3 + keystroke) % 986).padStart(23, '0')}`;
			transaction(() => {
				const row = rowAt(root, id);
				if (row === undefined) throw new Error('the row is gone');
				const container = typeAt(row, '!doc');
				const text =
					container === undefined ? undefined : typeAt(container, 'editor');
				if (text === undefined) throw new Error('the row has no text');
				text.applyDelta(text.change.retain(10).insert('a') as never);
			});
		}
	}
	flush();
	doc.destroy();
	return { entries: log.length, bytes };
}

const DAYS = 7;
console.log(
	`simulated ${DAYS} days: ${DAY.fieldEdits} field edits and ${DAY.charsTyped} characters typed per day,`,
);
console.log('over a vault of 986 notes with 2.8 KB bodies.\n');
console.log(
	`  ${'send policy'.padEnd(18)} ${'entries'.padStart(9)} ${'log bytes'.padStart(11)} ${'per day'.padStart(10)} ${'per year'.padStart(10)} ${'10 years'.padStart(10)}`,
);

const seedOnly = simulate(0, POLICIES[0]!);
for (const policy of POLICIES) {
	const run = simulate(DAYS, policy);
	// The seed is the vault's creation and is paid once, not per day.
	const grown = run.bytes - seedOnly.bytes;
	const perDay = grown / DAYS;
	const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
	console.log(
		`  ${policy.label.padEnd(18)} ${run.entries.toLocaleString().padStart(9)} ${mb(run.bytes).padStart(11)} ${`${(perDay / 1024).toFixed(0)} KB`.padStart(10)} ${mb(perDay * 365).padStart(10)} ${mb(perDay * 3650).padStart(10)}`,
	);
}
console.log(
	`\n  seed (the vault itself, paid once): ${(seedOnly.bytes / 1048576).toFixed(1)} MB`,
);

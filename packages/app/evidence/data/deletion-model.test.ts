/**
 * Whether clear-and-flag buys anything a reader can see.
 *
 * `deleteRow` clears a row's fields and flags it absent rather than removing it
 * from the table root, and its own comment gives the reason: "Deleting the row's
 * attribute instead destroys a concurrent edit; clearing fields and flagging
 * converges with the tombstone held and the peer's edit retained."
 *
 * That costs about 8 items per dead row against 2 for removal, which is 458 MB
 * against 100 MB over a decade of ordinary churn (`evidence/bench/tombstones.ts`).
 * At that price the benefit has to be real, so these tests ask what a reader
 * actually observes under each model rather than what the CRDT retains.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import {
	putRow,
	putType,
	rowAt,
	typeAt,
	type ValuesType,
} from './raw-document.js';

const PRESENCE = '!presence';
const CONTENT = 'content';

type Model = 'clear-and-flag' | 'drop';

function sync(a: Y.Doc, b: Y.Doc): void {
	const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
	const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
	Y.applyUpdateV2(b, fromA);
	Y.applyUpdateV2(a, fromB);
}

function rowsOf(doc: Y.Doc): Y.Type {
	return doc.get('notes');
}

function create(doc: Y.Doc, rowId: string, title: string): void {
	doc.transact(() => {
		const row: ValuesType = new Y.Type();
		putRow(rowsOf(doc), rowId, row);
		putType(row, CONTENT, new Y.Type());
		row.setAttr(PRESENCE, 'present');
		row.setAttr('title', title);
	});
}

function remove(doc: Y.Doc, rowId: string, model: Model): void {
	doc.transact(() => {
		const root = rowsOf(doc);
		if (model === 'drop') {
			root.deleteAttr(rowId);
			return;
		}
		const row = rowAt(root, rowId);
		if (row === undefined) return;
		for (const key of [...row.attrKeys()]) {
			if (key !== PRESENCE) row.deleteAttr(key);
		}
		row.setAttr(PRESENCE, 'absent');
	});
}

function edit(doc: Y.Doc, rowId: string, title: string): void {
	doc.transact(() => {
		rowAt(rowsOf(doc), rowId)?.setAttr('title', title);
	});
}

/** What the store's `readRow` would return: undefined unless live. */
function read(doc: Y.Doc, rowId: string): Record<string, unknown> | undefined {
	const row = rowAt(rowsOf(doc), rowId);
	if (row === undefined) return undefined;
	if (row.getAttr(PRESENCE) !== 'present') return undefined;
	const payload: Record<string, unknown> = {};
	for (const name of row.attrKeys()) {
		const value = row.getAttr(name);
		if (!name.startsWith('!') && !(value instanceof Y.Type)) {
			payload[name] = value;
		}
	}
	return payload;
}

/** A synchronised pair holding one row. */
function pair(): { laptop: Y.Doc; phone: Y.Doc; rowId: string } {
	const laptop = new Y.Doc({ gc: true });
	const phone = new Y.Doc({ gc: true });
	const rowId = 'r000000000000000000000001';
	create(laptop, rowId, 'Groceries');
	sync(laptop, phone);
	return { laptop, phone, rowId };
}

describe('a concurrent delete and edit reads the same under both models', () => {
	for (const model of ['clear-and-flag', 'drop'] as const) {
		test(`${model}: the row is gone, and the peer's edit is not visible`, () => {
			const { laptop, phone, rowId } = pair();

			// Genuinely concurrent: neither has seen the other.
			remove(laptop, rowId, model);
			edit(phone, rowId, 'renamed on the phone');
			sync(laptop, phone);

			// The claim the expensive model is defending is that it "retains the
			// peer's edit". It does retain it in the CRDT, and a reader cannot see
			// it either way, because the row is deleted.
			expect(read(laptop, rowId)).toBeUndefined();
			expect(read(phone, rowId)).toBeUndefined();
		});

		test(`${model}: the two devices converge`, () => {
			const { laptop, phone, rowId } = pair();
			remove(laptop, rowId, model);
			edit(phone, rowId, 'renamed on the phone');
			sync(laptop, phone);

			expect(read(phone, rowId)).toEqual(read(laptop, rowId) as never);
		});

		test(`${model}: delete wins regardless of which side goes first`, () => {
			const { laptop, phone, rowId } = pair();
			edit(phone, rowId, 'renamed on the phone');
			sync(laptop, phone);
			remove(laptop, rowId, model);
			sync(laptop, phone);

			expect(read(laptop, rowId)).toBeUndefined();
			expect(read(phone, rowId)).toBeUndefined();
		});
	}

	test('CONTROL: without a delete, the concurrent edit IS visible', () => {
		// Without this, every assertion above passes for a harness where nothing
		// merges at all and the row was never really there.
		const { laptop, phone, rowId } = pair();
		edit(phone, rowId, 'renamed on the phone');
		sync(laptop, phone);

		expect(read(laptop, rowId)).toEqual({ title: 'renamed on the phone' });
	});
});

describe('what the two models really differ on', () => {
	test('clear-and-flag keeps the peer edit as a hidden field on the corpse', () => {
		// The retained edit, made visible by looking where a reader never looks.
		// It is not recoverable through any store verb, and it is not nothing: it
		// is a field that will reappear if the address is ever brought back.
		const { laptop, phone, rowId } = pair();
		remove(laptop, rowId, 'clear-and-flag');
		edit(phone, rowId, 'renamed on the phone');
		sync(laptop, phone);

		const corpse = rowAt(rowsOf(laptop), rowId);
		expect(corpse?.getAttr('title')).toBe('renamed on the phone');
		expect(corpse?.getAttr(PRESENCE)).toBe('absent');
	});

	test('and reviving that address resurrects the stray field', () => {
		// The cost of retention, which is the opposite of a benefit. `writeRow`
		// sets presence back to present at a reused address, and the peer's edit
		// to a row everyone agreed was deleted comes back with it.
		const { laptop, phone, rowId } = pair();
		remove(laptop, rowId, 'clear-and-flag');
		edit(phone, rowId, 'renamed on the phone');
		sync(laptop, phone);

		laptop.transact(() => {
			rowAt(rowsOf(laptop), rowId)?.setAttr(PRESENCE, 'present');
		});

		expect(read(laptop, rowId)).toEqual({ title: 'renamed on the phone' });
	});

	test('dropping loses the peer edit outright, which is the same answer a reader got', () => {
		const { laptop, phone, rowId } = pair();
		remove(laptop, rowId, 'drop');
		edit(phone, rowId, 'renamed on the phone');
		sync(laptop, phone);

		expect(rowAt(rowsOf(laptop), rowId)).toBeUndefined();
		expect([...rowsOf(laptop).attrKeys()]).toEqual([]);
	});

	test('dropping also removes the key, so listing stops paying for the dead', () => {
		// `listRowIds` walks every key the table root has ever held and tests each
		// one for liveness, which its own comment prices at 24.9 ms for a thousand
		// live rows among a hundred thousand dead. Under removal the dead keys are
		// not there to walk.
		const doc = new Y.Doc({ gc: true });
		for (let index = 0; index < 500; index += 1) {
			create(doc, `r${String(index).padStart(23, '0')}`, `note ${index}`);
		}
		for (let index = 0; index < 400; index += 1) {
			remove(doc, `r${String(index).padStart(23, '0')}`, 'drop');
		}

		expect([...rowsOf(doc).attrKeys()]).toHaveLength(100);

		const cleared = new Y.Doc({ gc: true });
		for (let index = 0; index < 500; index += 1) {
			create(cleared, `r${String(index).padStart(23, '0')}`, `note ${index}`);
		}
		for (let index = 0; index < 400; index += 1) {
			remove(cleared, `r${String(index).padStart(23, '0')}`, 'clear-and-flag');
		}

		expect([...rowsOf(cleared).attrKeys()]).toHaveLength(500);
	});
});

describe("a row's content node under a concurrent delete", () => {
	for (const model of ['clear-and-flag', 'drop'] as const) {
		test(`${model}: text written concurrently does not revive the row`, () => {
			const { laptop, phone, rowId } = pair();
			const container = rowAt(rowsOf(phone), rowId);
			if (container === undefined) throw new Error('the row is gone');
			const text = typeAt(container, CONTENT);
			if (text === undefined) throw new Error('the row has no content node');

			remove(laptop, rowId, model);
			phone.transact(() => {
				const editor = new Y.Type('text' as never);
				putType(text, 'editor', editor);
				editor.applyDelta(editor.change.insert('buy milk') as never);
			});
			sync(laptop, phone);

			expect(read(laptop, rowId)).toBeUndefined();
			expect(read(phone, rowId)).toBeUndefined();
		});
	}
});

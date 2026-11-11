/**
 * Whether clear-and-flag buys anything a reader can see.
 *
 * The former `deleteRow` cleared a row's fields and flagged it absent rather
 * than removing it from the table root. The proposed benefit was retaining a
 * concurrent edit on the deleted row. The current implementation drops the
 * root attribute; these tests preserve the comparison that led to that choice.
 *
 * That costs about 8 items per dead row against 2 for removal, which is 458 MB
 * against 100 MB over a decade of ordinary churn (`evidence/bench/tombstones.ts`).
 * At that price the benefit has to be real, so these tests ask what a reader
 * actually observes under each model rather than what the CRDT retains.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

const PRESENCE = '!presence';
const DOCUMENT = '!doc';

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
		const row = new Y.Type();
		rowsOf(doc).setAttr(rowId as never, row as never);
		row.setAttr(PRESENCE as never, 'present' as never);
		row.setAttr(DOCUMENT as never, new Y.Type() as never);
		row.setAttr('title' as never, title as never);
	});
}

function remove(doc: Y.Doc, rowId: string, model: Model): void {
	doc.transact(() => {
		const root = rowsOf(doc);
		if (model === 'drop') {
			root.deleteAttr(rowId);
			return;
		}
		const row = root.getAttr(rowId as never) as unknown as Y.Type;
		for (const key of [...row.attrKeys()]) {
			if (key !== PRESENCE) row.deleteAttr(key as string);
		}
		row.setAttr(PRESENCE as never, 'absent' as never);
	});
}

function edit(doc: Y.Doc, rowId: string, title: string): void {
	doc.transact(() => {
		const row = rowsOf(doc).getAttr(rowId as never) as unknown as Y.Type;
		row.setAttr('title' as never, title as never);
	});
}

/** What the store's `readRow` would return: undefined unless live. */
function read(doc: Y.Doc, rowId: string): Record<string, unknown> | undefined {
	const value = rowsOf(doc).getAttr(rowId as never) as unknown;
	if (!(value instanceof Y.Type)) return undefined;
	if (value.getAttr(PRESENCE as never) !== 'present') return undefined;
	const payload: Record<string, unknown> = {};
	for (const key of value.attrKeys()) {
		const name = key as string;
		if (!name.startsWith('!')) payload[name] = value.getAttr(name as never);
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

		const corpse = rowsOf(laptop).getAttr(rowId as never) as unknown as Y.Type;
		expect(corpse.getAttr('title' as never)).toBe('renamed on the phone');
		expect(corpse.getAttr(PRESENCE as never)).toBe('absent');
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
			const row = rowsOf(laptop).getAttr(rowId as never) as unknown as Y.Type;
			row.setAttr(PRESENCE as never, 'present' as never);
		});

		expect(read(laptop, rowId)).toEqual({ title: 'renamed on the phone' });
	});

	test('dropping loses the peer edit outright, which is the same answer a reader got', () => {
		const { laptop, phone, rowId } = pair();
		remove(laptop, rowId, 'drop');
		edit(phone, rowId, 'renamed on the phone');
		sync(laptop, phone);

		expect(rowsOf(laptop).getAttr(rowId as never)).toBeUndefined();
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

describe('a row document under a concurrent delete', () => {
	for (const model of ['clear-and-flag', 'drop'] as const) {
		test(`${model}: prose written concurrently does not revive the row`, () => {
			const { laptop, phone, rowId } = pair();
			const container = rowsOf(phone).getAttr(
				rowId as never,
			) as unknown as Y.Type;
			const text = container.getAttr(DOCUMENT as never) as unknown as Y.Type;

			remove(laptop, rowId, model);
			phone.transact(() => {
				const editor = new Y.Type('text' as never);
				text.setAttr('editor' as never, editor as never);
				editor.applyDelta(editor.change.insert('buy milk') as never);
			});
			sync(laptop, phone);

			expect(read(laptop, rowId)).toBeUndefined();
			expect(read(phone, rowId)).toBeUndefined();
		});
	}
});

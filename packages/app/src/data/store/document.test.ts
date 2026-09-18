/**
 * The row primitives, and the one line between them that a durable table used
 * to guard.
 *
 * `createRow` mints a row when it is absent; `updateRow` cannot. That
 * difference is the whole of why they are two functions, and these tests are
 * the difference stated where it can be seen.
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import {
	createDatabaseDocument,
	createRow,
	deleteRow,
	hasRow,
	readRow,
	readRowContent,
	tableRoot,
	updateRow,
} from './document.js';

function table(): { document: Y.Doc; notes: Y.Type } {
	const document = createDatabaseDocument();
	return { document, notes: tableRoot(document, 'notes') };
}

describe('createRow mints, and it is the only thing that does', () => {
	test('a row that was not there is there afterwards', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		expect(readRow(notes, 'a')).toEqual({ title: 'hello' });
	});

	test('creating over an existing row merges rather than replacing it', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		document.transact(() => createRow(notes, 'a', { pinned: true }));
		expect(readRow(notes, 'a')).toEqual({ title: 'hello', pinned: true });
	});

	test('creating over an existing row cannot replace its content node', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', {}));
		const replacement = new Y.Type();

		expect(() =>
			document.transact(() => createRow(notes, 'a', { content: replacement })),
		).toThrow(/cannot replace the content node/);
		expect(readRowContent(notes, 'a')).toBeDefined();
		expect(replacement.doc).toBeNull();
	});

	test('creating over an existing row refuses one without content', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', {}));
		const row = notes.getAttr('a') as unknown;
		if (!(row instanceof Y.Type)) throw new Error('row was not created');
		document.transact(() => row.deleteAttr('content'));

		expect(() =>
			document.transact(() => createRow(notes, 'a', { title: 'hello' })),
		).toThrow(/has no live content node/);
	});

	test('invalid content does not leave a partially minted row', () => {
		const { document, notes } = table();

		expect(() =>
			document.transact(() =>
				createRow(notes, 'a', { content: 'body' as never }),
			),
		).toThrow(/reserved for the row's live content node/);
		expect(hasRow(notes, 'a')).toBe(false);
		expect([...notes.attrKeys()]).toEqual([]);
	});

	test('an integrated content node does not leave a partially minted row', () => {
		const { document, notes } = table();
		const other = createDatabaseDocument();
		const integrated = new Y.Type();
		other.get('content').setAttr('node', integrated);

		expect(() =>
			document.transact(() => createRow(notes, 'a', { content: integrated })),
		).toThrow(/already belongs to a document/);
		expect(hasRow(notes, 'a')).toBe(false);
		expect([...notes.attrKeys()]).toEqual([]);
	});
});

describe('updateRow cannot bring a row into existence', () => {
	test('updating an absent row writes nothing and says so', () => {
		const { document, notes } = table();
		let wrote = true;
		document.transact(() => {
			wrote = updateRow(notes, 'missing', { title: 'ghost' });
		});
		expect(wrote).toBe(false);
		expect(hasRow(notes, 'missing')).toBe(false);
		expect([...notes.attrKeys()]).toEqual([]);
	});

	test('updating a row that exists writes and says so', () => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		let wrote = false;
		document.transact(() => {
			wrote = updateRow(notes, 'a', { title: 'changed' });
		});
		expect(wrote).toBe(true);
		expect(readRow(notes, 'a')).toEqual({ title: 'changed' });
	});

	test('a deleted row stays deleted, which is what the split is for', () => {
		// The resurrection path, closed. `deriveOnCommit` writes `updatedAt`
		// whenever a row's content node commits, so on a device whose row was deleted
		// elsewhere a minting write would create a NEW nested type at the same
		// key — new data, which nothing in Yjs can refuse
		// (`evidence/invariants.test.ts`). This is that write, dropped.
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		document.transact(() => deleteRow(notes, 'a'));

		let wrote = true;
		document.transact(() => {
			wrote = updateRow(notes, 'a', { updatedAt: '2026-08-28T00:00:00Z' });
		});
		expect(wrote).toBe(false);
		expect(hasRow(notes, 'a')).toBe(false);
		expect([...notes.attrKeys()]).toEqual([]);
	});
});

describe('both refuse a reserved field name', () => {
	test.each([['createRow'], ['updateRow']])('%s', (which) => {
		const { document, notes } = table();
		document.transact(() => createRow(notes, 'a', { title: 'hello' }));
		expect(() =>
			document.transact(() =>
				which === 'createRow'
					? createRow(notes, 'a', { '!internal': 1 })
					: updateRow(notes, 'a', { '!internal': 1 }),
			),
		).toThrow(TypeError);
	});
});

describe('why there is no upsert', () => {
	function sync(a: Y.Doc, b: Y.Doc): void {
		const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
		const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
		Y.applyUpdateV2(b, fromA);
		Y.applyUpdateV2(a, fromB);
	}

	test('two devices creating one CHOSEN id lose one of them, at random', () => {
		// The reason `set(rowId, fields)` is not on the table surface. An upsert
		// takes an id from its caller, so two devices can both reach the minting
		// branch for the same key — and a nested type is addressed by its struct
		// id, so the map keeps one container and discards the other with
		// everything in it.
		//
		// Worse than "one of them loses": WHICH one is decided by the losing
		// document's random `clientID`, so it is a coin flip. Measured over 200
		// runs it came out 96/104, and the two devices agreed every time — they
		// converge, on an answer that half the time is not yours. A person who
		// lost work this way cannot reproduce it.
		//
		// This is the chosen-id door ADR-0216 closed, arriving through an API
		// shape rather than through an id parameter, which is why the assertion
		// below is about the invariant and not about a winner.
		const phone = createDatabaseDocument();
		const laptop = createDatabaseDocument();
		phone.transact(() =>
			createRow(tableRoot(phone, 'notes'), 'shared', { fromPhone: 'a' }),
		);
		laptop.transact(() =>
			createRow(tableRoot(laptop, 'notes'), 'shared', { fromLaptop: 'b' }),
		);
		sync(phone, laptop);

		const onPhone = readRow(tableRoot(phone, 'notes'), 'shared');
		const onLaptop = readRow(tableRoot(laptop, 'notes'), 'shared');
		// They converge...
		expect(onLaptop).toEqual(onPhone);
		// ...on exactly one device's fields, never both, and which one is the
		// coin flip.
		expect([
			{ fromPhone: 'a' },
			{ fromLaptop: 'b' },
		] as (typeof onPhone)[]).toContainEqual(onPhone);
	});

	test('the same two devices, each minting its own id, lose nothing', () => {
		// The control, and the whole of why `create` mints rather than accepts.
		const phone = createDatabaseDocument();
		const laptop = createDatabaseDocument();
		phone.transact(() =>
			createRow(tableRoot(phone, 'notes'), 'phone-1', { fromPhone: 'a' }),
		);
		laptop.transact(() =>
			createRow(tableRoot(laptop, 'notes'), 'laptop-1', { fromLaptop: 'b' }),
		);
		sync(phone, laptop);

		expect([...tableRoot(phone, 'notes').attrKeys()].sort()).toEqual([
			'laptop-1',
			'phone-1',
		]);
	});
});

/**
 * The `'delta'` behaviour the store's per-table subscription rests on, pinned.
 *
 * Every assertion here is a property of `@y/y@14.0.0-rc.24` rather than of
 * Epicenter's own code, and a failure means an upgrade moved something the
 * subscription's design is resting on rather than that the store has a bug.
 *
 * There is a specific reason to pin this one. `store.ts` correctly recorded
 * that `observeDeep` reports a nested row's field edit as an event on the TABLE
 * ROOT with `keysChanged` empty, so an `observeDeep` observer cannot name the
 * row. The conclusion drawn from it, that nothing can name the row and a remote
 * change is therefore only expressible as "some table moved", does not follow:
 * the same type emits `'delta'`, whose `attrs` is keyed by the attribute that
 * changed, and a row IS an attribute on the table root. The first half is
 * asserted here beside the second so the true observation cannot be read back
 * as the false conclusion.
 *
 * Every case carries a CONTROL: a second table whose own listener must record
 * nothing. Without it a run where the listener was never attached, or where
 * `attrs` silently became empty, would read as a pass on every assertion that
 * only checks what the watched table saw.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

/** Row ids one listener saw, in order, one entry per emitted delta. */
type Recorded = { rowIds: string[][]; origins: unknown[] };

function watch(type: Y.Type): Recorded {
	const recorded: Recorded = { rowIds: [], origins: [] };
	type.on('delta', (delta: unknown, origin: unknown) => {
		const { attrs } = delta as { attrs?: Record<string, unknown> };
		recorded.rowIds.push(Object.keys(attrs ?? {}));
		recorded.origins.push(origin);
	});
	return recorded;
}

/** The store's own grammar: a row is a nested type at its id on the root. */
function writeRow(
	root: Y.Type,
	rowId: string,
	fields: Record<string, unknown>,
) {
	let row = root.getAttr(rowId as never) as Y.Type | undefined;
	if (!(row instanceof Y.Type)) {
		row = new Y.Type();
		root.setAttr(rowId as never, row as never);
	}
	for (const [name, value] of Object.entries(fields)) {
		row.setAttr(name as never, value as never);
	}
	return row;
}

describe("a table root's 'delta' names the rows a commit touched", () => {
	let document: Y.Doc;
	let notes: Y.Type;
	let folders: Y.Type;
	let seen: Recorded;
	let control: Recorded;

	beforeEach(() => {
		document = new Y.Doc({ gc: true });
		notes = document.get('notes');
		folders = document.get('folders');
		seen = watch(notes);
		control = watch(folders);
	});

	test('a created row', () => {
		document.transact(() => writeRow(notes, 'note-a', { title: 'Groceries' }));

		expect(seen.rowIds).toEqual([['note-a']]);
		expect(control.rowIds).toEqual([]);
	});

	test('a field edited on a row that already exists', () => {
		document.transact(() => writeRow(notes, 'note-a', { title: 'Groceries' }));
		seen.rowIds.length = 0;

		document.transact(() => writeRow(notes, 'note-a', { title: 'Shopping' }));

		expect(seen.rowIds).toEqual([['note-a']]);
		expect(control.rowIds).toEqual([]);
	});

	test('a removed row', () => {
		document.transact(() => writeRow(notes, 'note-a', { title: 'Groceries' }));
		seen.rowIds.length = 0;

		document.transact(() => notes.deleteAttr('note-a'));

		expect(seen.rowIds).toEqual([['note-a']]);
		expect(control.rowIds).toEqual([]);
	});

	test('bytes that arrived from a peer', () => {
		const peer = new Y.Doc({ gc: true });
		peer.transact(() =>
			writeRow(peer.get('notes'), 'note-b', { title: 'From the phone' }),
		);
		const remote = { kind: 'epicenter-remote' };

		Y.applyUpdateV2(document, Y.encodeStateAsUpdateV2(peer), remote);

		expect(seen.rowIds).toEqual([['note-b']]);
		expect(seen.origins).toEqual([remote]);
		expect(control.rowIds).toEqual([]);
	});

	test('one commit touching many rows is ONE delta carrying every id', () => {
		// ADR-0187's law 3, satisfied by the engine rather than by grouping code:
		// sixty-four rows in one transaction is one event with sixty-four ids.
		document.transact(() => {
			for (let index = 0; index < 64; index += 1) {
				writeRow(notes, `note-${index}`, { title: `Note ${index}` });
			}
		});

		expect(seen.rowIds).toHaveLength(1);
		expect(seen.rowIds[0]).toHaveLength(64);
		expect(control.rowIds).toEqual([]);
	});

	test('observeDeep sees the same nested edit and CANNOT name the row', () => {
		// The true half of the store's original comment, kept beside the delta
		// assertions so the observation is not read back as the conclusion.
		document.transact(() => writeRow(notes, 'note-a', { title: 'Groceries' }));
		const reported: { onTheRoot: boolean; keysChanged: string[] }[] = [];
		notes.observeDeep((event) => {
			reported.push({
				onTheRoot: event.target === notes,
				keysChanged: [...event.keysChanged],
			});
		});

		document.transact(() => writeRow(notes, 'note-a', { title: 'Shopping' }));

		expect(reported).toEqual([{ onTheRoot: true, keysChanged: [] }]);
	});
});

describe('the delta fires before a follower could have been rebuilt', () => {
	test("'delta' precedes afterTransaction, which precedes updateV2", () => {
		// The hazard the store's buffer exists for. The ids are known while
		// anything derived from the document still describes the state before
		// the change, so a subscriber notified here would read a row id that a
		// derived index cannot find yet. `store.test.ts` asserts the store waits.
		const document = new Y.Doc({ gc: true });
		const notes = document.get('notes');
		const order: string[] = [];
		notes.on('delta', () => order.push('delta'));
		document.on('afterTransaction', () => order.push('afterTransaction'));
		document.on('updateV2', () => order.push('updateV2'));

		document.transact(() => writeRow(notes, 'note-a', { title: 'Groceries' }));

		expect(order).toEqual(['delta', 'afterTransaction', 'updateV2']);
	});
});

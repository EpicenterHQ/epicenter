/**
 * Per-Cell Yjs Convergence Tests
 *
 * Verifies the raw Yjs behaviors required by the proposed Workspace table
 * layout before the layout becomes production code. Every concurrent scenario
 * is merged in both arrival orders so the assertions pin convergence rather
 * than one provider's message ordering.
 *
 * Key behaviors:
 * - Concurrent writes to different cell maps both survive.
 * - A row-presence delete is independent from late cell writes.
 * - Explicit reinsertion is the only tested operation that restores presence.
 * - Concurrent inserts of one row ID preserve disjoint cells.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';

const NOTE_ID = 'note-1';

type TableMaps = {
	rows: Y.Map<boolean>;
	title: Y.Map<string>;
	pinned: Y.Map<boolean>;
};

type VisibleState = {
	pinned: boolean | undefined;
	present: boolean;
	title: string | undefined;
};

function getTableMaps(doc: Y.Doc): TableMaps {
	return {
		rows: doc.getMap<boolean>('table:notes:rows'),
		title: doc.getMap<string>('table:notes:cell:title'),
		pinned: doc.getMap<boolean>('table:notes:cell:pinned'),
	};
}

function fork(doc: Y.Doc): Y.Doc {
	const copy = new Y.Doc({ gc: true });
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	return copy;
}

function mergeBothWays(left: Y.Doc, right: Y.Doc): [Y.Doc, Y.Doc] {
	const leftUpdate = Y.encodeStateAsUpdate(left);
	const rightUpdate = Y.encodeStateAsUpdate(right);

	const leftThenRight = new Y.Doc({ gc: true });
	Y.applyUpdate(leftThenRight, leftUpdate);
	Y.applyUpdate(leftThenRight, rightUpdate);

	const rightThenLeft = new Y.Doc({ gc: true });
	Y.applyUpdate(rightThenLeft, rightUpdate);
	Y.applyUpdate(rightThenLeft, leftUpdate);

	return [leftThenRight, rightThenLeft];
}

function readState(doc: Y.Doc): VisibleState {
	const table = getTableMaps(doc);
	return {
		present: table.rows.has(NOTE_ID),
		title: table.title.get(NOTE_ID),
		pinned: table.pinned.get(NOTE_ID),
	};
}

function createExistingRow(): Y.Doc {
	const doc = new Y.Doc({ gc: true });
	const table = getTableMaps(doc);
	doc.transact(() => {
		table.rows.set(NOTE_ID, true);
		table.title.set(NOTE_ID, 'Original');
		table.pinned.set(NOTE_ID, false);
	});
	return doc;
}

describe('per-cell Yjs convergence', () => {
	test('concurrent patches to different cells preserve both values in both merge orders', () => {
		const base = createExistingRow();
		const titleWriter = fork(base);
		const pinnedWriter = fork(base);

		getTableMaps(titleWriter).title.set(NOTE_ID, 'Renamed');
		getTableMaps(pinnedWriter).pinned.set(NOTE_ID, true);

		const [leftThenRight, rightThenLeft] = mergeBothWays(
			titleWriter,
			pinnedWriter,
		);
		const expected = {
			present: true,
			title: 'Renamed',
			pinned: true,
		};

		expect(readState(leftThenRight)).toEqual(expected);
		expect(readState(rightThenLeft)).toEqual(expected);
	});

	test('concurrent patches to one cell choose the same value in both merge orders', () => {
		const base = createExistingRow();
		const left = fork(base);
		const right = fork(base);

		getTableMaps(left).title.set(NOTE_ID, 'From left');
		getTableMaps(right).title.set(NOTE_ID, 'From right');

		const [leftThenRight, rightThenLeft] = mergeBothWays(left, right);
		const first = readState(leftThenRight);
		const second = readState(rightThenLeft);

		expect(first).toEqual(second);
		expect(first.title === 'From left' || first.title === 'From right').toBe(
			true,
		);
	});

	test('a concurrent set survives deletion of the previously observed cell value', () => {
		const base = createExistingRow();
		const deleter = fork(base);
		const writer = fork(base);

		getTableMaps(deleter).title.delete(NOTE_ID);
		getTableMaps(writer).title.set(NOTE_ID, 'Concurrent value');

		const [leftThenRight, rightThenLeft] = mergeBothWays(deleter, writer);

		expect(readState(leftThenRight).title).toBe('Concurrent value');
		expect(readState(rightThenLeft).title).toBe('Concurrent value');
	});

	test('a late cell patch remains hidden after concurrent row deletion', () => {
		const base = createExistingRow();
		const deleter = fork(base);
		const lateWriter = fork(base);
		const deletedTable = getTableMaps(deleter);

		deleter.transact(() => {
			deletedTable.rows.delete(NOTE_ID);
			deletedTable.title.delete(NOTE_ID);
			deletedTable.pinned.delete(NOTE_ID);
		});
		getTableMaps(lateWriter).title.set(NOTE_ID, 'Late value');

		const [leftThenRight, rightThenLeft] = mergeBothWays(deleter, lateWriter);

		for (const merged of [leftThenRight, rightThenLeft]) {
			expect(readState(merged)).toEqual({
				present: false,
				title: 'Late value',
				pinned: undefined,
			});
		}
	});

	test('explicit reinsertion restores presence and reveals a retained late cell', () => {
		const base = createExistingRow();
		const deleter = fork(base);
		const lateWriter = fork(base);
		const deletedTable = getTableMaps(deleter);

		deleter.transact(() => {
			deletedTable.rows.delete(NOTE_ID);
			deletedTable.title.delete(NOTE_ID);
			deletedTable.pinned.delete(NOTE_ID);
		});
		getTableMaps(lateWriter).title.set(NOTE_ID, 'Late value');

		const [merged] = mergeBothWays(deleter, lateWriter);
		getTableMaps(merged).rows.set(NOTE_ID, true);

		expect(readState(merged)).toEqual({
			present: true,
			title: 'Late value',
			pinned: undefined,
		});
	});

	test('concurrent inserts of one ID preserve disjoint cells', () => {
		const titleWriter = new Y.Doc({ gc: true });
		const pinnedWriter = new Y.Doc({ gc: true });
		const titleTable = getTableMaps(titleWriter);
		const pinnedTable = getTableMaps(pinnedWriter);

		titleWriter.transact(() => {
			titleTable.rows.set(NOTE_ID, true);
			titleTable.title.set(NOTE_ID, 'Created left');
		});
		pinnedWriter.transact(() => {
			pinnedTable.rows.set(NOTE_ID, true);
			pinnedTable.pinned.set(NOTE_ID, true);
		});

		const [leftThenRight, rightThenLeft] = mergeBothWays(
			titleWriter,
			pinnedWriter,
		);
		const expected = {
			present: true,
			title: 'Created left',
			pinned: true,
		};

		expect(readState(leftThenRight)).toEqual(expected);
		expect(readState(rightThenLeft)).toEqual(expected);
	});
});

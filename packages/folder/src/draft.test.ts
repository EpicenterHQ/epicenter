/**
 * Draft Tests
 *
 * A draft is one edit of a row that holds its own starting version
 * (ADR-0548).
 *
 * Key behaviors:
 * - The base is captured at the first change only; later changes, and a
 *   refetch that put a newer row in the cache, leave it alone
 * - "Changed elsewhere" is derived: the cache's version is not the base's
 * - A save sends the base and a copy of the edited row; a save that landed
 *   with no change since ends the draft, and changes made while it ran
 *   continue over the row it sent; after a merge they are merged again,
 *   so what the merge took from another writer is not undone
 */
import { expect, test } from 'bun:test';
import { createDraft } from './draft.js';
import type { SavedRow, StoredRow } from './table.js';

type Todo = { title: string; done: boolean };

const stored = (sha: string, title: string): StoredRow<Todo> =>
	Object.freeze({
		path: 'todos/a.md',
		sha256: sha.repeat(64),
		row: { fields: { title, done: false }, body: '' },
	});

test('the base is captured at the first change only', () => {
	const draft = createDraft<Todo>();
	expect(draft.base).toBeUndefined();
	const first = stored('a', 'One');
	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	expect(draft.base).toBe(first);
	// The cache's row is never edited.
	expect(first.row.fields.title).toBe('One');

	// A refetch put another writer's row in the cache; the next change keeps
	// the base and edits the draft's row.
	const refetched = stored('b', 'Theirs');
	draft.change(refetched, (row) => {
		row.fields.done = true;
	});
	expect(draft.base).toBe(first);
	expect(draft.row).toEqual({
		fields: { title: 'Mine', done: true },
		body: '',
	});
});

test('changed elsewhere is derived from the versions', () => {
	const draft = createDraft<Todo>();
	const first = stored('a', 'One');
	expect(draft.changedElsewhere(first)).toBe(false);
	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	expect(draft.changedElsewhere(first)).toBe(false);
	expect(draft.changedElsewhere(stored('b', 'Theirs'))).toBe(true);
	// A row deleted elsewhere changed too.
	expect(draft.changedElsewhere(undefined)).toBe(true);
});

test('a save sends the base; one that landed ends the draft, and later changes continue from it', () => {
	const draft = createDraft<Todo>();
	expect(draft.toSave()).toBeUndefined();
	const first = stored('a', 'One');
	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	const sent = draft.toSave()!;
	expect(sent.base).toBe(first);
	expect(sent.row.fields.title).toBe('Mine');

	// A change while the save runs is not in what it sent.
	draft.change(first, (row) => {
		row.fields.done = true;
	});
	expect(sent.row.fields.done).toBe(false);
	const written: SavedRow<Todo> = {
		stored: stored('c', 'Mine'),
		merged: false,
		replaced: [],
	};
	draft.saved(sent, written);
	expect(draft.base).toEqual({
		path: written.stored.path,
		sha256: written.stored.sha256,
		row: sent.row,
	});
	expect(draft.row?.fields).toEqual({ title: 'Mine', done: true });

	const again = draft.toSave()!;
	draft.saved(again, {
		stored: stored('d', 'Mine'),
		merged: false,
		replaced: [],
	});
	expect(draft.base).toBeUndefined();
	expect(draft.row).toBeUndefined();
});

test('after a merged save, later changes are merged again over the row sent', () => {
	const draft = createDraft<Todo>();
	const first = stored('a', 'One');
	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	const sent = draft.toSave()!;
	draft.change(first, (row) => {
		row.fields.title = 'Mine, more';
	});
	// Another writer marked it done; the save merged that in.
	const merged: SavedRow<Todo> = {
		stored: Object.freeze({
			path: 'todos/a.md',
			sha256: 'c'.repeat(64),
			row: { fields: { title: 'Mine', done: true }, body: '' },
		}),
		merged: true,
		replaced: [],
	};
	draft.saved(sent, merged);
	const next = draft.toSave()!;
	// The base still names the version the sent save started from, so the
	// next save finds the file moved and merges; over the row sent, the
	// draft changed the title only, and `done` stays as the merge left it.
	expect(next.base.sha256).toBe(first.sha256);
	expect(next.base.row?.fields).toEqual({ title: 'Mine', done: false });
	expect(next.row.fields).toEqual({ title: 'Mine, more', done: false });
});

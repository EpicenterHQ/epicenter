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
 *   continue from the version it wrote, which is the new base; after a
 *   merge they are merged onto it, so what the merge took from another
 *   writer is not undone
 * - A text draft does the same for one file's text, merging by line
 */
import { expect, test } from 'bun:test';
import { createDraft, createTextDraft } from './draft.js';
import type { SavedRow, StoredRow } from './table.js';

type Todo = { title: string; done: boolean };

const stored = (sha: string, title: string, done = false): StoredRow<Todo> =>
	Object.freeze({
		path: 'todos/a.md',
		sha256: sha.repeat(64),
		text: `---\ntitle: ${title}\ndone: ${done}\n---\n`,
		row: { fields: { title, done }, body: '' },
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

test('a save sends the base; one that landed ends the draft, and later changes continue from it', async () => {
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
	await draft.saved(sent, written);
	expect(draft.base).toBe(written.stored);
	expect(draft.row?.fields).toEqual({ title: 'Mine', done: true });

	const again = draft.toSave()!;
	await draft.saved(again, {
		stored: stored('d', 'Mine'),
		merged: false,
		replaced: [],
	});
	expect(draft.base).toBeUndefined();
	expect(draft.row).toBeUndefined();
});

test('after a merged save, later changes are merged onto the version it wrote', async () => {
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
		stored: stored('c', 'Mine', true),
		merged: true,
		replaced: [],
	};
	await draft.saved(sent, merged);
	const next = draft.toSave()!;
	// The base is the version written; over the row sent, the draft changed
	// the title only, so `done` stays as the merge left it.
	expect(next.base).toBe(merged.stored);
	expect(next.row.fields).toEqual({ title: 'Mine, more', done: true });
});

test('a change made while a merged save is merged onto its version is merged too', async () => {
	const draft = createDraft<Todo>();
	const first = stored('a', 'One');
	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	const sent = draft.toSave()!;
	draft.change(first, (row) => {
		row.fields.title = 'Mine, more';
	});
	const rebasing = draft.saved(sent, {
		stored: stored('c', 'Mine', true),
		merged: true,
		replaced: [],
	});
	draft.change(first, (row) => {
		row.fields.title = 'Mine, most';
	});
	await rebasing;
	expect(draft.row?.fields).toEqual({ title: 'Mine, most', done: true });
});

const file = (sha: string, text: string) =>
	Object.freeze({
		path: 'notes.txt',
		sha256: sha.repeat(64),
		bytes: new TextEncoder().encode(text),
	});

test('a text draft keeps its base apart from its text, and after a merged save carries later typing onto the version written', async () => {
	const draft = createTextDraft();
	const first = file('a', 'one\ntwo\n');
	draft.change(first, 'ONE\ntwo\n');
	expect(draft.base).toBe(first);
	const sent = draft.toSave()!;
	expect(sent).toMatchObject({ base: first, text: 'ONE\ntwo\n' });
	draft.change(first, 'ONE\ntwo\nthree\n');
	// Another writer changed the second line; the save merged it in.
	const written = file('c', 'ONE\nTWO\n');
	await draft.saved(sent, {
		stored: written,
		merged: true,
		replaced: [],
	});
	expect(draft.base).toBe(written);
	expect(draft.text).toBe('ONE\nTWO\nthree\n');
	const again = draft.toSave()!;
	await draft.saved(again, {
		stored: file('d', again.text),
		merged: false,
		replaced: [],
	});
	expect(draft.text).toBeUndefined();
});

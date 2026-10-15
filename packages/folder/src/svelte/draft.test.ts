/**
 * Draft State Tests
 *
 * `createDraftState` is `createDraft` read reactively, with the one save
 * loop every editor needs (ADR-0548).
 *
 * Key behaviors:
 * - A component re-reads the draft's row and "changed elsewhere" on each change
 * - Changes made while a save runs are sent next, from the version it wrote
 * - A failed save keeps the draft, and the next save sends it again
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import type { SaveRowVariables } from '../query.js';
import type { SavedRow, StoredRow } from '../table.js';

const { flushSync } = await import('svelte');
const { createDraftState } = await import('./draft.svelte.js');
const { track } = await import('./fixtures/track.svelte.js');

type Todo = { title: string; done: boolean };

const stored = (sha: string, title: string, done = false): StoredRow<Todo> =>
	Object.freeze({
		path: 'todos/a.md',
		sha256: sha.repeat(64),
		text: `---\ntitle: ${title}\ndone: ${done}\n---\n`,
		row: { fields: { title, done }, body: '' },
	});

const landed = (row: StoredRow<Todo>): SavedRow<Todo> => ({
	stored: row,
	merged: false,
	replaced: [],
});

/** A save whose results the test hands out, one call at a time. */
function heldSaves() {
	const calls: {
		sent: SaveRowVariables<Todo>;
		land(saved: SavedRow<Todo>): void;
		fail(error: Error): void;
	}[] = [];
	const save = (sent: SaveRowVariables<Todo>) =>
		new Promise<SavedRow<Todo>>((land, fail) => {
			calls.push({ sent, land, fail });
		});
	return { calls, save };
}

test('a component re-reads the row and "changed elsewhere" on each change', () => {
	const draft = createDraftState<Todo>({ save: heldSaves().save });
	const first = stored('a', 'One');
	const rows = track(() => draft.row?.fields.title);
	const elsewhere = track(() => draft.changedElsewhere(stored('b', 'Theirs')));
	flushSync();

	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	flushSync();
	draft.discard();
	flushSync();

	expect(rows.seen).toEqual([undefined, 'Mine', undefined]);
	expect(elsewhere.seen).toEqual([false, true, false]);
	rows.stop();
	elsewhere.stop();
});

test('changes made while a save runs are sent next, from the version it wrote', async () => {
	const { calls, save } = heldSaves();
	const heard: SavedRow<Todo>[] = [];
	const draft = createDraftState<Todo>({
		save,
		onSaved: (saved) => heard.push(saved),
	});
	const first = stored('a', 'One');

	await draft.save();
	expect(calls).toHaveLength(0);

	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});
	const done = draft.save();
	expect(draft.saving).toBe(true);
	draft.change(first, (row) => {
		row.fields.done = true;
	});
	// A second call joins the running loop.
	expect(draft.save()).toBe(done);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.sent.base).toBe(first);
	expect(calls[0]?.sent.row.fields).toEqual({ title: 'Mine', done: false });

	const written = stored('c', 'Mine');
	calls[0]?.land(landed(written));
	await Bun.sleep(0);
	expect(calls).toHaveLength(2);
	expect(calls[1]?.sent.base).toBe(written);
	expect(calls[1]?.sent.row.fields).toEqual({ title: 'Mine', done: true });

	const last = stored('d', 'Mine', true);
	calls[1]?.land(landed(last));
	await done;
	expect(draft.saving).toBe(false);
	expect(draft.row).toBeUndefined();
	expect(heard.map((saved) => saved.stored)).toEqual([written, last]);
});

test('a failed save keeps the draft, and the next save sends it again', async () => {
	const { calls, save } = heldSaves();
	const draft = createDraftState<Todo>({ save });
	const first = stored('a', 'One');
	draft.change(first, (row) => {
		row.fields.title = 'Mine';
	});

	const failing = draft.save();
	calls[0]?.fail(new Error('disk full'));
	await failing;
	expect(draft.saving).toBe(false);
	expect(draft.row?.fields.title).toBe('Mine');
	expect(draft.base).toBe(first);

	const retry = draft.save();
	expect(calls[1]?.sent.base).toBe(first);
	calls[1]?.land(landed(stored('b', 'Mine')));
	await retry;
	expect(draft.row).toBeUndefined();
});

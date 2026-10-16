/**
 * Text Draft State Tests
 *
 * `createTextDraftState` is a file's text draft read reactively, with the
 * one save loop every document editor needs (ADR-0548). `createBodyEditor`
 * opens a row's body over the table's one write (ADR-0576).
 *
 * Key behaviors:
 * - A component re-reads the draft's text on each change
 * - Text typed while a save runs is sent next, from the version it wrote
 * - A failed save keeps the draft, and the next save sends it again
 * - A body editor shows the file's body until something is typed, sends the
 *   change from the row it started from to that row with the typed body,
 *   and shows the file again once its save lands with nothing typed since
 * - Typing during a save makes the next save start from what that one sent
 * - A failed save keeps what is typed; nothing is saved while the row is gone
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import type { CapturedFile } from '../capture.js';
import type { SaveTextVariables } from '../draft.js';
import type { SavedFile } from '../save-file.js';
import type { Row } from '../row-text.js';
import type { StoredRow } from '../table.js';

const { flushSync } = await import('svelte');
const { createBodyEditor, createTextDraftState } = await import(
	'./draft.svelte.js'
);
const { track } = await import('./fixtures/track.svelte.js');

const file = (sha: string, text: string): CapturedFile =>
	Object.freeze({
		path: 'notes.txt',
		sha256: sha.repeat(64),
		bytes: new TextEncoder().encode(text),
	});

const landed = (stored: CapturedFile): SavedFile => ({
	stored,
	merged: false,
});

/** A save whose results the test hands out, one call at a time. */
function heldSaves<TSent, TSaved>() {
	const calls: {
		sent: TSent;
		land(saved: TSaved): void;
		fail(error: Error): void;
	}[] = [];
	const save = (sent: TSent) =>
		new Promise<TSaved>((land, fail) => {
			calls.push({ sent, land, fail });
		});
	return { calls, save };
}

test("a component re-reads the draft's text on each change", () => {
	const draft = createTextDraftState({
		save: heldSaves<SaveTextVariables, SavedFile>().save,
	});
	const texts = track(() => draft.text);
	flushSync();

	draft.change(file('a', 'one\n'), 'mine\n');
	flushSync();
	draft.discard();
	flushSync();

	expect(texts.seen).toEqual([undefined, 'mine\n', undefined]);
	texts.stop();
});

test('text typed while a save runs is sent next, from the version it wrote', async () => {
	const { calls, save } = heldSaves<SaveTextVariables, SavedFile>();
	const draft = createTextDraftState({ save });
	const first = file('a', 'one\n');

	await draft.save();
	expect(calls).toHaveLength(0);

	draft.change(first, 'ONE\n');
	const done = draft.save();
	expect(draft.saving).toBe(true);
	draft.change(first, 'ONE\ntwo\n');
	// A second call joins the running loop.
	expect(draft.save()).toBe(done);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.sent).toEqual({ base: first, content: 'ONE\n' });

	const written = file('b', 'ONE\n');
	calls[0]?.land(landed(written));
	await Bun.sleep(0);
	expect(calls).toHaveLength(2);
	expect(calls[1]?.sent).toEqual({ base: written, content: 'ONE\ntwo\n' });

	const last = file('c', 'ONE\ntwo\n');
	calls[1]?.land(landed(last));
	await done;
	expect(draft.saving).toBe(false);
	expect(draft.text).toBeUndefined();
	expect(draft.base).toBeUndefined();
});

test('a failed save keeps the draft, and the next save sends it again', async () => {
	const { calls, save } = heldSaves<SaveTextVariables, SavedFile>();
	const draft = createTextDraftState({ save });
	const first = file('a', 'one\n');
	draft.change(first, 'mine\n');

	const failing = draft.save();
	calls[0]?.fail(new Error('disk full'));
	await failing;
	expect(draft.saving).toBe(false);
	expect(draft.text).toBe('mine\n');
	expect(draft.base).toBe(first);

	const retry = draft.save();
	expect(calls[1]?.sent.base).toBe(first);
	calls[1]?.land(landed(file('b', 'mine\n')));
	await retry;
	expect(draft.text).toBeUndefined();
});

type Note = { title: string };
const note = (sha: string, title: string, body: string): StoredRow<Note> =>
	Object.freeze({
		path: 'notes/a.md',
		sha256: sha.repeat(64),
		text: `---\ntitle: ${title}\n---\n${body}`,
		row: { fields: { title }, body },
	});
type Change = { readonly from: Row<Note>; readonly to: Row<Note> };

test('a body editor sends the change from the row it started from to that row with the typed body', async () => {
	let cached: StoredRow<Note> | undefined = note('a', 'One', 'one\n');
	const { calls, save: write } = heldSaves<Change, unknown>();
	const body = createBodyEditor<Note>({ row: () => cached, write });

	expect(body.text).toBe('one\n');
	expect(body.typed).toBeUndefined();

	const started = cached;
	body.change('mine\r\n');
	// Another writer's title lands in the cache while the body is typed.
	cached = note('b', 'Renamed', 'one\n');
	expect(body.text).toBe('mine\r\n');

	const done = body.save();
	expect(calls[0]?.sent).toEqual({
		from: started.row,
		to: { fields: { title: 'One' }, body: 'mine\n' },
	});
	calls[0]?.land(undefined);
	await done;
	cached = note('c', 'Renamed', 'mine\n');

	expect(body.typed).toBeUndefined();
	expect(body.text).toBe('mine\n');
});

test('typing during a save makes the next save start from what that one sent', async () => {
	const cached = note('a', 'One', 'one\n');
	const { calls, save: write } = heldSaves<Change, unknown>();
	const body = createBodyEditor<Note>({ row: () => cached, write });
	body.change('one\nX\n');
	const done = body.save();
	body.change("one\nX'\n");
	calls[0]?.land(undefined);
	await Promise.resolve();
	await Promise.resolve();
	expect(calls[1]?.sent).toEqual({
		from: { fields: { title: 'One' }, body: 'one\nX\n' },
		to: { fields: { title: 'One' }, body: "one\nX'\n" },
	});
	calls[1]?.land(undefined);
	await done;
	expect(body.typed).toBeUndefined();
});

test('a failed body save keeps what is typed, and nothing is saved while the row is gone', async () => {
	let cached: StoredRow<Note> | undefined = note('a', 'One', 'one\n');
	const { calls, save: write } = heldSaves<Change, unknown>();
	const body = createBodyEditor<Note>({ row: () => cached, write });
	body.change('mine\n');
	const failing = body.save();
	calls[0]?.fail(new Error('disk full'));
	await failing;
	expect(body.saving).toBe(false);
	expect(body.typed).toBe('mine\n');

	cached = undefined;
	await body.save();
	expect(calls).toHaveLength(1);
	expect(body.typed).toBe('mine\n');
	expect(body.saving).toBe(false);
});

test('a body editor takes no change while there is no row', () => {
	const body = createBodyEditor<Note>({
		row: () => undefined,
		write: heldSaves<Change, unknown>().save,
	});
	body.change('typed\n');
	expect(body.text).toBeUndefined();
	expect(body.typed).toBeUndefined();
});

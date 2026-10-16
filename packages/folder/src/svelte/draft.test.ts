/**
 * Text Draft State Tests
 *
 * `createTextDraftState` and `createBodyDraftState` are a text draft read
 * reactively, with the one save loop every document editor needs
 * (ADR-0548, ADR-0554).
 *
 * Key behaviors:
 * - A component re-reads the draft's text on each change
 * - Text typed while a save runs is sent next, from the version it wrote
 * - A failed save keeps the draft, and the next save sends it again
 * - `restore` sends theirs back through the same save, heard like any save;
 *   a body's restore sends the body with theirs
 * - A body editor shows the file's body until something is typed, sends the
 *   text typed with the row it started from, and shows the file again once
 *   its save lands with nothing typed since
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import type { CapturedFile } from '../capture.js';
import type { SaveTextVariables } from '../draft.js';
import type { SavedFile } from '../save-file.js';
import type { SavedRow, StoredRow } from '../table.js';

const { flushSync } = await import('svelte');
const { createBodyDraftState, createBodyEditor, createTextDraftState } =
	await import('./draft.svelte.js');
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
	replaced: [],
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
	const heard: SavedFile[] = [];
	const draft = createTextDraftState({
		save,
		onSaved: (saved) => heard.push(saved),
	});
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
	expect(heard.map((saved) => saved.stored)).toEqual([written, last]);
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

test("a body's restore sends the body with theirs back through the same save, heard like any save", async () => {
	type Note = { title: string };
	const row = (sha: string, body: string): StoredRow<Note> =>
		Object.freeze({
			path: 'notes/a.md',
			sha256: sha.repeat(64),
			text: `---\ntitle: One\n---\n${body}`,
			row: { fields: { title: 'One' }, body },
		});
	const { calls, save } = heldSaves<
		{ base: StoredRow<Note>; content: string },
		SavedRow<Note>
	>();
	const heard: { saved: SavedRow<Note>; restore: () => void }[] = [];
	const draft = createBodyDraftState<Note>({
		save,
		onSaved: (saved, restore) => heard.push({ saved, restore }),
	});
	draft.change(row('a', 'one\n'), 'mine\n');
	const done = draft.save();
	const written = row('b', 'mine\n');
	calls[0]?.land({
		stored: written,
		merged: true,
		replaced: [
			{
				kind: 'text',
				part: 'body',
				kept: 'mine\n',
				theirs: 'theirs\n',
				regions: [],
			},
		],
	});
	await done;

	heard[0]?.restore();
	expect(calls[1]?.sent).toEqual({ base: written, content: 'theirs\n' });
	const restored = row('c', 'theirs\n');
	calls[1]?.land({ stored: restored, merged: false, replaced: [] });
	await Bun.sleep(0);
	expect(heard.map(({ saved }) => saved.stored)).toEqual([written, restored]);
});

test('a body editor sends the text typed with the row it started from', async () => {
	type Note = { title: string };
	const row = (sha: string, title: string, body: string): StoredRow<Note> =>
		Object.freeze({
			path: 'notes/a.md',
			sha256: sha.repeat(64),
			text: `---\ntitle: ${title}\n---\n${body}`,
			row: { fields: { title }, body },
		});
	let cached: StoredRow<Note> | undefined = row('a', 'One', 'one\n');
	const { calls, save } = heldSaves<
		{ base: StoredRow<Note>; text: string },
		SavedRow<Note>
	>();
	const body = createBodyEditor<Note>({ row: () => cached, save });

	expect(body.text).toBe('one\n');
	expect(body.typed).toBeUndefined();

	const started = cached;
	body.change('mine\n');
	// Another writer's title lands in the cache while the body is typed.
	cached = row('b', 'Renamed', 'one\n');
	expect(body.text).toBe('mine\n');

	const done = body.save();
	expect(calls[0]?.sent).toEqual({ base: started, text: 'mine\n' });
	const written = row('c', 'Renamed', 'mine\n');
	calls[0]?.land({ stored: written, merged: true, replaced: [] });
	await done;
	cached = written;

	expect(body.typed).toBeUndefined();
	expect(body.text).toBe('mine\n');
});

test('a body editor takes no change while there is no row', () => {
	type Note = { title: string };
	const body = createBodyEditor<Note>({
		row: () => undefined,
		save: heldSaves<
			{ base: StoredRow<Note>; text: string },
			SavedRow<Note>
		>().save,
	});
	body.change('typed\n');
	expect(body.text).toBeUndefined();
	expect(body.typed).toBeUndefined();
});

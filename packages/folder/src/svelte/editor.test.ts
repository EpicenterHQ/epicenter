/**
 * Text Editor Tests
 *
 * `createTextEditor` opens one document's text for a control, holding
 * `from` and `typed` with the one save loop every editor needs, over the
 * folder's one write (ADR-0576). A file's exact text is its plain case, and
 * `createBodyEditor` its row case. `createTextDraftState` is the earlier
 * draft of a file's text, until its callers move.
 *
 * Key behaviors:
 * - A component re-reads the typed text on each change
 * - A file's text is sent as the change from the text at the first change;
 *   text typed while a save runs is sent next, from what that save sent
 * - A failed save keeps what is typed, from the same text
 * - A save that finds the file deleted keeps what is typed, marked gone
 * - Over a real folder, another writer's lines merged between two saves
 *   stay, and text typed after the first save appears once
 * - A draft's text typed while a save runs is sent next, from the version
 *   it wrote, and a failed save keeps the draft
 * - A body editor shows the file's body until something is typed, sends the
 *   change from the row it started from to that row with the typed body,
 *   and shows the file again once its save lands with nothing typed since
 * - Typing during a save makes the next save start from what that one sent
 * - A failed save keeps what is typed; nothing is saved while the row is
 *   gone, and a save that finds it deleted keeps the text, marked gone
 * - Over a real table, an agent's lines merged in between two saves stay,
 *   and text typed after the first save appears once
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import type { CapturedFile } from '../capture.js';
import { defineFolder, defineTable, field } from '../contract.js';
import type { SaveTextVariables } from '../draft.js';
import type { Row } from '../row-text.js';
import type { SavedFile } from '../save-file.js';
import { writeFile } from '../save-file.js';
import { createTable, isStoredRow, type StoredRow } from '../table.js';

const { flushSync } = await import('svelte');
const { createBodyEditor, createTextDraftState, createTextEditor } =
	await import('./editor.svelte.js');
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

type TextSent = { readonly from: string; readonly to: string };
type Landed = 'landed' | 'gone';

test("a component re-reads the editor's typed text on each change", () => {
	const text = createTextEditor({
		current: () => 'one\n',
		write: heldSaves<TextSent, Landed>().save,
	});
	const typed = track(() => text.typed);
	flushSync();

	text.change('mine\n');
	flushSync();
	text.discard();
	flushSync();

	expect(typed.seen).toEqual([undefined, 'mine\n', undefined]);
	typed.stop();
});

test('a file text is sent from the text at the first change, and text typed during a save is sent next from what it sent', async () => {
	let cached = 'one\n';
	const { calls, save: write } = heldSaves<TextSent, Landed>();
	const text = createTextEditor({ current: () => cached, write });
	expect(text.text).toBe('one\n');

	await text.save();
	expect(calls).toHaveLength(0);

	text.change('ONE\n');
	// Another writer's change lands in the cache; the edit keeps its start.
	cached = 'one\ntheirs\n';
	const done = text.save();
	expect(text.saving).toBe(true);
	text.change('ONE\ntwo\n');
	// A second call joins the running loop.
	expect(text.save()).toBe(done);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.sent).toEqual({ from: 'one\n', to: 'ONE\n' });

	calls[0]?.land('landed');
	await Bun.sleep(0);
	expect(calls).toHaveLength(2);
	expect(calls[1]?.sent).toEqual({ from: 'ONE\n', to: 'ONE\ntwo\n' });

	calls[1]?.land('landed');
	await done;
	cached = 'ONE\ntheirs\ntwo\n';
	expect(text.saving).toBe(false);
	expect(text.typed).toBeUndefined();
	expect(text.text).toBe('ONE\ntheirs\ntwo\n');
});

test('a failed file save keeps what is typed, and the next save sends it again from the same text', async () => {
	const { calls, save: write } = heldSaves<TextSent, Landed>();
	const text = createTextEditor({ current: () => 'one\n', write });
	text.change('mine\n');

	const failing = text.save();
	calls[0]?.fail(new Error('disk full'));
	await failing;
	expect(text.saving).toBe(false);
	expect(text.typed).toBe('mine\n');

	const retry = text.save();
	expect(calls[1]?.sent).toEqual({ from: 'one\n', to: 'mine\n' });
	calls[1]?.land('landed');
	await retry;
	expect(text.typed).toBeUndefined();
});

test('a file save that finds the file deleted keeps what is typed and marks it gone', async () => {
	let cached: string | undefined = 'one\n';
	const { calls, save: write } = heldSaves<TextSent, Landed>();
	const text = createTextEditor({ current: () => cached, write });
	text.change('mine\n');
	const saving = text.save();
	calls[0]?.land('gone');
	await saving;
	expect(text.typed).toBe('mine\n');
	expect(text.gone).toBe(true);
	await text.save();
	expect(calls).toHaveLength(1);
	text.discard();
	expect(text.gone).toBe(false);
	// The cache saying the file is gone marks typed text gone too.
	text.change('again\n');
	cached = undefined;
	expect(text.gone).toBe(true);
	expect(text.text).toBe('again\n');
});

test("another writer's lines merged between two file saves stay, and typing after a save appears once", async () => {
	const { boundary } = await rawBrowserFolder({ id: 'editor.file' });
	const kind = { kind: 'file' } as const;
	const read = async () =>
		new TextDecoder().decode(
			(await boundary.read('notes.txt')).data?.bytes ?? new Uint8Array(),
		);
	await writeFile(boundary, kind, 'notes.txt', null, 'Hello\n');
	let cached = await read();
	const text = createTextEditor({
		current: () => cached,
		write: async ({ from, to }) => {
			const { data, error } = await writeFile(
				boundary,
				kind,
				'notes.txt',
				from,
				to,
			);
			if (error !== null) throw error;
			cached = await read();
			return data.file === null ? 'gone' : 'landed';
		},
	});

	text.change('Hello\nthere\n');
	const saving = text.save();
	text.change('Hello\nthere, friend\n');
	await saving;
	// Another writer appends after the saves landed, before the cache
	// hears of it.
	await writeFile(boundary, kind, 'notes.txt', cached, `${cached}Agent note\n`);
	text.change('Hello\nthere, friend!\n');
	await text.save();

	expect(await read()).toBe('Hello\nthere, friend!\nAgent note\n');
	expect(text.typed).toBeUndefined();
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
	const { calls, save: write } = heldSaves<Change, StoredRow<Note> | null>();
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
	calls[0]?.land(cached ?? null);
	await done;
	cached = note('c', 'Renamed', 'mine\n');

	expect(body.typed).toBeUndefined();
	expect(body.text).toBe('mine\n');
});

test('typing during a save makes the next save start from what that one sent', async () => {
	const cached = note('a', 'One', 'one\n');
	const { calls, save: write } = heldSaves<Change, StoredRow<Note> | null>();
	const body = createBodyEditor<Note>({ row: () => cached, write });
	body.change('one\nX\n');
	const done = body.save();
	body.change("one\nX'\n");
	calls[0]?.land(cached ?? null);
	await Bun.sleep(0);
	expect(calls[1]?.sent).toEqual({
		from: { fields: { title: 'One' }, body: 'one\nX\n' },
		to: { fields: { title: 'One' }, body: "one\nX'\n" },
	});
	calls[1]?.land(cached);
	await done;
	expect(body.typed).toBeUndefined();
});

test('a failed body save keeps what is typed, and nothing is saved while the row is gone', async () => {
	let cached: StoredRow<Note> | undefined = note('a', 'One', 'one\n');
	const { calls, save: write } = heldSaves<Change, StoredRow<Note> | null>();
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
		write: heldSaves<Change, StoredRow<Note> | null>().save,
	});
	body.change('typed\n');
	expect(body.text).toBeUndefined();
	expect(body.typed).toBeUndefined();
});

test("an agent's lines merged into the body stay, and typing after a save appears once", async () => {
	const definition = defineFolder({
		kv: {},
		tables: { notes: defineTable({ fields: { title: field.string() } }) },
	});
	const { boundary } = await rawBrowserFolder({ id: 'draft.agent' });
	const notes = createTable<Note>(
		{ storage: boundary },
		'notes',
		definition.tables.notes,
	);
	await notes.create(
		{ fields: { title: 'One' }, body: 'Hello\n' },
		{ stem: 'a' },
	);
	let cached = (await notes.get('a')).data as StoredRow<Note>;
	const body = createBodyEditor<Note>({
		row: () => cached,
		write: async ({ from, to }) => {
			const { data, error } = await notes.write('a', from, to);
			if (error !== null) throw error;
			if (isStoredRow(data)) cached = data;
			return data;
		},
	});

	body.change('Hello\nthere\n');
	const saving = body.save();
	// Keep typing while the first save runs, then an agent's line lands.
	body.change('Hello\nthere, friend\n');
	await saving;
	const agent = (await notes.get('a')).data as StoredRow<Note>;
	await notes.write('a', agent.row, {
		...agent.row,
		body: `${agent.row.body}Agent note\n`,
	});
	body.change('Hello\nthere, friend!\n');
	await body.save();

	expect((await notes.get('a')).data?.row.body).toBe(
		'Hello\nthere, friend!\nAgent note\n',
	);
	expect(body.typed).toBeUndefined();

	// With \`from\` left at the first keystroke, the typed line is a second
	// insertion beside the one the first save already wrote.
	await notes.write('a', (await notes.get('a')).data!.row, {
		fields: { title: 'One' },
		body: 'Hello\nthere\nAgent note\n',
	});
	await notes.write(
		'a',
		{ fields: { title: 'One' }, body: 'Hello\n' },
		{ fields: { title: 'One' }, body: 'Hello\nthere, friend\n' },
	);
	expect((await notes.get('a')).data?.row.body).toBe(
		'Hello\nthere\nAgent note\nthere, friend\n',
	);
});

test('a save that finds the row deleted keeps what is typed and marks it gone', async () => {
	const cached = note('a', 'One', 'one\n');
	const { calls, save: write } = heldSaves<Change, StoredRow<Note> | null>();
	const body = createBodyEditor<Note>({ row: () => cached, write });
	body.change('mine\n');
	expect(body.gone).toBe(false);
	const saving = body.save();
	calls[0]?.land(null);
	await saving;
	expect(body.typed).toBe('mine\n');
	expect(body.gone).toBe(true);
	await body.save();
	expect(calls).toHaveLength(1);
	body.discard();
	expect(body.gone).toBe(false);
});

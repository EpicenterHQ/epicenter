/**
 * Text Draft Tests
 *
 * A text draft is one edit of a document's text that holds its own starting
 * version (ADR-0548, ADR-0554).
 *
 * Key behaviors:
 * - The base is captured at the first change only; later changes, and a
 *   refetch that put a newer version in the cache, leave it alone
 * - A save that landed with no change since ends the draft; text typed while
 *   it ran continues from the version it wrote, and after a merged save is
 *   merged onto the written text by line, so the other writer's lines stay
 * - A row's body drafts the same way, reading the body the save wrote
 */
import { expect, test } from 'bun:test';
import { createTextDraft, writtenBody, writtenFile } from './draft.js';
import type { StoredRow } from './table.js';

const file = (sha: string, text: string) =>
	Object.freeze({
		path: 'notes.txt',
		sha256: sha.repeat(64),
		bytes: new TextEncoder().encode(text),
	});

test('the base is captured at the first change only', () => {
	const draft = createTextDraft();
	expect(draft.base).toBeUndefined();
	const first = file('a', 'one\n');
	draft.change(first, 'ONE\n');
	draft.change(file('b', 'theirs\n'), 'ONE\ntwo\n');
	expect(draft.base).toBe(first);
	expect(draft.text).toBe('ONE\ntwo\n');
});

test('a save with no change since ends the draft; one with typing since continues from the version it wrote', async () => {
	const draft = createTextDraft();
	const first = file('a', 'one\n');
	draft.change(first, 'ONE\n');
	const sent = draft.toSave()!;
	draft.change(first, 'ONE\ntwo\n');
	const written = file('b', 'ONE\n');
	await draft.saved(
		sent,
		writtenFile({ stored: written, merged: false, replaced: [] }),
	);
	expect(draft.base).toBe(written);
	expect(draft.text).toBe('ONE\ntwo\n');

	const again = draft.toSave()!;
	await draft.saved(
		again,
		writtenFile({
			stored: file('c', again.content),
			merged: false,
			replaced: [],
		}),
	);
	expect(draft.text).toBeUndefined();
	expect(draft.base).toBeUndefined();
});

test('after a merged save, text typed since is carried onto the version written', async () => {
	const draft = createTextDraft();
	const first = file('a', 'one\ntwo\n');
	draft.change(first, 'ONE\ntwo\n');
	const sent = draft.toSave()!;
	expect(sent).toMatchObject({ base: first, content: 'ONE\ntwo\n' });
	draft.change(first, 'ONE\ntwo\nthree\n');
	// Another writer changed the second line; the save merged it in.
	const written = file('c', 'ONE\nTWO\n');
	await draft.saved(
		sent,
		writtenFile({ stored: written, merged: true, replaced: [] }),
	);
	expect(draft.base).toBe(written);
	expect(draft.text).toBe('ONE\nTWO\nthree\n');
});

test("a row's body drafts the same way, reading the body the save wrote", async () => {
	type Note = { title: string };
	const row = (sha: string, title: string, body: string): StoredRow<Note> =>
		Object.freeze({
			path: 'notes/a.md',
			sha256: sha.repeat(64),
			text: `---\ntitle: ${title}\n---\n${body}`,
			row: { fields: { title }, body },
		});
	const draft = createTextDraft<StoredRow<Note>>();
	const first = row('a', 'One', 'one\ntwo\n');
	draft.change(first, 'ONE\ntwo\n');
	const sent = draft.toSave()!;
	draft.change(first, 'ONE\ntwo\nthree\n');
	// Another writer changed the title and the second line.
	const written = row('b', 'Theirs', 'ONE\nTWO\n');
	await draft.saved(
		sent,
		writtenBody({ stored: written, merged: true, replaced: [] }),
	);
	expect(draft.base).toBe(written);
	expect(draft.text).toBe('ONE\nTWO\nthree\n');
});

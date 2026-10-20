/**
 * Editing Tests
 *
 * Drives the real library, its local folder context, and its cache against a
 * real directory opened as the native `Folder`, with a fixture capture
 * device and stubbed endpoints. A gate on the disk below the folder can hold
 * or fail the writes of a Markdown file, as a slow or refusing disk would. Views
 * are stood in for as they behave: a changed field or body is the row's
 * draft, and a changed text is a text draft, each saved as a change from
 * what it started from (ADR-0632).
 *
 * Key behaviors:
 * - A field typed is saved; the listing takes the saved row, and the audio
 *   link is untouched
 * - Notes typed while a save runs are saved next, from the row that save sent
 * - A read never touches typing: a change made elsewhere is read while the
 *   typing waits, and the typing's save merges with it
 * - A save that fails keeps the typing, says so, and saves on Try again;
 *   Discard lets it go and hands back what was typed
 * - A value the schema does not accept is saved as typed, and the row is
 *   named for repair: nothing typed is refused or lost
 * - A field another program added survives every edit
 * - Typing into a row deleted elsewhere brings the row back: an unseen
 *   deletion never erases an edit
 * - A row that is not valid is named for repair, edited as its text, and
 *   edited as fields once it reads; switching refuses while the edit being
 *   left did not save, either way
 * - A deletion saves the typing first, then removes the recording and its
 *   results, keeping its audio
 * - Close waits for a save being written
 */
import { closeTestLibrary, openTestLibrary } from './library.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { describeDeletion } from './deletion.js';
import {
	openText,
	recordingEditor,
	settle,
	transcriptEditor,
} from './edits.test-support.js';
import { readBytes } from './files.js';
import type { Library } from './library.svelte.js';

import {
	openGatedTestFolder,
	openTestServices,
	whisperingDirectory,
} from './services.test-support.js';

const opened: { library: Library; remove: () => Promise<void> }[] = [];

afterEach(async () => {
	for (const { library, remove } of opened.splice(0)) {
		await closeTestLibrary(library);
		await remove();
	}
});

/**
 * The native folder over `root`, behind a gate on the disk's every write or
 * removal of a Markdown file, whichever caller saves it, the folder's edit
 * owner included: `hold` keeps the next one waiting until released,
 * `failing` refuses the writes of one path before they reach the disk, and
 * `mdWrites` counts the writes that went through.
 */
function gated(root: string) {
	const control = {
		mdWrites: 0,
		hold: undefined as
			| { gate: PromiseWithResolvers<void>; held: PromiseWithResolvers<void> }
			| undefined,
		failing: undefined as string | undefined,
		failOnce: false,
	};
	const folder = openGatedTestFolder(root, async (path) => {
		if (!path.endsWith('.md')) return undefined;
		if (control.failing === path) {
			if (control.failOnce) control.failing = undefined;
			return new Error('the disk refused it');
		}
		const hold = control.hold;
		if (hold !== undefined) {
			control.hold = undefined;
			hold.held.resolve();
			await hold.gate.promise;
		}
		control.mdWrites++;
		return undefined;
	});
	return { folder, control };
}

/** The library over a fresh directory, behind a gate on Markdown saves. */
async function open() {
	const root = await whisperingDirectory('whispering-editing-');
	const { folder, control } = gated(root);
	const fixture = await openTestServices({ folder });
	const library = await openTestLibrary(fixture);
	opened.push({
		library,
		remove: async () => {
			await fixture.remove();
			await rm(join(root, '..'), { recursive: true, force: true });
		},
	});
	return {
		library,
		root,
		control,
		holdNextMarkdownWrite() {
			const held = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			control.hold = { gate, held };
			return { held: held.promise, release: () => gate.resolve() };
		},
		/** Every save of `path` fails before it reaches the disk, until called with none. */
		failWrites(path?: string) {
			control.failing = path;
			control.failOnce = false;
		},
		/** The next save of `path` fails before it reaches the disk. */
		failNextWrite(path: string) {
			control.failing = path;
			control.failOnce = true;
		},
	};
}

async function text(root: string, path: string) {
	return readFile(join(root, path), 'utf8').catch(() => undefined);
}

/** Another program writes the file over whatever is there. */
async function writeElsewhere(root: string, path: string, content: string) {
	await writeFile(join(root, path), content);
}

/** Another program deletes the file. */
async function deleteElsewhere(root: string, path: string) {
	await rm(join(root, path));
}

/** Record one recording; it is saved and opens. Answers its editor. */
async function record(library: Library) {
	await library.startRecording();
	await library.stopRecording();
	expect(library.recorderError).toBeUndefined();
	await settle(library);
	return recordingEditor(library);
}

/** Transcribe the selected recording; answers its transcript's editor. */
async function transcript(library: Library) {
	const [entry] = library.entries;
	if (entry === undefined) throw new Error('Expected a recording');
	await library.transcribe(entry);
	await settle(library);
	const [result] = library.resultsFor(entry.stem);
	if (result === undefined) throw new Error('Expected a transcript');
	return transcriptEditor(library, result.path);
}

/** The listed recording at `path`, as the table shows it. */
const listed = (library: Library, path: string) =>
	library.entries.find((entry) => entry.path === path);

const recordingText = (title: string, audioPath: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: ${audioPath}\n---\n`;

// ============================================================================
// Edits and saves
// ============================================================================

test('a field typed is saved; the listing takes the saved row, and the audio link is untouched', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;

	editor.edit((row) => {
		row.fields.title = 'Morning notes';
	});
	expect(library.isSaving(editor.path)).toBe(true);
	await settle(library);

	const written = await text(root, editor.path);
	expect(written).toContain('title: Morning notes');
	expect(written).toContain(`audioPath: ${audioPath}`);
	expect(listed(library, editor.path)?.row.fields.title).toBe('Morning notes');
	expect(library.isSaving(editor.path)).toBe(false);
	expect(library.unsaved).toBe(false);
	// The audio is exactly what was recorded.
	expect(
		expectOk(await readBytes(library.local.folder, audioPath)).length,
	).toBe(32044);
});

test('notes typed while a save runs are saved next, from the row that save sent', async () => {
	const { library, root, control, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.body = 'M\n';
	});
	await held;
	const before = control.mdWrites;
	for (const body of ['Mo\n', 'Mor\n', 'Morning\n', 'Morning notes\n'])
		editor.edit((row) => {
			row.body = body;
		});
	expect(editor.draft.body).toBe('Morning notes\n');

	release();
	await settle(library);
	// The held save, then one save of the newest notes.
	expect(control.mdWrites - before).toBe(2);
	expect(await text(root, editor.path)).toEndWith('---\nMorning notes\n');
	expect(library.isSaving(editor.path)).toBe(false);

	editor.edit((row) => {
		row.body = 'Morning notes, two\n';
	});
	await settle(library);
	expect(await text(root, editor.path)).toEndWith('---\nMorning notes, two\n');
});

test('a read never touches notes typed, and their save merges with the change it read', async () => {
	const { library, root, failNextWrite } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;
	// A save that fails keeps the notes unsaved, and says so.
	failNextWrite(editor.path);
	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(library);
	expect(library.isUnsaved(editor.path)).toBe(true);
	expect(library.unsaved).toBe(true);

	// Another program changes the title, and the folder is read again.
	await writeElsewhere(root, editor.path, recordingText('Theirs', audioPath));
	await settle(library);
	// The listing reads the file; the notes typed are untouched.
	expect(library.rowSource('recordings', editor.path)?.fields).toMatchObject({
		title: 'Theirs',
	});
	expect(editor.draft.body).toBe('Mine.\n');
	expect(editor.draft.fields.title).toBe('Theirs');

	// Try again saves the notes over the version they started from.
	await library.retry(editor.path);
	await settle(library);
	const written = await text(root, editor.path);
	expect(written).toContain('title: Theirs');
	expect(written).toEndWith('---\nMine.\n');
	expect(library.unsaved).toBe(false);
});

test('a field typed over a change made elsewhere sets its field and keeps theirs', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;
	await writeElsewhere(
		root,
		editor.path,
		`${recordingText('Theirs', audioPath)}Their notes.\n`,
	);

	editor.edit((row) => {
		row.fields.title = 'Mine';
	});
	await settle(library);
	const written = await text(root, editor.path);
	expect(written).toContain('title: Mine');
	expect(written).toEndWith('---\nTheir notes.\n');
	expect(library.saving).toBe(false);
});

test('a field another program added survives every edit of the row', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;
	await writeElsewhere(
		root,
		editor.path,
		recordingText('Theirs', audioPath).replace('---\n', '---\nspeaker: Ada\n'),
	);
	await settle(library);

	editor.edit((row) => {
		row.fields.title = 'Mine';
		row.body = 'Notes.\n';
	});
	await settle(library);

	const written = await text(root, editor.path);
	expect(written).toContain('speaker: Ada');
	expect(written).toContain('title: Mine');
	expect(written).toEndWith('Notes.\n');
});

test('a value the schema does not accept is saved as typed, and the row is named for repair', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	// Inputs commit only values the schema accepts; this bypasses them.
	editor.edit((row) => {
		(row.fields as { durationMs: unknown }).durationMs = 'long';
	});
	await settle(library);

	expect(await text(root, editor.path)).toContain('durationMs: long');
	expect(library.repairs.map((item) => item.path)).toEqual([editor.path]);
	expect(library.repairs[0]?.reason).toContain('durationMs');
	expect(library.showsText(editor.path)).toBe(true);
	expect(library.unsaved).toBe(false);
});

test('Discard lets go of typing that did not save, hands it back, and leaves the file as it was', async () => {
	const { library, root, failWrites } = await open();
	const editor = await record(library);
	const before = await text(root, editor.path);
	failWrites(editor.path);
	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(library);
	expect(library.isUnsaved(editor.path)).toBe(true);
	expect(library.local.getStatus().failures).toHaveLength(1);

	expect(library.discard(editor.path)).toBe('Mine.\n');

	expect(library.isUnsaved(editor.path)).toBe(false);
	expect(library.unsaved).toBe(false);
	expect(editor.draft.body).toBe('');
	failWrites();
	await settle(library);
	expect(await text(root, editor.path)).toBe(before);
});

test('discarded field input preserves removals, literal values and the body for copying', async () => {
	const { library, root, failWrites } = await open();
	const editor = await record(library);
	const before = await text(root, editor.path);
	const observed = library.rowSource('recordings', editor.path)!;
	const edit = library.local.folder.tables.recordings.edit(observed.id);
	failWrites(editor.path);
	expectOk(
		edit.change(observed, {
			fields: { title: '[remove field]', durationMs: undefined },
			body: 'Kept notes.\n',
		}),
	);
	await edit.save();

	expect(JSON.parse(library.discard(editor.path)!)).toEqual({
		set: { title: '[remove field]' },
		remove: ['durationMs'],
		body: 'Kept notes.\n',
	});
	expect(edit.pending).toBeUndefined();
	expect(await text(root, editor.path)).toBe(before);
	failWrites();
});

test('typing into a recording deleted elsewhere brings its row back: an unseen deletion never erases an edit', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	await deleteElsewhere(root, path);

	editor.edit((row) => {
		row.body = 'Typed after it was deleted.\n';
	});
	await settle(library);

	const written = await text(root, path);
	expect(written).toContain(`audioPath: ${audioPath}`);
	expect(written).toEndWith('Typed after it was deleted.\n');
	expect(listed(library, path)?.row.body).toBe('Typed after it was deleted.\n');
	expect(library.unsaved).toBe(false);
});

test('a recording deleted elsewhere with nothing typed stays deleted, and its audio stays', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;

	await deleteElsewhere(root, path);
	await settle(library);

	expect(library.entries).toEqual([]);
	expect(library.selection).toBeUndefined();
	expect(await text(root, path)).toBeUndefined();
	expect(
		expectOk(await readBytes(library.local.folder, audioPath)).length,
	).toBe(32044);
});

// ============================================================================
// Repair and Source
// ============================================================================

test('a row that is not valid is named for repair, is written as typed text, and reads as fields once repaired', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	const broken = `---\ntitle: Broken\naudioPath: ${audioPath}\n---\n`;
	await writeElsewhere(root, path, broken);
	await settle(library);

	expect(library.repairs.map((item) => item.path)).toEqual([path]);
	expect(library.showsText(path)).toBe(true);
	const source = await openText(library, path);
	expect(source.draft).toBe(broken);
	expect(await library.useForm(path)).toContain('does not read');

	source.input(recordingText('Repaired', audioPath));
	expect(source.draft).toBe(recordingText('Repaired', audioPath));
	await settle(library);
	expect(await text(root, path)).toBe(recordingText('Repaired', audioPath));
	expect(library.repairs).toEqual([]);
	expect(await library.useForm(path)).toBeUndefined();
	expect(library.showsText(path)).toBe(false);
	expect(recordingEditor(library).draft.fields.title).toBe('Repaired');
});

test('text typed over a file changed elsewhere merges with it, and the typing wins where both changed', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	expect(await library.editSource(path)).toBeUndefined();
	const source = await openText(library, path);
	await writeElsewhere(root, path, recordingText('Theirs', audioPath));

	source.input(recordingText('Mine', audioPath));
	await settle(library);
	const merged = (await text(root, path)) ?? '';
	expect(merged).toContain('title: Mine\n');
	expect(source.draft).toBe(merged);
});

test('Source edits a valid row as its exact text, after the fields it was typed in are saved', async () => {
	const { library, root, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.body = 'Typed in the fields.\n';
	});
	await held;
	const opening = library.editSource(path);
	release();
	expect(await opening).toBeUndefined();
	expect(library.showsText(path)).toBe(true);
	const source = await openText(library, path);
	expect(source.draft).toEndWith('---\nTyped in the fields.\n');

	source.input(source.draft.replace('Typed in the fields.', 'Typed as text.'));
	await settle(library);
	expect(await text(root, path)).toEndWith('---\nTyped as text.\n');
	expect(await library.useForm(path)).toBeUndefined();
	expect(recordingEditor(library).draft.body).toBe('Typed as text.\n');
});

test('switching between the fields and Source refuses while the edit being left did not save, either way', async () => {
	const { library, root, failWrites } = await open();
	const editor = await record(library);
	const { path } = editor;

	failWrites(path);
	editor.edit((row) => {
		row.body = 'Older body.\n';
	});
	await settle(library);
	expect(library.isUnsaved(path)).toBe(true);
	expect(await library.editSource(path)).toContain('did not save');
	expect(library.showsText(path)).toBe(false);
	expect(library.discard(path)).toBe('Older body.\n');
	expect(library.isUnsaved(path)).toBe(false);

	failWrites();
	expect(await library.editSource(path)).toBeUndefined();
	const source = await openText(library, path);
	failWrites(path);
	source.input(
		source.draft.replace(/\n---\n[\s\S]*$/, '\n---\nNewer source.\n'),
	);
	await settle(library);
	expect(library.isUnsaved(path)).toBe(true);
	expect(await library.useForm(path)).toContain('did not save');
	expect(library.showsText(path)).toBe(true);

	// Once it can save, the source lands, and no older edit overwrites it.
	failWrites();
	await library.retry(path);
	await settle(library);
	expect(await text(root, path)).toEndWith('---\nNewer source.\n');
	expect(await library.useForm(path)).toBeUndefined();
	expect(recordingEditor(library).draft.body).toBe('Newer source.\n');
});

test('a text save that fails is told with the text, Save again, and Discard', async () => {
	const { library, root, failNextWrite } = await open();
	const notices: Parameters<Parameters<Library['onWriteNotice']>[0]>[0][] = [];
	library.onWriteNotice((notice) => notices.push(notice));
	await writeFile(join(root, 'notes.md'), 'first\n');
	await settle(library);

	failNextWrite('notes.md');
	(await openText(library, 'notes.md')).input('second\n');
	await settle(library);

	expect(notices).toMatchObject([
		{ kind: 'failed', path: 'notes.md', unsaved: 'second\n' },
	]);
	expect(notices[0]?.retry?.()).toBe(true);
	await settle(library);
	expect(await text(root, 'notes.md')).toBe('second\n');
	expect(library.unsaved).toBe(false);
});

// ============================================================================
// Deleting
// ============================================================================

test('a deletion saves the typing first, then removes the recording and its results, keeping its audio', async () => {
	const { library, root, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	const result = await transcript(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Saved before the delete';
	});
	await held;
	const capturing = library.deletionFor(path);
	release();
	const deletion = expectOk(await capturing);
	expect(deletion).toMatchObject({
		kind: 'recording',
		title: 'Saved before the delete',
		audioPath,
		results: [result.path],
	});
	expect(describeDeletion(deletion).description).toContain(
		`Its audio ${audioPath} is not deleted`,
	);

	expect(await library.delete(deletion)).toBeUndefined();
	await settle(library);
	expect(await text(root, path)).toBeUndefined();
	expect(await text(root, result.path)).toBeUndefined();
	expect(
		expectOk(await readBytes(library.local.folder, audioPath)).length,
	).toBe(32044);
	expect(library.entries).toEqual([]);
	expect(library.selection).toBeUndefined();
});

test('a deletion removes the recording as it is when it runs, whatever changed since the person was asked', async () => {
	const { library, root } = await open();
	const editor = await record(library);
	const { path } = editor;
	const deletion = expectOk(await library.deletionFor(path));
	await writeElsewhere(
		root,
		path,
		recordingText('Changed', editor.draft.fields.audioPath),
	);

	expect(await library.delete(deletion)).toBeUndefined();
	await settle(library);
	expect(await text(root, path)).toBeUndefined();
	expect(library.entries).toEqual([]);
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for a save being written, and it lands before the folder closes', async () => {
	const { library, root, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Typed before closing';
	});
	await held;
	let closed = false;
	const closing = closeTestLibrary(library).then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	// Nothing new is taken once closing began.
	editor.edit((row) => {
		row.fields.title = 'Typed after closing began';
	});
	release();
	await closing;
	expect(closed).toBe(true);
	expect(await text(root, path)).toContain('title: Typed before closing');
});

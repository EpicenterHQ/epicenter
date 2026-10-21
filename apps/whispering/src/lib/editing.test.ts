/**
 * Editing Tests
 *
 * Drives the real whispering, its local folder context, and its cache against a
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
 *   edited as fields once it reads; switching keeps unsaved input and its
 *   recovery state in either view
 * - A deletion saves the typing first, then removes the recording and its
 *   results, keeping its audio
 * - Close waits for a save being written
 */
import type { WhisperingContext } from './folder.js';
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

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
import {
	openGatedTestFolder,
	openTestServices,
	whisperingDirectory,
} from './services.test-support.js';
import type { Whispering } from './whispering.svelte.js';

const opened: {
	whispering: Whispering;
	context: WhisperingContext;
	remove: () => Promise<void>;
}[] = [];

afterEach(async () => {
	for (const { whispering, context, remove } of opened.splice(0)) {
		await closeTestWhispering({ whispering, context });
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

/** Whispering over a fresh directory, behind a gate on Markdown saves. */
async function open() {
	const root = await whisperingDirectory('whispering-editing-');
	const { folder, control } = gated(root);
	const fixture = await openTestServices({ folder });
	const { whispering, context } = await openTestWhispering(fixture);
	opened.push({
		whispering,
		context,
		remove: async () => {
			await fixture.remove();
			await rm(join(root, '..'), { recursive: true, force: true });
		},
	});
	return {
		whispering,
		context,
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
async function record(whispering: Whispering, context: WhisperingContext) {
	await whispering.startRecording();
	await whispering.stopRecording();
	expect(whispering.recorderError).toBeUndefined();
	await settle(whispering, context);
	return recordingEditor(whispering);
}

/** Transcribe the selected recording; answers its transcript's editor. */
async function transcript(whispering: Whispering, context: WhisperingContext) {
	const [entry] = whispering.entries;
	if (entry === undefined) throw new Error('Expected a recording');
	await whispering.transcribe(entry);
	await settle(whispering, context);
	const [result] = whispering.resultsFor(entry.stem);
	if (result === undefined) throw new Error('Expected a transcript');
	return transcriptEditor(whispering, result.path);
}

/** The listed recording at `path`, as the table shows it. */
const listed = (whispering: Whispering, path: string) =>
	whispering.entries.find((entry) => entry.path === path);

const recordingText = (title: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\n---\n`;

// ============================================================================
// Edits and saves
// ============================================================================

test('a field typed is saved; the listing takes the saved row, and the audio link is untouched', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const audioPath = editor.path.replace(/\.md$/, '.wav');

	editor.edit((row) => {
		row.fields.title = 'Morning notes';
	});
	expect(whispering.isSaving(editor.path)).toBe(true);
	await settle(whispering, context);

	const written = await text(root, editor.path);
	expect(written).toContain('title: Morning notes');
	expect(written).not.toContain('audioPath:');
	expect(listed(whispering, editor.path)?.row.fields.title).toBe(
		'Morning notes',
	);
	expect(whispering.isSaving(editor.path)).toBe(false);
	expect(whispering.unsaved).toBe(false);
	// The audio is exactly what was recorded.
	expect(expectOk(await readBytes(context.folder, audioPath)).length).toBe(
		32044,
	);
});

test('notes typed while a save runs are saved next, from the row that save sent', async () => {
	const { context, whispering, root, control, holdNextMarkdownWrite } =
		await open();
	const editor = await record(whispering, context);
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
	await settle(whispering, context);
	// The held save, then one save of the newest notes.
	expect(control.mdWrites - before).toBe(2);
	expect(await text(root, editor.path)).toEndWith('---\nMorning notes\n');
	expect(whispering.isSaving(editor.path)).toBe(false);

	editor.edit((row) => {
		row.body = 'Morning notes, two\n';
	});
	await settle(whispering, context);
	expect(await text(root, editor.path)).toEndWith('---\nMorning notes, two\n');
});

test('a read never touches notes typed, and their save merges with the change it read', async () => {
	const { context, whispering, root, failNextWrite } = await open();
	const editor = await record(whispering, context);
	// A save that fails keeps the notes unsaved, and says so.
	failNextWrite(editor.path);
	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(whispering, context);
	expect(whispering.isUnsaved(editor.path)).toBe(true);
	expect(whispering.unsaved).toBe(true);

	// Another program changes the title, and the folder is read again.
	await writeElsewhere(root, editor.path, recordingText('Theirs'));
	await settle(whispering, context);
	// The listing reads the file; the notes typed are untouched.
	expect(editor.draft.body).toBe('Mine.\n');
	expect(editor.draft.fields.title).toBe('Theirs');

	// Try again saves the notes over the version they started from.
	await context.folder.files.edit(editor.path).save();
	await settle(whispering, context);
	const written = await text(root, editor.path);
	expect(written).toContain('title: Theirs');
	expect(written).toEndWith('---\nMine.\n');
	expect(whispering.unsaved).toBe(false);
});

test('a field typed over a change made elsewhere sets its field and keeps theirs', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	await writeElsewhere(
		root,
		editor.path,
		`${recordingText('Theirs')}Their notes.\n`,
	);

	editor.edit((row) => {
		row.fields.title = 'Mine';
	});
	await settle(whispering, context);
	const written = await text(root, editor.path);
	expect(written).toContain('title: Mine');
	expect(written).toEndWith('---\nTheir notes.\n');
	expect(whispering.saving).toBe(false);
});

test('a field another program added survives every edit of the row', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	await writeElsewhere(
		root,
		editor.path,
		recordingText('Theirs').replace('---\n', '---\nspeaker: Ada\n'),
	);
	await settle(whispering, context);

	editor.edit((row) => {
		row.fields.title = 'Mine';
		row.body = 'Notes.\n';
	});
	await settle(whispering, context);

	const written = await text(root, editor.path);
	expect(written).toContain('speaker: Ada');
	expect(written).toContain('title: Mine');
	expect(written).toEndWith('Notes.\n');
});

test('a value the schema does not accept is saved as typed, and the row is named for repair', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	// Inputs commit only values the schema accepts; this bypasses them.
	editor.edit((row) => {
		(row.fields as { durationMs: unknown }).durationMs = 'long';
	});
	await settle(whispering, context);

	expect(await text(root, editor.path)).toContain('durationMs: long');
	expect(whispering.repairs.map((item) => item.path)).toEqual([editor.path]);
	expect(whispering.repairs[0]?.reason).toContain('durationMs');
	expect(whispering.showsText(editor.path)).toBe(true);
	expect(whispering.unsaved).toBe(false);
});

test('Discard lets go of typing that did not save, hands it back, and leaves the file as it was', async () => {
	const { context, whispering, root, failWrites } = await open();
	const editor = await record(whispering, context);
	const before = await text(root, editor.path);
	failWrites(editor.path);
	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(whispering, context);
	expect(whispering.isUnsaved(editor.path)).toBe(true);
	expect(context.getStatus().failures).toHaveLength(1);

	expect(whispering.discard(editor.path)).toBe('Mine.\n');

	expect(whispering.isUnsaved(editor.path)).toBe(false);
	expect(whispering.unsaved).toBe(false);
	expect(editor.draft.body).toBe('');
	failWrites();
	await settle(whispering, context);
	expect(await text(root, editor.path)).toBe(before);
});

test('discarded field input preserves removals, literal values and the body for copying', async () => {
	const { context, whispering, root, failWrites } = await open();
	const editor = await record(whispering, context);
	const before = await text(root, editor.path);
	// The listing read answered the edit's document.
	const edit = whispering.edit('recordings', editor.path);
	failWrites(editor.path);
	expectOk(
		edit.change({
			fields: { title: '[remove field]', durationMs: undefined },
			body: 'Kept notes.\n',
		}),
	);
	await edit.save();

	expect(JSON.parse(whispering.discard(editor.path)!)).toEqual({
		set: { title: '[remove field]' },
		remove: ['durationMs'],
		body: 'Kept notes.\n',
	});
	expect(edit.pending).toBeUndefined();
	expect(await text(root, editor.path)).toBe(before);
	failWrites();
});

test('typing into a recording deleted elsewhere brings its row back: an unseen deletion never erases an edit', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const audioPath = editor.path.replace(/\.md$/, '.wav');
	await deleteElsewhere(root, path);

	editor.edit((row) => {
		row.body = 'Typed after it was deleted.\n';
	});
	await settle(whispering, context);

	const written = await text(root, path);
	expect(written).not.toContain('audioPath:');
	expect(written).toEndWith('Typed after it was deleted.\n');
	expect(listed(whispering, path)?.row.body).toBe(
		'Typed after it was deleted.\n',
	);
	expect(whispering.unsaved).toBe(false);
});

test('a recording deleted elsewhere with nothing typed stays deleted, and its audio stays', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const audioPath = editor.path.replace(/\.md$/, '.wav');

	await deleteElsewhere(root, path);
	await settle(whispering, context);

	expect(whispering.entries).toEqual([]);
	expect(whispering.selection).toBeUndefined();
	expect(await text(root, path)).toBeUndefined();
	expect(expectOk(await readBytes(context.folder, audioPath)).length).toBe(
		32044,
	);
});

// ============================================================================
// Repair and Source
// ============================================================================

test('a row that is not valid is named for repair, is written as typed text, and reads as fields once repaired', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const broken = '---\ntitle: Broken\n---\n';
	await writeElsewhere(root, path, broken);
	await settle(whispering, context);

	expect(whispering.repairs.map((item) => item.path)).toEqual([path]);
	expect(whispering.showsText(path)).toBe(true);
	const source = await openText(whispering, context, path);
	expect(source.draft).toBe(broken);
	expect(await whispering.useForm(path)).toContain('does not read');

	source.input(recordingText('Repaired'));
	expect(source.draft).toBe(recordingText('Repaired'));
	await settle(whispering, context);
	expect(await text(root, path)).toBe(recordingText('Repaired'));
	expect(whispering.repairs).toEqual([]);
	expect(await whispering.useForm(path)).toBeUndefined();
	expect(whispering.showsText(path)).toBe(false);
	expect(recordingEditor(whispering).draft.fields.title).toBe('Repaired');
});

test('text typed over a file changed elsewhere merges with it, and the typing wins where both changed', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	expect(await whispering.editSource(path)).toBeUndefined();
	const source = await openText(whispering, context, path);
	await writeElsewhere(root, path, recordingText('Theirs'));

	source.input(recordingText('Mine'));
	await settle(whispering, context);
	const merged = (await text(root, path)) ?? '';
	expect(merged).toContain('title: Mine\n');
	expect(source.draft).toBe(merged);
});

test('Source shows unsaved row input while its save is still running', async () => {
	const { context, whispering, root, holdNextMarkdownWrite } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.body = 'Typed in the fields.\n';
	});
	await held;
	expect(await whispering.editSource(path)).toBeUndefined();
	expect(whispering.edit(path).text).toEndWith('---\nTyped in the fields.\n');
	expect(whispering.edit(path).pending?.saving).toBe(true);
	release();
	expect(whispering.showsText(path)).toBe(true);
	const source = await openText(whispering, context, path);
	expect(source.draft).toEndWith('---\nTyped in the fields.\n');

	source.input(source.draft.replace('Typed in the fields.', 'Typed as text.'));
	await settle(whispering, context);
	expect(await text(root, path)).toEndWith('---\nTyped as text.\n');
	expect(await whispering.useForm(path)).toBeUndefined();
	expect(recordingEditor(whispering).draft.body).toBe('Typed as text.\n');
});

test('switching between fields and Source preserves failed input and recovery in either view', async () => {
	const { context, whispering, root, failWrites } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;

	failWrites(path);
	editor.edit((row) => {
		row.body = 'Older body.\n';
	});
	await settle(whispering, context);
	expect(whispering.isUnsaved(path)).toBe(true);
	expect(await whispering.editSource(path)).toBeUndefined();
	expect(whispering.showsText(path)).toBe(true);
	expect(whispering.edit(path).text).toEndWith('Older body.\n');
	expect(whispering.edit(path).pending?.error).toBeDefined();
	expect(whispering.discard(path)).toBe('Older body.\n');
	expect(whispering.isUnsaved(path)).toBe(false);

	failWrites();
	expect(await whispering.editSource(path)).toBeUndefined();
	const source = await openText(whispering, context, path);
	failWrites(path);
	source.input(
		source.draft.replace(/\n---\n[\s\S]*$/, '\n---\nNewer source.\n'),
	);
	await settle(whispering, context);
	expect(whispering.isUnsaved(path)).toBe(true);
	expect(await whispering.useForm(path)).toBeUndefined();
	expect(whispering.showsText(path)).toBe(false);
	expect(recordingEditor(whispering).draft.body).toBe('Newer source.\n');
	expect(whispering.isUnsaved(path)).toBe(true);

	// Once it can save, the source lands, and no older edit overwrites it.
	failWrites();
	await context.folder.files.edit(path).save();
	await settle(whispering, context);
	expect(await text(root, path)).toEndWith('---\nNewer source.\n');
	expect(await whispering.useForm(path)).toBeUndefined();
	expect(recordingEditor(whispering).draft.body).toBe('Newer source.\n');
});

test('a text save that fails is told with the text, Save again, and Discard', async () => {
	const { context, whispering, root, failNextWrite } = await open();
	const notices: Parameters<Parameters<Whispering['onWriteFailure']>[0]>[0][] =
		[];
	whispering.onWriteFailure((notice) => notices.push(notice));
	await writeFile(join(root, 'notes.md'), 'first\n');
	await settle(whispering, context);

	failNextWrite('notes.md');
	(await openText(whispering, context, 'notes.md')).input('second\n');
	await settle(whispering, context);

	expect(notices).toMatchObject([{ path: 'notes.md', unsaved: 'second\n' }]);
	expect(notices[0]?.save?.()).toBe(true);
	await settle(whispering, context);
	expect(await text(root, 'notes.md')).toBe('second\n');
	expect(whispering.unsaved).toBe(false);
});

// ============================================================================
// Deleting
// ============================================================================

test('a deletion saves the typing first, then removes the recording and its results, keeping its audio', async () => {
	const { context, whispering, root, holdNextMarkdownWrite } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const audioPath = editor.path.replace(/\.md$/, '.wav');
	const result = await transcript(whispering, context);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Saved before the delete';
	});
	await held;
	const capturing = whispering.deletionFor(path);
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

	expect(await whispering.delete(deletion)).toBeUndefined();
	await settle(whispering, context);
	expect(await text(root, path)).toBeUndefined();
	expect(await text(root, result.path)).toBeUndefined();
	expect(expectOk(await readBytes(context.folder, audioPath)).length).toBe(
		32044,
	);
	expect(whispering.entries).toEqual([]);
	expect(whispering.selection).toBeUndefined();
});

test('a deletion removes the recording as it is when it runs, whatever changed since the person was asked', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const deletion = expectOk(await whispering.deletionFor(path));
	await writeElsewhere(root, path, recordingText('Changed'));

	expect(await whispering.delete(deletion)).toBeUndefined();
	await settle(whispering, context);
	expect(await text(root, path)).toBeUndefined();
	expect(whispering.entries).toEqual([]);
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for a save being written, and it lands before the folder closes', async () => {
	const { context, whispering, root, holdNextMarkdownWrite } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Typed before closing';
	});
	await held;
	let closed = false;
	const closing = closeTestWhispering({ whispering, context }).then(() => {
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

/**
 * Editing Tests
 *
 * Drives the real whispering, its local folder context, and its cache against a
 * real directory opened as the native `Folder`, with a fixture capture
 * device and stubbed endpoints. A gate on the disk below the folder can hold
 * or fail the writes of a Markdown file, as a slow or refusing disk would. Views
 * are stood in for as they behave: a changed field or body is the row's
 * source. A save publishes that complete source.
 *
 * Key behaviors:
 * - A field typed is saved; the listing takes the saved row, and the audio
 *   link is untouched
 * - Each explicit save captures the current notes and publishes in order
 * - A read never publishes a write or discards accepted local input
 * - A save that fails keeps the typing, says so, and saves on Try again;
 *   Discard lets it go and hands back what was typed
 * - A value the schema does not accept is saved as typed, and the row is
 *   named for repair: nothing typed is refused or lost
 * - A field another program added survives every edit
 * - Acquired text stays available after deletion and typing can recreate it
 * - A row that is not valid is named for repair, edited as its text, and
 *   edited as fields once it reads; switching keeps unsaved input and its
 *   recovery state in either view
 * - Deletion runs after already admitted saves and removes the confirmed
 *   results, keeping its audio
 * - Close releases immediately while submitted saves keep their own outcomes
 */
import { type FileContent, SaveError } from '@epicenter/folder';
import {
	type FolderEngine,
	folderHandle,
} from '../../../../packages/folder/src/handle.js';
import { whisperingTables } from './definition.js';
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
	const refused = SaveError.StorageFailed({
		cause: new Error('the disk refused it'),
	});
	const control = {
		mdWrites: 0,
		hold: undefined as
			| { gate: PromiseWithResolvers<void>; held: PromiseWithResolvers<void> }
			| undefined,
		failing: undefined as string | undefined,
		failOnce: false,
	};
	const inner = openGatedTestFolder(root, async () => undefined);
	let activeWrites = 0;
	let closed = false;
	const write = async (path: string, content: FileContent) => {
		activeWrites++;
		try {
			if (!path.endsWith('.md')) return await inner.files.write(path, content);
			const hold = control.hold;
			if (hold !== undefined) {
				control.hold = undefined;
				hold.held.resolve();
				await hold.gate.promise;
			}
			if (control.failing === path) {
				if (control.failOnce) control.failing = undefined;
				return refused;
			}
			control.mdWrites++;
			return await inner.files.write(path, content);
		} finally {
			activeWrites--;
			if (closed && activeWrites === 0) inner.close();
		}
	};
	const engine: FolderEngine = {
		files: { ...inner.files, write },
		tables: inner.tables,
		subscribe: (listener) => inner.onChange(listener),
		close: () => {
			closed = true;
			if (activeWrites === 0) inner.close();
		},
	};
	const folder = folderHandle(engine, whisperingTables);
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
	return await recordingEditor(whispering, context);
}

/** Transcribe the selected recording; answers its transcript's editor. */
async function transcript(whispering: Whispering, context: WhisperingContext) {
	const [entry] = whispering.entries;
	if (entry === undefined) throw new Error('Expected a recording');
	await whispering.transcribe(entry);
	await settle(whispering, context);
	const [result] = whispering.resultsFor(entry.stem);
	if (result === undefined) throw new Error('Expected a transcript');
	return await transcriptEditor(whispering, context, result.path);
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

test('explicit saves of notes typed while a save runs publish each captured source in order', async () => {
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
	// The held publication and each of the four explicitly requested saves.
	expect(control.mdWrites - before).toBe(5);
	expect(await text(root, editor.path)).toEndWith('---\nMorning notes\n');
	expect(whispering.isSaving(editor.path)).toBe(false);

	editor.edit((row) => {
		row.body = 'Morning notes, two\n';
	});
	await settle(whispering, context);
	expect(await text(root, editor.path)).toEndWith('---\nMorning notes, two\n');
});

test('a read keeps accepted notes and a retry publishes that complete source', async () => {
	const { context, whispering, root, failNextWrite } = await open();
	const editor = await record(whispering, context);
	failNextWrite(editor.path);
	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(whispering, context);
	const edit = context.folder.files.document(editor.path);
	expect(edit.getSnapshot().isDirty).toBe(true);
	const held = edit.getSnapshot().text;
	await writeElsewhere(root, editor.path, recordingText('Theirs'));
	await edit.refresh();
	expect(edit.getSnapshot().text).toBe(held);
	expect(await text(root, editor.path)).toBe(recordingText('Theirs'));
	expectOk(await edit.save());
	expect(await text(root, editor.path)).toBe(held);
	expect(edit.getSnapshot().saveError).toBeUndefined();
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('a field typed after reading an outside change keeps its body', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	await writeElsewhere(
		root,
		editor.path,
		`${recordingText('Theirs')}Their notes.\n`,
	);
	expectOk(await context.folder.files.document(editor.path).refresh());

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
	expectOk(await context.folder.files.document(editor.path).refresh());
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

	expect(whispering.discard(editor.path)).toContain('Mine.\n');

	expect(whispering.isUnsaved(editor.path)).toBe(false);
	expect(whispering.unsaved).toBe(false);
	expect(whispering.document(editor.path).getSnapshot().isDirty).toBe(false);
	failWrites();
	await settle(whispering, context);
	expect(await text(root, editor.path)).toBe(before);
});

test('discarded field input preserves removals, literal values and the body for copying', async () => {
	const { context, whispering, root, failWrites } = await open();
	const editor = await record(whispering, context);
	const before = await text(root, editor.path);
	// The listing read answered the edit's document.
	const edit = whispering.document('recordings', editor.path);
	failWrites(editor.path);
	expectOk(
		edit.patch({
			fields: { title: '[remove field]', durationMs: undefined },
			body: 'Kept notes.\n',
		}),
	);
	await edit.save();

	const discarded = whispering.discard(editor.path)!;
	expect(discarded).toContain('title: "[remove field]"');
	expect(discarded).not.toContain('durationMs:');
	expect(discarded).toEndWith('Kept notes.\n');
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(await text(root, editor.path)).toBe(before);
	failWrites();
});

test('typing into a retained recording source recreates its deleted file', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	await deleteElsewhere(root, editor.path);
	const edit = context.folder.files.document(editor.path);
	await edit.refresh();
	expect(edit.getSnapshot().loadError?.name).toBe('Missing');
	expect(edit.getSnapshot().text).toBeDefined();
	editor.edit((row) => {
		row.body = 'Typed after deletion.\n';
	});
	await settle(whispering, context);
	expect(await text(root, editor.path)).toEndWith('Typed after deletion.\n');
	expect(edit.getSnapshot().isDirty).toBe(false);
});

test('a clean recording deleted elsewhere retains its selected source without recreating the file', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const audioPath = editor.path.replace(/\.md$/, '.wav');

	await deleteElsewhere(root, path);
	await settle(whispering, context);

	expect(whispering.entries).toEqual([]);
	expect(whispering.selection).toMatchObject({ kind: 'recording', path });
	expect(whispering.document(path).getSnapshot().text).toBeDefined();
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
	expectOk(await context.folder.files.document(path).refresh());
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
	expect((await recordingEditor(whispering, context)).draft.fields.title).toBe(
		'Repaired',
	);
});

test('text typed over an outside change is the next complete publication', async () => {
	const { context, whispering, root } = await open();
	const editor = await record(whispering, context);
	const source = await openText(whispering, context, editor.path);
	await writeElsewhere(root, editor.path, recordingText('Theirs'));
	source.input(recordingText('Mine'));
	await settle(whispering, context);
	expect(await text(root, editor.path)).toBe(recordingText('Mine'));
	expect(source.view.getSnapshot().isDirty).toBe(false);
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
	expect(whispering.document(path).getSnapshot().text).toEndWith(
		'---\nTyped in the fields.\n',
	);
	expect(whispering.document(path).getSnapshot().isSaving).toBe(true);
	release();
	expect(whispering.showsText(path)).toBe(true);
	const source = await openText(whispering, context, path);
	expect(source.draft).toEndWith('---\nTyped in the fields.\n');

	source.input(source.draft.replace('Typed in the fields.', 'Typed as text.'));
	await settle(whispering, context);
	expect(await text(root, path)).toEndWith('---\nTyped as text.\n');
	expect(await whispering.useForm(path)).toBeUndefined();
	expect((await recordingEditor(whispering, context)).draft.body).toBe(
		'Typed as text.\n',
	);
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
	expect(whispering.document(path).getSnapshot().text).toEndWith(
		'Older body.\n',
	);
	expect(whispering.document(path).getSnapshot().saveError).toBeDefined();
	expect(whispering.discard(path)).toContain('Older body.\n');
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
	expect((await recordingEditor(whispering, context)).draft.body).toBe(
		'Newer source.\n',
	);
	expect(whispering.isUnsaved(path)).toBe(true);

	// Once it can save, the source lands, and no older edit overwrites it.
	failWrites();
	await context.folder.files.document(path).save();
	await settle(whispering, context);
	expect(await text(root, path)).toEndWith('---\nNewer source.\n');
	expect(await whispering.useForm(path)).toBeUndefined();
	expect((await recordingEditor(whispering, context)).draft.body).toBe(
		'Newer source.\n',
	);
});

test('each failed publication is told once while text stays editor-owned', async () => {
	const { context, whispering, root, failWrites, holdNextMarkdownWrite } =
		await open();
	const notices: Parameters<Parameters<Whispering['onWriteFailure']>[0]>[0][] =
		[];
	whispering.onWriteFailure((notice) => notices.push(notice));
	await writeFile(join(root, 'notes.md'), 'first\n');
	await settle(whispering, context);
	const edit = context.folder.files.document('notes.md');
	expectOk(await edit.refresh());

	failWrites('notes.md');
	expectOk(edit.replace('\uFEFFsecond\r\n'));
	expect((await edit.save()).error).not.toBeNull();
	const [first] = context.folder.getStatus().failures;
	if (first === undefined) throw new Error('Expected a failed publication');
	expect(notices).toHaveLength(1);
	expect(notices[0]?.getText()).toBe('\uFEFFsecond\r\n');

	expectOk(edit.replace('\uFEFFnewer\r\n'));
	expect(context.folder.getStatus().failures[0]).toBe(first);
	expect(notices).toHaveLength(1);
	expect(notices[0]?.getText()).toBe('\uFEFFnewer\r\n');

	const { held, release } = holdNextMarkdownWrite();
	expect(notices[0]?.save?.()).toBe(true);
	await held;
	expect(context.folder.getStatus().failures).toEqual([]);
	expectOk(edit.replace('\uFEFFnewest\r\n'));
	expect(context.folder.getStatus().failures[0]).toBe(first);
	expect(notices).toHaveLength(1);
	release();
	await settle(whispering, context);
	const [second] = context.folder.getStatus().failures;
	if (second === undefined) throw new Error('Expected the retry failure');
	expect(second).not.toBe(first);
	expect(second.error).toBe(first.error);
	expect(notices).toHaveLength(2);
	expect(notices[1]?.getText()).toBe('\uFEFFnewest\r\n');

	failWrites();
	expectOk(await edit.save());
	expect(notices[1]?.getText()).toBeUndefined();
	expect(notices[1]?.save?.()).toBe(false);

	failWrites('notes.md');
	expectOk(edit.replace('discard me\r\n'));
	expect((await edit.save()).error).not.toBeNull();
	const discardedNotice = notices.at(-1);
	expect(discardedNotice?.getText()).toBe('discard me\r\n');
	expect(edit.discard()).toBe('discard me\r\n');
	expect(discardedNotice?.getText()).toBeUndefined();
	expect(discardedNotice?.save?.()).toBe(false);
	context.close();
	expect(discardedNotice?.save?.()).toBe(false);
});

test('a reentrant failure listener never announces one failure twice', async () => {
	const { context, whispering, root, failWrites } = await open();
	await writeFile(join(root, 'notes.md'), 'first\n');
	await settle(whispering, context);
	const notices: Parameters<Parameters<Whispering['onWriteFailure']>[0]>[0][] =
		[];
	whispering.onWriteFailure((notice) => {
		notices.push(notice);
		if (notices.length === 1) expect(notice.save?.()).toBe(true);
	});
	failWrites('notes.md');
	(await openText(whispering, context, 'notes.md')).input('second\n');
	await settle(whispering, context);
	expect(notices).toHaveLength(2);
	expect(new Set(notices.map((notice) => notice.error)).size).toBe(1);
});

// ============================================================================
// Deleting
// ============================================================================

test('deletion waits behind an admitted save and removes the confirmed recording and results', async () => {
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
		title: expect.any(String),
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

test('close releases immediately while an admitted editor save finishes', async () => {
	const { context, whispering, root, holdNextMarkdownWrite } = await open();
	const editor = await record(whispering, context);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Typed before closing';
	});
	await held;
	try {
		expect(closeTestWhispering({ whispering, context })).toBeUndefined();
		// Nothing new is taken once closing began.
		editor.edit((row) => {
			row.fields.title = 'Typed after closing began';
		});
	} finally {
		release();
	}
	for (let tries = 0; tries < 200 && context.folder.getStatus().saving; tries++)
		await Bun.sleep(5);
	expect(context.folder.getStatus().saving).toBe(false);
	expect(await text(root, path)).toContain('title: Typed before closing');
});

test('save indicators and failure recovery do not demand file contents', async () => {
	const { whispering, context } = await open();
	const path = 'unopened.txt';
	const edit = context.folder.files.document(path);
	expect(edit.getSnapshot().text).toBeUndefined();

	expect(whispering.isSaving(path)).toBe(false);
	expect(whispering.isUnsaved(path)).toBe(false);
	expect(
		context.getStatus().failures.some((failure) => failure.path === path),
	).toBe(false);
	await Bun.sleep(0);

	expect(edit.getSnapshot().text).toBeUndefined();
});

/**
 * Whispering Window Close Tests
 *
 * Product state over a real folder, run as a desktop window: the stand-in in
 * `tauri-window.test-support`, which runs the close listener as Tauri's
 * API does. Only accepted Folder work changes the close decision.
 *
 * Key behaviors:
 * - Text held by the Folder prompts; Cancel retains it
 * - An explicit save can finish, then the window closes without prompting
 * - A recording under way holds nothing in the page: the window goes, and
 *   destroying it finishes the recording silently. Epicenter warns about
 *   active capture only for application Quit (ADR-0663)
 * - A closed whispering no longer holds the window's close
 */
import {
	closeTestWhispering,
	createTestWhispering,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	desktop,
	nativeDialog,
	nativeWindow,
	requestClose,
	untilListening,
} from '../../../../packages/svelte/src/tauri-window.test-support.js';
import { openText, settle } from './edits.test-support.js';
import {
	openGatedTestFolder,
	openTestServices,
	whisperingDirectory,
} from './services.test-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	nativeWindow.reset();
});

/**
 * Product state in a desktop window over a fresh directory whose disk can refuse
 * a write or throw, below the folder, so the folder's own saves meet it.
 */
async function openWindow() {
	const root = await whisperingDirectory('whispering-window-');
	const control = { refuse: false, throwWrite: false };
	const folder = openGatedTestFolder(root, async () => {
		if (control.throwWrite) throw new Error('transport disconnected');
		return control.refuse ? new Error('the disk refused it') : undefined;
	});
	const fixture = await openTestServices({ folder });
	desktop(true);
	const { whispering, context } = await createTestWhispering(fixture);
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await fixture.remove();
		await rm(join(root, '..'), { recursive: true, force: true });
	});
	await context.guardWindowClose();
	await whispering.start();
	await untilListening();
	return { whispering, context, root, control };
}

/** Record one recording and open its file as text. */
async function recordAsText({
	whispering,
	context,
}: Awaited<ReturnType<typeof openWindow>>) {
	await whispering.startRecording();
	await whispering.stopRecording();
	await settle(whispering, context);
	const path = whispering.selectedPath;
	if (path === undefined) throw new Error('Expected a recording');
	expect(await whispering.editSource(path)).toBeUndefined();
	const text = await openText(whispering, context, path);
	return { path, text };
}

test('text held by the Folder prompts; Cancel retains it', async () => {
	const window = await openWindow();
	const { path, text } = await recordAsText(window);
	const typed = `${text.draft}Typed just before closing.\n`;
	text.view.replace(typed);

	await requestClose();

	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
	expect(text.view.getSnapshot().content?.text).toBe(typed);
	expect(text.view.getSnapshot().isDirty).toBe(true);
	await window.whispering.document(path).save();
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(typed);
});

test('a failed save keeps the window until another save attempt saves the text', async () => {
	const window = await openWindow();
	const { path, text } = await recordAsText(window);
	const before = text.draft;
	const typed = `${before}Typed but not saved.\n`;
	window.control.refuse = true;
	text.view.replace(typed);
	await window.whispering.document(path).save();

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeDialog.count).toBe(1);
	expect(text.view.getSnapshot().content?.text).toBe(typed);
	expect(text.view.getSnapshot().isDirty).toBe(true);
	expect(window.whispering.unsaved).toBe(true);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(before);

	window.control.refuse = false;
	await window.context.folder.files.document(path).save();
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(typed);
});

test('a thrown file write leaves a failed draft that can save again', async () => {
	const window = await openWindow();
	const { path, text } = await recordAsText(window);
	const typed = `${text.draft}Retained after throw.\n`;
	window.control.throwWrite = true;
	text.view.replace(typed);
	await window.whispering.document(path).save();
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(text.view.getSnapshot().content?.text).toBe(typed);
	expect(text.view.getSnapshot().isDirty).toBe(true);
	expect(window.whispering.unsaved).toBe(true);
	window.control.throwWrite = false;
	await window.context.folder.files.document(path).save();
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(typed);
});

test('a recording under way holds nothing: the window goes', async () => {
	const window = await openWindow();
	await window.whispering.startRecording();

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
});

test('unsubmitted connection settings do not prompt', async () => {
	const window = await openWindow();
	window.whispering.settings.transcription.model = 'new model';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(0);
});

test('a connection save before a Folder write does not prompt', async () => {
	const window = await openWindow();
	window.whispering.settings.transcription.model = 'saved before close';
	const saving = window.whispering.settings.transcription.save();
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(0);
	expect(await saving).toBeUndefined();
});

test('a closed whispering no longer holds the window’s close', async () => {
	const window = await openWindow();
	await closeTestWhispering(window);
	for (let tries = 0; tries < 100 && nativeWindow.listeners > 0; tries++)
		await Bun.sleep(5);
	expect(nativeWindow.listeners).toBe(0);
});

/**
 * Whispering Window Close Tests
 *
 * A session over a real folder, run as a desktop window: the stand-in in
 * `tauri-window.test-support`, which runs the close listener as Tauri's
 * API does. Text drafts wait their second; only the close sends them.
 *
 * Key behaviors:
 * - Text typed into a file is saved by the close, then the window goes
 * - A failed save of that text keeps the window and the text; once saving
 *   works, the next close saves and destroys
 * - A recording under way holds nothing: the window goes, and destroying it
 *   is what finishes the recording
 * - A closed session no longer holds the window's close
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import {
	desktop,
	nativeWindow,
	requestClose,
	untilListening,
} from '../../../../packages/svelte/src/tauri-window.test-support.js';
import { openText, settle } from './edits.test-support.js';
import type { Session } from './session.svelte.js';
import {
	deferred,
	openGatedTestFolder,
	openTestWorkspace,
	whisperingDirectory,
} from './workspace.test-support.js';

const { openSession } = await import('./session.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	nativeWindow.reset();
});

/**
 * A session in a desktop window over a fresh directory whose disk can refuse
 * a write or throw, below the folder, so the folder's own saves meet it.
 */
async function openWindow() {
	const root = await whisperingDirectory('whispering-window-');
	const control = { refuse: false, throwWrite: false };
	const folder = openGatedTestFolder(root, async () => {
		if (control.throwWrite) throw new Error('transport disconnected');
		return control.refuse ? new Error('the disk refused it') : undefined;
	});
	const fixture = await openTestWorkspace({ folder });
	desktop(true);
	const session: Session = expectOk(await openSession(fixture.open));
	cleanups.push(async () => {
		await session.close();
		await fixture.remove();
		await rm(join(root, '..'), { recursive: true, force: true });
	});
	await untilListening();
	return { session, library: session.library, root, control };
}

/** Record one recording and open its file as text. */
async function recordAsText({
	library,
}: Awaited<ReturnType<typeof openWindow>>) {
	await library.startRecording();
	await library.stopRecording();
	await settle(library);
	const path = library.selectedPath;
	if (path === undefined) throw new Error('Expected a recording');
	expect(await library.editSource(path)).toBeUndefined();
	const text = await openText(library, path);
	return { path, text };
}

test('text typed into a file is saved by the close, then the window goes', async () => {
	const window = await openWindow();
	const { path, text } = await recordAsText(window);
	const typed = `${text.draft}Typed just before closing.\n`;
	text.input(typed);

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(typed);
});

test('a failed save keeps the window and the text; the next close saves and destroys', async () => {
	const window = await openWindow();
	const { path, text } = await recordAsText(window);
	const before = text.draft;
	const typed = `${before}Typed but not saved.\n`;
	window.control.refuse = true;
	window.library.editText(text.view, typed);

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(window.library.editedText(path)).toBe(typed);
	expect(window.library.unsaved).toBe(true);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(before);

	window.control.refuse = false;
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(typed);
});

test('a thrown file write leaves a failed draft that can save on retry', async () => {
	const window = await openWindow();
	const { path, text } = await recordAsText(window);
	const typed = `${text.draft}Retained after throw.\n`;
	window.control.throwWrite = true;
	window.library.editText(text.view, typed);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.library.editedText(path)).toBe(typed);
	expect(window.library.unsaved).toBe(true);
	window.control.throwWrite = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(await readFile(join(window.root, path), 'utf8')).toBe(typed);
});

test('a recording under way holds nothing: the window goes', async () => {
	const window = await openWindow();
	await window.library.startRecording();

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
});

test('unsubmitted connection settings and pasted text keep the window', async () => {
	const window = await openWindow();
	const previous = window.session.settings.transcription.model;
	window.session.settings.transcription.model = 'new model';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.session.settings.transcription.model).toBe('new model');
	window.session.settings.transcription.model = previous;
	window.session.view.pastedText = 'Run this later';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.session.view.pastedText).toBe('Run this later');
	window.session.view.pastedText = '';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('an accepted connection save finishes before the window closes', async () => {
	const window = await openWindow();
	const waiting = deferred<void>();
	const set = window.session.workspace.connections.set;
	window.session.workspace.connections.set = async (...args) => {
		await waiting.promise;
		return set(...args);
	};
	window.session.settings.transcription.model = 'saved before close';
	const saving = window.session.settings.transcription.save();
	const closing = requestClose();
	await Bun.sleep(5);
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.session.settings.transcription.saving).toBe(true);
	waiting.resolve();
	expect(await saving).toBeUndefined();
	await closing;
	expect(nativeWindow.destroyed).toBe(1);
	expect(window.session.settings.transcription.saved?.model).toBe(
		'saved before close',
	);
});

test('the session waits for its close listener before becoming editable', async () => {
	const fixture = await openTestWorkspace();
	cleanups.push(async () => {
		await fixture.workspace.close();
		await fixture.remove();
	});
	const waiting = deferred<void>();
	nativeWindow.registration = waiting.promise;
	desktop(true);
	let opened = false;
	const opening = openSession(fixture.open).then((result) => {
		opened = true;
		return result;
	});
	await Bun.sleep(5);
	expect(opened).toBe(false);
	expect(nativeWindow.listeners).toBe(0);
	waiting.resolve();
	const session = expectOk(await opening);
	expect(nativeWindow.listeners).toBe(1);
	await session.close();
});

test('a failed close listener refuses the session and releases its workspace', async () => {
	const fixture = await openTestWorkspace();
	cleanups.push(fixture.remove);
	desktop(true);
	nativeWindow.refuseRegistration = true;
	await expect(openSession(fixture.open)).rejects.toThrow(
		'Close listener could not be installed',
	);
	expect(fixture.closes).toBe(1);
	expect(nativeWindow.listeners).toBe(0);
});

test('a closed session no longer holds the window’s close', async () => {
	const window = await openWindow();
	await window.session.close();
	for (let tries = 0; tries < 100 && nativeWindow.listeners > 0; tries++)
		await Bun.sleep(5);
	expect(nativeWindow.listeners).toBe(0);
});

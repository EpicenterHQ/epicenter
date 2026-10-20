/**
 * Whispering Window Close Tests
 *
 * Product state over a real folder, run as a desktop window: the stand-in in
 * `tauri-window.test-support`, which runs the close listener as Tauri's
 * API does. Text drafts wait their second; only the close sends them.
 *
 * Key behaviors:
 * - Text typed into a file is saved by the close, then the window goes
 * - A failed save of that text keeps the window and the text; once saving
 *   works, explicit retry saves and the next close destroys
 * - A recording under way holds nothing: the window goes, and destroying it
 *   is what finishes the recording
 * - A closed whispering no longer holds the window's close
 */
import {
	closeTestWhispering,
	openTestWhispering,
} from './library.test-support.js';

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
import type { Whispering } from './whispering.svelte.js';
import {
	deferred,
	openGatedTestFolder,
	openTestWorkspace,
	whisperingDirectory,
} from './workspace.test-support.js';

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
	const fixture = await openTestWorkspace({ folder });
	desktop(true);
	const whispering: Whispering = await openTestWhispering(fixture);
	cleanups.push(async () => {
		await closeTestWhispering(whispering);
		await fixture.remove();
		await rm(join(root, '..'), { recursive: true, force: true });
	});
	await untilListening();
	return { whispering, library: whispering.library, root, control };
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

test('a failed save keeps the window until explicit retry saves the text', async () => {
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
	expect(nativeWindow.destroyed).toBe(0);
	await window.library.retry(path);
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
	await window.library.retry(path);
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
	const previous = window.whispering.settings.transcription.model;
	window.whispering.settings.transcription.model = 'new model';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.whispering.settings.transcription.model).toBe('new model');
	window.whispering.settings.transcription.model = previous;
	window.whispering.view.pastedText = 'Run this later';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.whispering.view.pastedText).toBe('Run this later');
	window.whispering.view.pastedText = '';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('an accepted connection save finishes before the window closes', async () => {
	const window = await openWindow();
	const waiting = deferred<void>();
	const set = window.whispering.library.workspace.connections.set;
	window.whispering.library.workspace.connections.set = async (...args) => {
		await waiting.promise;
		return set(...args);
	};
	window.whispering.settings.transcription.model = 'saved before close';
	const saving = window.whispering.settings.transcription.save();
	const closing = requestClose();
	await Bun.sleep(5);
	expect(nativeWindow.destroyed).toBe(0);
	expect(window.whispering.settings.transcription.saving).toBe(true);
	waiting.resolve();
	expect(await saving).toBeUndefined();
	await closing;
	expect(nativeWindow.destroyed).toBe(1);
	expect(window.whispering.settings.transcription.saved?.model).toBe(
		'saved before close',
	);
});

test('a closed whispering no longer holds the window’s close', async () => {
	const window = await openWindow();
	await closeTestWhispering(window.whispering);
	for (let tries = 0; tries < 100 && nativeWindow.listeners > 0; tries++)
		await Bun.sleep(5);
	expect(nativeWindow.listeners).toBe(0);
});

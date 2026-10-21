/** Product startup and shutdown over real files, independent of component mounting. */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { SaveError } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { recordingEditor, settle } from './edits.test-support.js';
import type { WhisperingFolder } from './folder.js';
import {
	closeTestWhispering,
	createTestWhispering,
	openTestWhispering,
} from './library.test-support.js';
import type { WhisperingServices } from './platform/types.js';
import {
	deferred,
	eventually,
	openTestServices,
	replaceTables,
} from './services.test-support.js';

const { STOPPED } = await import('./library.svelte.js');

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
	change: (folder: WhisperingFolder) => WhisperingFolder = (f) => f,
) {
	const test = await openTestServices();
	cleanups.push(test.remove);
	const whispering = await createTestWhispering({
		...test,
		folder: change(test.folder),
	});
	cleanups.push(() => closeTestWhispering(whispering));
	return { test, whispering, library: whispering.library };
}

test('startup reads connections and maintains exclusions before any listing', async () => {
	let checked = false;
	const { test, whispering, library } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				async list() {
					expect(expectOk(await files.read('.gitignore'))).toBeDefined();
					checked = true;
					return files.list();
				},
			},
		);
	});
	await whispering.start();
	expect(checked).toBe(true);
	expect(library.connections?.transcription?.model).toBe('verification-model');
	expect(await readdir(test.root)).toEqual(['.gitignore']);
	expect(await Bun.file(`${test.root}/.gitignore`).text()).toBe(
		'*\n!*/\n!*.md\n!.gitignore\n',
	);
});

test('a refused exclusion write stays visible and files remain writable', async () => {
	const { test, whispering, library } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				write: (path, from, change) =>
					path === '.gitignore'
						? Promise.resolve(
								SaveError.StorageFailed({
									cause: new Error('ignore file is read-only'),
								}),
							)
						: files.write(path, from, change),
			},
		);
	});
	await whispering.start();
	expect(whispering.exclusionNotice).toContain('ignore file is read-only');
	expectOk(
		await library.local.folder.files.write('note.md', null, 'Still editable\n'),
	);
	expect(await readdir(test.root)).toEqual(['note.md']);
});

test('internal navigation is allowed; unload waits for a write, not recording or transcription', async () => {
	const answer =
		deferred<Awaited<ReturnType<WhisperingServices['transcribe']>>>();
	const test = await openTestServices({ transcribe: () => answer.promise });
	cleanups.push(test.remove);
	const whispering = await openTestWhispering(test);
	cleanups.push(() => closeTestWhispering(whispering));
	const { library } = whispering;
	expect(whispering.blocksNavigation({ willUnload: true })).toBe(false);
	await library.startRecording();
	expect(whispering.blocksNavigation({ willUnload: true })).toBe(false);
	await library.stopRecording();
	const transcribing = library.transcribe(library.entries[0]!);
	await eventually(
		() => library.resultsFor(library.entries[0]!.stem).length > 0,
	);
	expect(whispering.blocksNavigation({ willUnload: true })).toBe(false);
	answer.resolve(Ok({ text: 'a steady tone' }));
	await transcribing;
	recordingEditor(library).edit((row) => {
		row.fields.title = 'Typed just now';
	});
	expect(whispering.blocksNavigation({ willUnload: false })).toBe(false);
	expect(whispering.blocksNavigation({ willUnload: true })).toBe(true);
	await settle(library);
	expect(whispering.blocksNavigation({ willUnload: true })).toBe(false);
});

test('a first-read failure rejects with its own error and leaves the library stopped', async () => {
	const lost = new Error('the folder host went away');
	const { whispering, library } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				list: () => Promise.reject(lost),
			},
		);
	});
	await expect(whispering.start()).rejects.toBe(lost);
	expect(library.closing).toBe(true);
});

test('stop during exclusion maintenance waits for its save and starts no listings', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let listings = 0;
	const { test, whispering } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				list: () => {
					listings++;
					return files.list();
				},
				async write(...args) {
					begun.resolve();
					await gate.promise;
					return files.write(...args);
				},
			},
		);
	});
	const starting = whispering.start();
	const rejected = starting.catch((cause: unknown) => cause);
	await begun.promise;
	const stopping = closeTestWhispering(whispering);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(test.closes).toBe(0);
	gate.resolve();
	expect(await rejected).toMatchObject({
		message: expect.stringContaining('stopped'),
	});
	await stopping;
	expect(listings).toBe(0);
	expect(await readdir(test.root)).toEqual(['.gitignore']);
});

test('stop and folder close finish while the first listing is held and start rejects as stopped', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let listings = 0;
	let connections = 0;
	const { test, whispering, library } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				async list() {
					listings++;
					begun.resolve();
					await gate.promise;
					return files.list();
				},
			},
		);
	});
	const read = test.services.connections.read;
	test.services.connections.read = () => {
		connections++;
		return read();
	};
	const rejected = whispering.start().catch((cause: unknown) => cause);
	await begun.promise;
	await closeTestWhispering(whispering);
	expect(test.closes).toBe(1);
	gate.resolve();
	expect(await rejected).toMatchObject({ message: STOPPED });
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(library.closing).toBe(true);
	expect(connections).toBe(0);
	expect(listings).toBe(1);
	expect(await readdir(test.root)).toEqual(['.gitignore']);
});

test('folder close waits for recording recovery and starts no listings after stop', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let listings = 0;
	const { test, whispering } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				list() {
					listings++;
					return files.list();
				},
			},
		);
	});
	const recover = test.services.recoverRecordings;
	test.services.recoverRecordings = async () => {
		begun.resolve();
		await gate.promise;
		return recover();
	};
	const rejected = whispering.start().catch((cause: unknown) => cause);
	await begun.promise;
	const stopping = closeTestWhispering(whispering);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(test.closes).toBe(0);
	gate.resolve();
	await stopping;
	expect(await rejected).toMatchObject({ message: STOPPED });
	expect(test.closes).toBe(1);
	expect(listings).toBe(0);
});

test('an unexpected exclusion read rejection preserves its error', async () => {
	const lost = new Error('folder connection lost');
	const { test, whispering } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				read: () => Promise.reject(lost),
			},
		);
	});
	await expect(whispering.start()).rejects.toBe(lost);
	expect(await readdir(test.root)).toEqual([]);
});

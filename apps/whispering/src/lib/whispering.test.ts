/** Product startup and shutdown over real files, independent of component mounting. */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { SaveError } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { recordingEditor, settle } from './edits.test-support.js';
import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import {
	deferred,
	eventually,
	openTestServices,
	replaceTables,
} from './services.test-support.js';
import {
	closeTestWhispering,
	createTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

const { STOPPED } = await import('./whispering.svelte.js');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
	change: (folder: WhisperingFolder) => WhisperingFolder = (f) => f,
) {
	const test = await openTestServices();
	cleanups.push(test.remove);
	const { whispering, context } = await createTestWhispering({
		...test,
		folder: change(test.folder),
	});
	cleanups.push(() => closeTestWhispering({ whispering, context }));
	return { test, whispering, context };
}

test('startup reads connections and maintains exclusions before any listing', async () => {
	let checked = false;
	const { test, whispering } = await fixture((folder) => {
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
	expect(whispering.connections?.transcription?.model).toBe(
		'verification-model',
	);
	expect(await readdir(test.root)).toEqual(['.gitignore']);
	expect(await Bun.file(`${test.root}/.gitignore`).text()).toBe(
		'*\n!*/\n!*.md\n!.gitignore\n',
	);
});

test('a refused exclusion write stays visible and files remain writable', async () => {
	const { context, test, whispering } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				write: (path, change) =>
					path === '.gitignore'
						? Promise.resolve(
								SaveError.StorageFailed({
									cause: new Error('ignore file is read-only'),
								}),
							)
						: files.write(path, change),
			},
		);
	});
	await whispering.start();
	expect(whispering.exclusionNotice).toContain('ignore file is read-only');
	expectOk(await context.folder.files.write('note.md', 'Still editable\n'));
	expect(await readdir(test.root)).toEqual(['note.md']);
});

test('a first-read failure rejects with its own error and leaves Whispering stopped', async () => {
	const lost = new Error('the folder host went away');
	const { whispering } = await fixture((folder) => {
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
	expect(whispering.closing).toBe(true);
});

test('stop during exclusion maintenance waits for no workflow, rejects start as stopped, and starts no listings', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let listings = 0;
	const { context, test, whispering } = await fixture((folder) => {
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
	// The write is held above the Folder, so the Folder never admitted it.
	await closeTestWhispering({ whispering, context });
	expect(test.closes).toBe(1);
	gate.resolve();
	expect(await rejected).toMatchObject({ message: STOPPED });
	expect(listings).toBe(0);
});

test('stop and folder close finish while the first listing is held and start rejects as stopped', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let listings = 0;
	let connections = 0;
	const { context, test, whispering } = await fixture((folder) => {
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
	await closeTestWhispering({ whispering, context });
	expect(test.closes).toBe(1);
	gate.resolve();
	expect(await rejected).toMatchObject({ message: STOPPED });
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(whispering.closing).toBe(true);
	expect(connections).toBe(0);
	expect(listings).toBe(1);
	expect(await readdir(test.root)).toEqual(['.gitignore']);
});

test('folder close does not wait for recording recovery, and no listing starts after stop', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let listings = 0;
	const { context, test, whispering } = await fixture((folder) => {
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
	await closeTestWhispering({ whispering, context });
	expect(test.closes).toBe(1);
	gate.resolve();
	expect(await rejected).toMatchObject({ message: STOPPED });
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

test('concurrent and repeated starts share one initialization attempt', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let writes = 0;
	let recoveries = 0;
	const { test, whispering } = await fixture((folder) => {
		const files = folder.files;
		return replaceTables(
			folder,
			{},
			{
				...files,
				async write(...args) {
					if (args[0] === '.gitignore') {
						writes++;
						begun.resolve();
						await gate.promise;
					}
					return files.write(...args);
				},
			},
		);
	});
	const recover = test.services.recoverRecordings;
	test.services.recoverRecordings = () => {
		recoveries++;
		return recover();
	};
	const first = whispering.start();
	await begun.promise;
	expect(whispering.start()).toBe(first);
	gate.resolve();
	await first;
	expect(whispering.start()).toBe(first);
	expect(writes).toBe(1);
	expect(recoveries).toBe(1);
});

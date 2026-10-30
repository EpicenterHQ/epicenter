/** Product startup and shutdown over real files, independent of component mounting. */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { expectOk } from 'wellcrafted/testing';
import { SaveError } from '../../../../packages/folder/src/shared/errors.js';
import type { WhisperingFolder } from './folder.js';
import { deferred, openTestServices } from './services.test-support.js';
import {
	closeTestWhispering,
	createTestWhispering,
} from './whispering.test-support.js';

const { STOPPED } = await import('./whispering.svelte.js');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FileCalls = Partial<Pick<WhisperingFolder, 'read' | 'write'>>;

/** The test's folder with some file calls replaced; everything else reads through. */
function replacing(folder: WhisperingFolder, calls: FileCalls) {
	// SAFETY: the prototype answers every member the replacements leave out.
	const replaced = Object.create(folder) as WhisperingFolder;
	return Object.assign(replaced, calls);
}

async function fixture(
	change: (folder: WhisperingFolder) => FileCalls = () => ({}),
) {
	const test = await openTestServices();
	cleanups.push(test.remove);
	const folder = replacing(test.folder, change(test.folder));
	const { whispering } = await createTestWhispering({ ...test, folder });
	cleanups.push(() => closeTestWhispering({ whispering, folder }));
	return { test, whispering, folder };
}

test('startup maintains exclusions and reads connections', async () => {
	const { test, whispering } = await fixture();
	await whispering.start();
	expect(whispering.connections?.transcription?.model).toBe(
		'verification-model',
	);
	expect(await readdir(test.root)).toEqual(['.gitignore']);
	expect(await Bun.file(`${test.root}/.gitignore`).text()).toBe(
		'*\n!*/\n!*.md\n!.gitignore\n',
	);
});

test('a refused exclusion write stays visible and files remain writable', async () => {
	const { test, whispering } = await fixture((folder) => ({
		write: (path, data) =>
			path === '.gitignore'
				? Promise.resolve(
						SaveError.StorageFailed({
							cause: new Error('ignore file is read-only'),
						}),
					)
				: folder.write(path, data),
	}));
	await whispering.start();
	expect(whispering.exclusionNotice).toContain('ignore file is read-only');
	expectOk(await test.folder.write('note.md', 'Still editable\n'));
	expect(await readdir(test.root)).toEqual(['note.md']);
});

test('stop during exclusion maintenance waits for no workflow and rejects start as stopped', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let connections = 0;
	const { test, whispering, folder } = await fixture((inner) => ({
		async write(path, data) {
			begun.resolve();
			await gate.promise;
			return inner.write(path, data);
		},
	}));
	const read = test.services.connections.read;
	test.services.connections.read = () => {
		connections++;
		return read();
	};
	const rejected = whispering.start().catch((cause: unknown) => cause);
	await begun.promise;
	closeTestWhispering({ whispering, folder });
	expect(whispering.closing).toBe(true);
	gate.resolve();
	expect(await rejected).toMatchObject({ message: STOPPED });
	expect(connections).toBe(0);
});

test('stop does not wait for recording recovery, and reads no connections after it', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let connections = 0;
	const { test, whispering, folder } = await fixture();
	const recover = test.services.recoverRecordings;
	test.services.recoverRecordings = async () => {
		begun.resolve();
		await gate.promise;
		return recover();
	};
	const read = test.services.connections.read;
	test.services.connections.read = () => {
		connections++;
		return read();
	};
	const rejected = whispering.start().catch((cause: unknown) => cause);
	await begun.promise;
	closeTestWhispering({ whispering, folder });
	gate.resolve();
	expect(await rejected).toMatchObject({ message: STOPPED });
	expect(connections).toBe(0);
});

test('an unexpected exclusion read rejection preserves its error', async () => {
	const lost = new Error('folder connection lost');
	const { test, whispering } = await fixture(() => ({
		read: () => Promise.reject(lost),
	}));
	await expect(whispering.start()).rejects.toBe(lost);
	expect(whispering.closing).toBe(true);
	expect(await readdir(test.root)).toEqual([]);
});

test('concurrent and repeated starts share one initialization attempt', async () => {
	const begun = deferred<void>();
	const gate = deferred<void>();
	let writes = 0;
	let recoveries = 0;
	const { test, whispering } = await fixture((folder) => ({
		async write(path, data) {
			if (path === '.gitignore') {
				writes++;
				begun.resolve();
				await gate.promise;
			}
			return folder.write(path, data);
		},
	}));
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

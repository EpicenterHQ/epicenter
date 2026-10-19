/**
 * Storage Choice Tests
 *
 * `chooseStorage` decides, before anything opens, whether this page opens
 * the browser's local folder or the declared folder of the desktop build and
 * of an earlier browser build. These tests drive it over a stand-in for
 * `navigator.storage` that records how it was asked.
 *
 * Key behaviors:
 * - The desktop build opens its declared folder without looking at OPFS
 * - An existing `so.epicenter.todos` OPFS directory keeps the legacy folder
 * - A browser without it, or without OPFS at all, opens the local folder
 * - A check that fails opens neither, with the reason
 * - The check never asks for a directory to be created
 */
import { expect, test } from 'bun:test';
import { TODOS_FOLDER_ID } from './definition.js';
import { chooseStorage } from './storage-choice.js';

/** OPFS whose root answers `lookup` for every name, recording each request. */
function opfs(lookup: (name: string) => Promise<unknown>) {
	const asked: { name: string; options: unknown }[] = [];
	const storage = {
		getDirectory: async () => ({
			getDirectoryHandle: (name: string, options?: unknown) => {
				asked.push({ name, options });
				return lookup(name);
			},
		}),
	};
	return { storage, asked };
}

const notFound = () =>
	Promise.reject(
		new DOMException(
			'A requested file or directory could not be found',
			'NotFoundError',
		),
	);

test('the desktop build opens its declared folder without looking at OPFS', async () => {
	const { storage, asked } = opfs(notFound);
	expect(await chooseStorage({ installed: true, storage })).toEqual({
		storage: 'legacy',
	});
	expect(asked).toEqual([]);
});

test('an existing so.epicenter.todos directory keeps the legacy folder, asked for without create', async () => {
	const { storage, asked } = opfs(async () => ({ kind: 'directory' }));
	expect(await chooseStorage({ installed: false, storage })).toEqual({
		storage: 'legacy',
	});
	expect(asked).toEqual([{ name: TODOS_FOLDER_ID, options: undefined }]);
});

test('a browser without that directory opens the local folder', async () => {
	const { storage } = opfs(notFound);
	expect(await chooseStorage({ installed: false, storage })).toEqual({
		storage: 'local',
	});
});

test('a browser without OPFS opens the local folder', async () => {
	expect(await chooseStorage({ installed: false, storage: {} })).toEqual({
		storage: 'local',
	});
	expect(await chooseStorage({ installed: false, storage: undefined })).toEqual(
		{
			storage: 'local',
		},
	);
});

test('a check that fails opens neither folder and says why', async () => {
	const denied = opfs(() =>
		Promise.reject(new DOMException('Access denied', 'SecurityError')),
	);
	expect(
		await chooseStorage({ installed: false, storage: denied.storage }),
	).toEqual({
		storage: 'unknown',
		reason: 'Access denied',
	});

	const rootRefused = {
		getDirectory: () =>
			Promise.reject(new DOMException('Storage is blocked', 'SecurityError')),
	};
	expect(
		await chooseStorage({ installed: false, storage: rootRefused }),
	).toMatchObject({
		storage: 'unknown',
	});

	// A file where the directory would be is not proof that no todos exist.
	const file = opfs(() =>
		Promise.reject(new DOMException('Not a directory', 'TypeMismatchError')),
	);
	expect(
		await chooseStorage({ installed: false, storage: file.storage }),
	).toMatchObject({
		storage: 'unknown',
	});
});

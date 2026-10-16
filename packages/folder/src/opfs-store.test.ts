/**
 * OPFS Replacement Tests
 *
 * What an OPFS replacement requires of its path when its bytes land, over
 * the in-memory OPFS (`opfs.test-support.ts`). The model follows what Chrome
 * 142 probes showed: a stream opens for a file removed since its handle was
 * taken, and writing and closing it creates the file again; an open stream
 * refuses the removal of its file and of any directory above it. These tests
 * show the store's protocol against that model, not that any browser,
 * including other Chrome versions, behaves that way.
 *
 * Key behaviors:
 * - A file removed after its handle was taken, before its stream opened, is
 *   not created again: the replacement is `stale`
 * - A replacement never creates a directory on the way to its path, and does
 *   not fill a directory another writer removed and made again
 * - Removing the file, or recursively a directory above it, while the
 *   replacement's stream is open is refused before anything is removed, and
 *   the replacement lands
 * - A new file is moved into place whole, and its scratch file is gone
 *
 * See also:
 * - `browser-opfs.test.ts` for the folder over the same store
 */
import { beforeEach, expect, test } from 'bun:test';
import { hashBytes } from './hash.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	presentFolder,
} from './opfs.test-support.js';
import { createOpfsStorage, type OpfsDirectoryHandle } from './opfs-store.js';
import { createWebLocks } from './web-locks.test-support.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let opfs: MemoryOpfs;
let root: OpfsDirectoryHandle;

beforeEach(async () => {
	opfs = memoryOpfs();
	root = await opfs.getDirectory();
	opfs.put('todos/x.md', encoder.encode('read'));
});

function storage() {
	return createOpfsStorage({
		folder: presentFolder(root),
		locks: createWebLocks(),
		filesLock: 'files',
	});
}

/** Replace `todos/x.md`, which holds `read`, with `text`. */
async function replace(text: string) {
	return storage().put(
		'todos/x.md',
		encoder.encode(text),
		await hashBytes(encoder.encode('read')),
	);
}

/** A removal by code that does not hold the folder's files lock. */
async function removeOutside(path: string, options?: { recursive?: boolean }) {
	const parts = path.split('/');
	let directory = await opfs.getDirectory();
	for (const part of parts.slice(0, -1))
		directory = await directory.getDirectoryHandle(part);
	await directory.removeEntry(parts.at(-1)!, options);
}

test('the model reproduces the hazard: a stream for a removed file creates it again', async () => {
	const directory = await root.getDirectoryHandle('todos');
	const handle = await directory.getFileHandle('x.md');
	await directory.removeEntry('x.md');

	const writable = await handle.createWritable({ keepExistingData: false });
	await writable.write(encoder.encode('back'));
	await writable.close();

	expect(decoder.decode(opfs.files().get('todos/x.md'))).toBe('back');
});

test('a file removed before the stream opens is not created again', async () => {
	opfs.faults.open = (path) => removeOutside(path);

	expect((await replace('mine')).data).toBe('stale');
	expect(opfs.files().has('todos/x.md')).toBe(false);
});

test('a replacement never creates a directory on the way to its path', async () => {
	opfs.faults.open = () => removeOutside('todos', { recursive: true });

	expect((await replace('mine')).data).toBe('stale');
	expect(opfs.files()).toEqual(new Map());
	expect(opfs.directories()).toEqual([]);
});

test('removing the file while the stream is open is refused, and the replacement lands', async () => {
	const directory = await root.getDirectoryHandle('todos');
	let removal: Promise<void> | undefined;
	opfs.faults.write = () => {
		removal = directory.removeEntry('x.md');
		return undefined;
	};

	expect((await replace('mine')).data).toBe('landed');
	expect(removal).toBeDefined();
	expect(
		await removal!.then(
			() => 'removed',
			(cause) => cause.name,
		),
	).toBe('NoModificationAllowedError');
	expect(decoder.decode(opfs.files().get('todos/x.md'))).toBe('mine');
	// The lock is released once the stream closes.
	await directory.removeEntry('x.md');
	expect(opfs.files().has('todos/x.md')).toBe(false);
});

test('removing a directory above the file while the stream is open is refused before anything goes', async () => {
	opfs.put('todos/other.md', encoder.encode('other'));
	let removal: Promise<void> | undefined;
	opfs.faults.write = () => {
		removal = root.removeEntry('todos', { recursive: true });
		return undefined;
	};

	expect((await replace('mine')).data).toBe('landed');
	expect(
		await removal!.then(
			() => 'removed',
			(cause) => cause.name,
		),
	).toBe('NoModificationAllowedError');
	expect(decoder.decode(opfs.files().get('todos/x.md'))).toBe('mine');
	expect(decoder.decode(opfs.files().get('todos/other.md'))).toBe('other');
	// Released with the stream.
	await root.removeEntry('todos', { recursive: true });
	expect(opfs.directories()).toEqual([]);
});

test('a directory removed and made again before the stream opens is not filled', async () => {
	opfs.faults.open = async () => {
		await removeOutside('todos', { recursive: true });
		await (await opfs.getDirectory()).getDirectoryHandle('todos', {
			create: true,
		});
	};

	expect((await replace('mine')).data).toBe('stale');
	expect(opfs.files()).toEqual(new Map());
	// The other writer's empty directory stays.
	expect(opfs.directories()).toEqual(['todos']);
});

test('a new file is moved into place whole, and its scratch file is gone', async () => {
	let during: Uint8Array | undefined | 'absent';
	opfs.faults.close = (path) => {
		// While the staged bytes close, nothing is at the new path yet.
		if (path.includes('.git/epicenter/scratch/'))
			during = opfs.files().get('todos/new.md') ?? 'absent';
		return undefined;
	};
	const put = await storage().put('todos/new.md', encoder.encode('new'), null);
	expect(put.data).toBe('landed');
	expect(during).toBe('absent');
	expect(decoder.decode(opfs.files().get('todos/new.md'))).toBe('new');
	expect(
		[...opfs.files().keys()].filter((path) => path.startsWith('.git/')),
	).toEqual([]);
});

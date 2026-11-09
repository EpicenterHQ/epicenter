/**
 * `@epicenter/folder/memory`: folders in memory, for a test. Under the
 * `test` condition `home()` is a new place in memory (`home.memory.ts`),
 * and a test reads and writes its folder through the folder's ordinary
 * methods. `memory()` is a new place in memory a test opens folders at
 * itself; every folder opened at one place shares its files and hears the
 * others' writes. What only something outside the folder does goes through
 * `memoryFiles`:
 *
 * ```ts
 * import { folder } from '$lib/app.js';
 * import { memoryFiles } from '@epicenter/folder/memory';
 *
 * await memoryFiles(folder).write('todos/a.md', '---\ntitle: [\n---\n'); // a file that does not read
 * const release = memoryFiles(folder).hold(); // the next writes wait
 * const undo = memoryFiles(folder).refuse('disk full', { under: 'todos' }); // the next writes there wait, and unavailable() says why
 *
 * const place = memory();
 * memoryFiles(place).refuseOpen(OpenFolderError.StorageUnavailable({ cause: 'no private storage' }).error);
 * const offline = openFolder(todos, place); // fails to open until the refusal is undone
 * ```
 */
import { type MemoryFiles, memoryStore } from './device/memory-store.js';
import { placeOf } from './open-folder.js';
import { type Place, place } from './place.js';

export type { MemoryFiles } from './device/memory-store.js';

/** Where a place in memory keeps its `outside`. */
const MEMORY_FILES = Symbol('epicenter.memoryFiles');

/** A new, empty place in memory: a folder opened at it opens a microtask from now. */
export function memory(): Place {
	const store = memoryStore();
	return Object.assign(
		place(() => ({ open: store.opened })),
		{ [MEMORY_FILES]: store.outside },
	);
}

/**
 * The world outside `target`: a place `memory()` made (the `test`
 * condition's `home()` included), or a folder opened at one, or `reactive`'s
 * copy of it. Throws for anything else.
 */
export function memoryFiles(target: object): MemoryFiles {
	const at = placeOf(target) ?? target;
	const files = (at as { [MEMORY_FILES]?: MemoryFiles })[MEMORY_FILES];
	if (files === undefined)
		throw new Error(
			'expected a place in memory, or a folder opened at one (the test condition’s home)',
		);
	return files;
}

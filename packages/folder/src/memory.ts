/**
 * `@epicenter/folder/memory`: the world outside a folder in memory, for a
 * test. Under the `test` condition `openFolder` opens a folder in memory
 * (`open-folder.memory.ts`), and a test reads and writes it through its
 * ordinary methods. What only something outside the folder does goes
 * through `memoryFiles(folder)`:
 *
 * ```ts
 * import { folder } from '$lib/app.js';
 * import { memoryFiles } from '@epicenter/folder/memory';
 *
 * await memoryFiles(folder).write('todos/a.md', '---\ntitle: [\n---\n'); // a file that does not read
 * const release = memoryFiles(folder).hold(); // the next writes wait
 * const undo = memoryFiles(folder).refuse('disk full'); // the next writes fail
 * ```
 */
import { MEMORY_FILES, type MemoryFiles } from './device/memory-store.js';

export type { MemoryFiles } from './device/memory-store.js';

/**
 * The world outside `folder`, a folder `openFolder` opened in memory under
 * the `test` condition, or `reactive`'s copy of it. Throws for any other
 * folder.
 */
export function memoryFiles(folder: object): MemoryFiles {
	const files = (folder as { [MEMORY_FILES]?: MemoryFiles })[MEMORY_FILES];
	if (files === undefined)
		throw new Error(
			'expected a folder openFolder opened in memory, under the test condition',
		);
	return files;
}

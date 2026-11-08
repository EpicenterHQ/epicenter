/**
 * The mounted tests' hold on the app's own folder (`$lib/app`), which the
 * `test` condition makes a folder in memory: the page state over its
 * captures, as `CaptureApp` makes it, the capture `one` as saved, and the
 * world outside the folder (`outside`, from `@epicenter/folder/memory`):
 * another program writing or deleting a file, which can be one that does
 * not read, and the disk making the folder's own writes wait.
 *
 * Import `svelte-dom.test-support.js` first: the folder and `reactive`
 * need Svelte's client runtime.
 */
import { memoryFiles } from '@epicenter/folder/memory';
import { expectOk } from 'wellcrafted/testing';

const { flushSync } = await import('svelte');
const { folder } = await import('../../app.js');
const { createCaptures } = await import(
	'../../captures.svelte.ts'
);
const { capturePath } = await import('../../model/index.js');

/** The capture every test writes. */
export const ONE = { id: 'one' };

/**
 * The world outside the folder: `write(path, text)` as another program
 * would, unchecked; `hold()` and `refuse(reason)` make the folder's own
 * writes wait. A test that holds or refuses undoes it in `finally`: `clear`
 * empties the folder with the folder's own writes, which either would stall.
 */
export const outside = memoryFiles(folder);

/**
 * Wait for `check`, flushing Svelte's effects between looks. The wait ends
 * before bun's 5 s per test, so one that runs out fails here, saying so.
 */
export async function until(
	check: () => boolean | Promise<boolean>,
	timeout = 4000,
) {
	const end = Date.now() + timeout;
	flushSync();
	while (!(await check())) {
		if (Date.now() > end) throw new Error('Timed out waiting');
		await Bun.sleep(5);
		flushSync();
	}
}

/** The capture `one` as saved now, or undefined when none reads. */
export async function saved() {
	const listed = expectOk(await folder.captures.list());
	return listed.items.find((note) => note.id === ONE.id);
}

/** The text of the capture `one`'s file, read or not, or null when there is none. */
export async function savedText() {
	return outside.read(capturePath(ONE.id));
}

/** Write the file of the capture `one` as `text`, as another program would. */
export const write = (text: string) => outside.write(capturePath(ONE.id), text);

/** Delete the file of the capture `one`, as another program would. */
export const remove = () => outside.write(capturePath(ONE.id), null);

/**
 * Delete every file at a capture's path, read or not, so each test starts
 * from an empty folder. The folder deletes them itself, so what it shows is
 * empty at once, whether or not a view still listens.
 */
export async function clear() {
	const listed = expectOk(await folder.captures.list());
	for (const note of [...listed.items, ...listed.invalid])
		await folder.captures.delete({ id: note.id });
}

/** A new page state over the folder's captures, as `CaptureApp` makes it. */
export const pageState = () => createCaptures(folder.captures);

export { folder };

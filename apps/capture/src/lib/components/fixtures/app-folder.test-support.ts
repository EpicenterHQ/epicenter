/**
 * The mounted tests' hold on the app's own folder (`$lib/app`), which the
 * `test` condition makes a folder in memory: the page state over its
 * captures, as `CaptureApp` makes it, and the capture `one` written, read
 * and changed through the folder's ordinary methods. A write made here and
 * not through a view is another writer's, as far as the views can tell.
 *
 * Import `svelte-dom.test-support.js` first: the folder and `reactive`
 * need Svelte's client runtime.
 */
import { expectOk } from 'wellcrafted/testing';

const { flushSync } = await import('svelte');
const { folder } = await import('../../app.js');
const { captureText, createCaptures } = await import(
	'../../captures.svelte.ts'
);

/** The capture every test writes. */
export const ONE = { id: 'one' };

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

/** The capture `one` as saved now, or undefined. */
async function saved() {
	const listed = expectOk(await folder.captures.list());
	return listed.items.find((note) => note.id === ONE.id);
}

/** The capture `one`'s text as saved, in house style, or null when there is none. */
export async function savedText() {
	const note = await saved();
	return note === undefined ? null : expectOk(captureText(note));
}

/** Write the capture `one` as `text`, in house style, over whatever is saved. */
export async function write(text: string) {
	const note = await saved();
	if (note === undefined) {
		const created = expectOk(
			await folder.captures.create({
				...ONE,
				capturedAt: new Date(0).toISOString(),
			}),
		);
		expectOk(
			await folder.captures.replace(ONE, text, { over: created.version }),
		);
		return;
	}
	expectOk(await folder.captures.replace(ONE, text, { over: note.version }));
}

/** Delete the capture `one` as saved. */
export async function remove() {
	const note = await saved();
	if (note !== undefined)
		expectOk(await folder.captures.delete(ONE, { over: note.version }));
}

/** Delete every capture, so each test starts from an empty folder. */
export async function clear() {
	const listed = expectOk(await folder.captures.list());
	for (const note of listed.items)
		expectOk(
			await folder.captures.delete({ id: note.id }, { over: note.version }),
		);
}

/** A new page state over the folder's captures, as `CaptureApp` makes it. */
export const pageState = () => createCaptures(folder.captures);

export { folder };

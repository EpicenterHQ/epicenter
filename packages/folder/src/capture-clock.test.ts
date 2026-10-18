/**
 * Capture Cache Under a Wall Clock Stepped Back
 *
 * A browser file has only its size and its time, and a wall clock stepped
 * back can give an edit the time a remembered file had. The stat cache
 * survives that two ways (`git/capture-cache.ts`): it forgets every path the
 * folder writes or hears another page write, and a listing that begins
 * before the latest listing that wrote the cache finds no cache.
 *
 * Key behaviors:
 * - A same-size save after the clock steps back is committed, whether the
 *   commit comes at once or after the clock passes where it was
 * - So is another page's save, heard over the change channel
 * - A write no page reported is committed while the clock is still behind
 *   the cache's latest listing
 *
 * See also:
 * - `git/capture-cache.test.ts` for the cache's own rules
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { commitTree, readBlob, readTreeFiles } from './git/objects.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from './opfs.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const definition = defineFolder({
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
const author = { name: 'Clock', email: 'clock@example.test' };
const decoder = new TextDecoder();
const T = 1_800_000_000_000;

const opened: Folder<typeof definition>[] = [];
afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	setSystemTime();
});

async function open(opfs: MemoryOpfs, hints = false) {
	const folder = expectOk(
		await openFolder({
			app: 'clock',
			definition,
			browser: {
				author,
				opfs: opfsEnvironment(opfs, {
					BroadcastChannel: hints ? BroadcastChannel : undefined,
				}),
			},
		}),
	);
	opened.push(folder);
	return folder;
}

/** What the branch head holds at `path`, read from Git itself. */
async function committed(opfs: MemoryOpfs, path: string) {
	const backend = await (
		await rawBrowserFolder({ id: 'clock', storage: { opfs } })
	).backend();
	const head = await backend.readBranch();
	if (head === undefined) return undefined;
	return backend.withObjects(async (access) => {
		const files = await readTreeFiles(access, await commitTree(access, head));
		const file = files.get(path);
		return file === undefined
			? undefined
			: decoder.decode(await readBlob(access, file.oid));
	});
}

/** A file committed once its time is old enough for the cache to vouch for. */
async function remembered(opfs: MemoryOpfs, folder: Folder<typeof definition>) {
	setSystemTime(T);
	expectOk(await folder.write('a.md', null, 'aaaa'));
	setSystemTime(T + 4000);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await committed(opfs, 'a.md')).toBe('aaaa');
}

test('a same-size save after the clock steps back is committed', async () => {
	const opfs = memoryOpfs();
	const folder = await open(opfs);
	await remembered(opfs, folder);
	setSystemTime(T);
	expectOk(await folder.write('a.md', 'aaaa', 'bbbb'));
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await committed(opfs, 'a.md')).toBe('bbbb');
});

test('the save is committed after the clock passes where it was', async () => {
	const opfs = memoryOpfs();
	const folder = await open(opfs);
	await remembered(opfs, folder);
	setSystemTime(T);
	expectOk(await folder.write('a.md', 'aaaa', 'bbbb'));
	// Past the cache's latest listing: only the save's own report tells.
	setSystemTime(T + 10_000);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await committed(opfs, 'a.md')).toBe('bbbb');
});

test("another page's save, heard over the change channel, is committed", async () => {
	const opfs = memoryOpfs();
	const folder = await open(opfs, true);
	const other = await open(opfs, true);
	await remembered(opfs, folder);
	setSystemTime(T);
	expectOk(await other.write('a.md', 'aaaa', 'bbbb'));
	// The channel delivers on a later turn.
	await Bun.sleep(20);
	setSystemTime(T + 10_000);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await committed(opfs, 'a.md')).toBe('bbbb');
});

test('a write nobody reported is committed while the clock is behind the cache', async () => {
	const opfs = memoryOpfs();
	const folder = await open(opfs);
	await remembered(opfs, folder);
	setSystemTime(T);
	opfs.put('clock/a.md', new TextEncoder().encode('bbbb'));
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await committed(opfs, 'a.md')).toBe('bbbb');
});

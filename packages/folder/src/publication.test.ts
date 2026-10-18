/**
 * A handle's save accounting.
 *
 * A write that landed, or whose put may have landed (its reply was lost),
 * makes the history's file observation stale. A write that changed nothing,
 * or failed before anything could land, leaves it fresh. Accounting asks for
 * no commit (ADR-0529) and tells no change listener: a handle's own saves are
 * not reported to it (ADR-0548).
 */
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import { defineFolder } from './contract.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from './opfs.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const definition = defineFolder({ tables: {} });
let opfs: MemoryOpfs;
const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

async function observed() {
	opfs = memoryOpfs();
	const folder = expectOk(
		await openFolder({
			app: 'publication',
			definition,
			browser: {
				author: { name: 'Saver', email: 'saver@example.test' },
				opfs: opfsEnvironment(opfs),
			},
		}),
	);
	opened.push(folder);
	expectOk(await folder.write('a.md', null, 'a'));
	const heard: unknown[] = [];
	folder.onFilesChanged((change) => heard.push(change));
	expectOk(await folder.git.status());
	const stale = () => {
		const { files } = folder.git.snapshot;
		return files.state === 'observed' && files.stale;
	};
	expect(stale()).toBe(false);
	return { folder, stale, heard };
}

test('a write that landed makes the observation stale and tells no listener', async () => {
	const { folder, stale, heard } = await observed();
	expectOk(await folder.write('a.md', 'a', 'b'));
	expect(stale()).toBe(true);
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	expect(heard).toEqual([]);
});

test('a put whose reply was lost makes the observation stale', async () => {
	const { folder, stale } = await observed();
	opfs.faults.close = (path) => (path.endsWith('/a.md') ? 'fail' : undefined);
	const failed = await folder.write('a.md', 'a', 'b');
	expect(failed.error?.name).toBe('Io');
	expect(stale()).toBe(true);
});

test('a write that changed nothing, or failed before anything landed, leaves it fresh', async () => {
	const { folder, stale } = await observed();
	expectOk(await folder.write('a.md', 'a', 'a'));
	opfs.faults.write = (path) => (path.endsWith('/a.md') ? 'fail' : undefined);
	expect((await folder.write('a.md', 'a', 'b')).error?.name).toBe('Io');
	expect(stale()).toBe(false);
});

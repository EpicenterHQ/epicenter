/**
 * Native folder observation over real filesystem events, without query timers.
 * External writes, atomic replacements and renamed directories emit path hints;
 * close releases observation and never attributes an OS event to publication.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import type { FolderChange } from '../folder.js';
import { openBunFolder } from './bun.js';
import { watchDirectory } from './watch.js';

const cleanup: Array<(() => Promise<unknown>) | (() => void)> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'folder-watch-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/a.md'), 'before');
	const folder = expectOk(await openBunFolder({ directory: root, tables: {} }));
	cleanup.push(() => folder.close());
	return { root, folder };
}

function nextChange(
	folder: Awaited<ReturnType<typeof fixture>>['folder'],
	path: string,
) {
	return new Promise<FolderChange>((resolve, reject) => {
		const timer = setTimeout(() => {
			stop();
			reject(new Error(`No filesystem observation of ${path}`));
		}, 5_000);
		const stop = folder.onChange((change) => {
			if (change.origin !== 'other-handle') return;
			if (
				change.paths !== null &&
				!change.paths.some(
					(hint) =>
						hint === path ||
						path.startsWith(`${hint}/`) ||
						hint.startsWith(`${path}/`),
				)
			)
				return;
			clearTimeout(timer);
			stop();
			resolve(change);
		});
	});
}

test('an external write and atomic replacement are observed without a query observer', async () => {
	const { root, folder } = await fixture();
	const changed = nextChange(folder, 'notes/a.md');
	await writeFile(join(root, 'notes/a.md'), 'external');
	expect((await changed).origin).toBe('other-handle');
	expect(
		await expectOk(await folder.files.read('notes/a.md'))?.content.text(),
	).toBe('external');
	// Stage outside the observed root, just as the native publisher does.
	const staged = `${root}-replacement`;
	cleanup.push(() => rm(staged, { force: true }));
	await writeFile(staged, 'replacement');
	const replaced = nextChange(folder, 'notes/a.md');
	await rename(staged, join(root, 'notes/a.md'));
	expect((await replaced).origin).toBe('other-handle');
	expect(
		await expectOk(await folder.files.read('notes/a.md'))?.content.text(),
	).toBe('replacement');
});

test('a directory rename reports the affected subtree and leaves other roots alone', async () => {
	const { root, folder } = await fixture();
	const other = await fixture();
	const unrelated: FolderChange[] = [];
	other.folder.onChange((change) => unrelated.push(change));
	const changed = nextChange(folder, 'notes/a.md');
	await rename(join(root, 'notes'), join(root, 'archive'));
	const notice = await changed;
	expect(
		notice.paths === null ||
			notice.paths.some(
				(path) => path === 'notes' || path.startsWith('notes/'),
			),
	).toBe(true);
	expect(unrelated).toEqual([]);
	expect(
		await expectOk(await folder.files.read('archive/a.md'))?.content.text(),
	).toBe('before');
});

test('closing a directory subscription suppresses even queued native callbacks', async () => {
	const { root } = await fixture();
	const notices: unknown[] = [];
	const stop = watchDirectory(root)((paths) => notices.push(paths));
	stop();
	await writeFile(join(root, 'notes/a.md'), 'after close');
	// A second live watch supplies a real event-loop/native delivery boundary.
	const boundary = new Promise<void>((resolve) => {
		const stopBoundary = watchDirectory(root)(() => {
			stopBoundary();
			resolve();
		});
		cleanup.push(stopBoundary);
	});
	await writeFile(join(root, 'boundary'), 'changed');
	await boundary;
	expect(notices).toEqual([]);
});

async function until(check: () => boolean) {
	const deadline = performance.now() + 5_000;
	while (!check()) {
		if (performance.now() > deadline)
			throw new Error('The editor did not observe the directory change');
		await Bun.sleep(10);
	}
}

test('directory events reconcile subscribed descendants while retaining text and never publishing', async () => {
	const { root, folder } = await fixture();
	const own: FolderChange[] = [];
	folder.onChange((change) => {
		if (change.origin === 'this-handle') own.push(change);
	});
	const edit = folder.files.document('notes/a.md');
	cleanup.push(edit.subscribe(() => {}));
	await until(() => edit.getSnapshot().content?.text === 'before');
	await writeFile(join(root, 'notes/a.md'), 'outside');
	await until(() => edit.getSnapshot().content?.text === 'outside');
	await rename(join(root, 'notes'), join(root, 'archive'));
	await until(() => edit.getSnapshot().loadError?.name === 'Missing');
	expect(edit.getSnapshot()).toMatchObject({
		content: { text: 'outside' },
		isDirty: false,
		isSaving: false,
	});
	const moved = folder.files.document('archive/a.md');
	const stop = moved.subscribe(() => {});
	await until(() => moved.getSnapshot().content?.text === 'outside');
	stop();
	const deleted = nextChange(folder, 'archive/a.md');
	await rm(join(root, 'archive'), { recursive: true });
	await deleted;
	// An inactive acquired editor keeps its source until a reader asks again.
	expect(moved.getSnapshot().content?.text).toBe('outside');
	cleanup.push(moved.subscribe(() => {}));
	await until(() => moved.getSnapshot().loadError?.name === 'Missing');
	expect(moved.getSnapshot()).toMatchObject({
		content: { text: 'outside' },
		isDirty: false,
		isSaving: false,
	});
	expect(own).toEqual([]);
});

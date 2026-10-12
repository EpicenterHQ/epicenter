/**
 * Working-copy editor regressions over a real browser folder and held OPFS writes.
 * Concurrent save waiters share writes, file switches wait for saves, and outside
 * changes cannot replace typed input or silently resolve a failed conditional save.
 * Two copies on one remote sync: a competing line waits for a modal review that
 * locks the editor, Cancel forgets it, and an applied choice reaches the remote.
 */
import { afterEach, expect, test } from 'bun:test';
import { compileModule } from 'svelte/compiler';
import { expectOk } from 'wellcrafted/testing';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from '../../../../packages/folder/src/git-http.test-support.js';
import { memoryOpfs } from '../../../../packages/folder/src/opfs.test-support.js';
import { createWebLocks } from '../../../../packages/folder/src/web-locks.test-support.js';

Bun.plugin({
	name: 'git-workspace-runes',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
				await Bun.file(path).text(),
			);
			return {
				contents: compileModule(source, { filename: path, generate: 'client' })
					.js.code,
				loader: 'js',
			};
		});
	},
});
const { openWorkingCopy } = await import('./workspace.svelte.ts');
const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	'navigator',
);
const originalHandle = Object.getOwnPropertyDescriptor(
	globalThis,
	'FileSystemFileHandle',
);
const opened: Awaited<ReturnType<typeof openWorkingCopy>>[] = [];

afterEach(async () => {
	for (const workspace of opened.splice(0)) {
		await workspace.useSavedText();
		await workspace.close();
	}
	if (originalNavigator)
		Object.defineProperty(globalThis, 'navigator', originalNavigator);
	else Reflect.deleteProperty(globalThis, 'navigator');
	if (originalHandle)
		Object.defineProperty(globalThis, 'FileSystemFileHandle', originalHandle);
	else Reflect.deleteProperty(globalThis, 'FileSystemFileHandle');
});

async function setup() {
	const opfs = memoryOpfs();
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			storage: { getDirectory: () => opfs.getDirectory() },
			locks: createWebLocks(),
		},
	});
	Object.defineProperty(globalThis, 'FileSystemFileHandle', {
		configurable: true,
		value: class {
			createWritable() {}
		},
	});
	const workspace = await openWorkingCopy('a', '');
	opened.push(workspace);
	expectOk(await workspace.folder.files.create('a.txt', 'original\n'));
	expectOk(await workspace.folder.files.create('b.txt', 'other\n'));
	await workspace.refresh();
	await workspace.select('a.txt');
	return { workspace, opfs };
}

function holdNextWrite(opfs: ReturnType<typeof memoryOpfs>) {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let writes = 0;
	opfs.faults.open = async (path) => {
		if (!path.endsWith('/a.txt')) return;
		writes++;
		if (writes === 1) {
			started.resolve();
			await released.promise;
		}
	};
	return {
		started: started.promise,
		release: released.resolve,
		get writes() {
			return writes;
		},
	};
}

test('concurrent flush waiters share the write of newer input', async () => {
	const { workspace, opfs } = await setup();
	const hold = holdNextWrite(opfs);
	workspace.input('one\n');
	const first = workspace.flush();
	await hold.started;
	workspace.input('two\n');
	const second = workspace.flush();
	hold.release();
	await Promise.all([first, second]);
	expect(hold.writes).toBe(2);
	expect(
		new TextDecoder().decode(
			expectOk(await workspace.folder.files.read('a.txt')).bytes,
		),
	).toBe('two\n');
	expect(workspace.buffer).toBe('two\n');
	expect(workspace.dirty).toBe(false);
});

test('switching files waits through the active save and newer input', async () => {
	const { workspace, opfs } = await setup();
	const hold = holdNextWrite(opfs);
	workspace.input('one\n');
	const first = workspace.flush();
	await hold.started;
	const selecting = workspace.select('b.txt');
	workspace.input('latest\n');
	hold.release();
	await Promise.all([first, selecting]);
	expect(
		new TextDecoder().decode(
			expectOk(await workspace.folder.files.read('a.txt')).bytes,
		),
	).toBe('latest\n');
	expect(workspace.selected).toBe('b.txt');
	expect(workspace.buffer).toBe('other\n');
});

test('outside changes preserve typed text and block switching until an explicit choice', async () => {
	const { workspace } = await setup();
	workspace.input('my unsaved text\n');
	expectOk(await workspace.folder.files.overwrite('a.txt', 'outside\n'));
	await workspace.refresh();
	expect(workspace.buffer).toBe('my unsaved text\n');
	await expect(workspace.select('b.txt')).rejects.toThrow();
	expect(workspace.selected).toBe('a.txt');
	expect(workspace.dirty).toBe(true);
	expect(workspace.saveMessage).toContain('captured SHA-256');
	expect(
		new TextDecoder().decode(
			expectOk(await workspace.folder.files.read('a.txt')).bytes,
		),
	).toBe('outside\n');
	await workspace.keepMyText();
	expect(
		new TextDecoder().decode(
			expectOk(await workspace.folder.files.read('a.txt')).bytes,
		),
	).toBe('my unsaved text\n');
	expect(workspace.dirty).toBe(false);
});

test('discarding failed input reloads the current saved text and clean deletion closes editing', async () => {
	const { workspace } = await setup();
	workspace.input('my text\n');
	const external = expectOk(
		await workspace.folder.files.overwrite('a.txt', 'outside\n'),
	);
	await expect(workspace.flush()).rejects.toThrow();
	await workspace.useSavedText();
	expect(workspace.buffer).toBe('outside\n');
	expect(workspace.dirty).toBe(false);
	expectOk(await workspace.folder.files.remove(external));
	await workspace.refresh();
	expect(workspace.editable).toBe(false);
	expect(workspace.saveMessage).toContain('No file');
});

test('switching during explicit replacement keeps its receipt on the original file', async () => {
	const { workspace, opfs } = await setup();
	workspace.input('my repair\n');
	expectOk(await workspace.folder.files.overwrite('a.txt', 'outside\n'));
	await expect(workspace.flush()).rejects.toThrow();
	const hold = holdNextWrite(opfs);
	const replacing = workspace.keepMyText();
	await hold.started;
	const selecting = workspace.select('b.txt');
	hold.release();
	await Promise.all([replacing, selecting]);
	expect(workspace.selected).toBe('b.txt');
	expect(workspace.buffer).toBe('other\n');
	workspace.input('edit b\n');
	await workspace.flush();
	expect(
		new TextDecoder().decode(
			expectOk(await workspace.folder.files.read('a.txt')).bytes,
		),
	).toBe('my repair\n');
	expect(
		new TextDecoder().decode(
			expectOk(await workspace.folder.files.read('b.txt')).bytes,
		),
	).toBe('edit b\n');
});

test('two copies sync; a competing line waits for a modal review that Cancel forgets', async () => {
	const { workspace: unused } = await setup();
	void unused;
	const root = await scratch('git-lab-sync-');
	const bare = await createBareRemote(root);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (await gitHttpFetch(root)) as typeof fetch;
	try {
		const remote = 'http://git.test/remote.git';
		const a = await openWorkingCopy('a', remote);
		opened.push(a);
		expectOk(await a.folder.files.create('notes/color.txt', 'color=blue\n'));
		await a.sync();
		const b = await openWorkingCopy('b', remote);
		opened.push(b);
		await b.sync();
		await b.select('notes/color.txt');
		expect(b.buffer).toBe('color=blue\n');

		await a.select('notes/color.txt');
		a.input('color=yellow\n');
		await a.sync();
		b.input('color=green\n');
		await b.sync();
		const attempt = b.syncAttempt;
		expect(
			attempt?.conflicts.map(({ kind, path }) => ({ kind, path })),
		).toEqual([{ kind: 'file', path: 'notes/color.txt' }]);
		expect(b.locked).toBe(true);
		b.input('typed during the review\n');
		expect(b.buffer).toBe('color=green\n');

		b.cancelSync();
		expect(b.syncAttempt).toBeUndefined();
		expect(b.locked).toBe(false);

		await b.sync();
		const again = b.syncAttempt;
		if (again === undefined) throw new Error('Expected a review');
		await b.applySync(again, {
			[again.conflicts[0]!.id]: { kind: 'take', side: 'local' },
		});
		expect(b.syncAttempt).toBeUndefined();
		expect(await git(bare, 'show', 'main:notes/color.txt')).toBe('color=green');
		expect(b.output).toContain('Synced');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

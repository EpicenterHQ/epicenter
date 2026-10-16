/**
 * Working-copy editor regressions over a real browser folder and held OPFS writes.
 * Concurrent save waiters share writes, file switches wait for saves, and another
 * page's change rereads a clean editor but never replaces typed input: the save
 * merges with it, and the typed text wins the lines both changed.
 * Two copies on one remote sync: a line both changed goes to the copy that
 * syncs, the merge commit names what lost, and the other copy receives it.
 */
import { afterEach, expect, test } from 'bun:test';
import { openDataFolder } from '@epicenter/folder';
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
const others: { close(): Promise<void> }[] = [];

afterEach(async () => {
	for (const workspace of opened.splice(0)) {
		await workspace.useSavedText();
		await workspace.close();
	}
	for (const folder of others.splice(0)) await folder.close();
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
	await workspace.select('a.txt');
	return { workspace, opfs };
}

/** Another page's handle on the same copy: its writes reach the workspace as change reports. */
async function elsewhere(workspace: (typeof opened)[number]) {
	const { location } = workspace.folder;
	if (location.kind !== 'opfs') throw new Error('Expected a browser copy');
	const opened = await openDataFolder({ id: location.directory });
	if (opened.error !== null) throw new Error(opened.error.message);
	others.push(opened.data);
	return opened.data;
}

async function until(check: () => boolean) {
	for (let waited = 0; !check(); waited += 5) {
		if (waited > 2000) throw new Error('Timed out waiting for a change report');
		await Bun.sleep(5);
	}
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

test('a copy keeps its own epicenter.json: saves and commits never write it, and reopening reads its tables', async () => {
	const { workspace } = await setup();
	// Hand-formatted, as no publication would write it.
	const declared =
		'{"kv":{"type":"object","properties":{}},"tables":{"notes":{"type":"object","properties":{"title":{"type":"string"}}}}}';
	const read = async (folder: typeof workspace.folder) =>
		new TextDecoder().decode(
			expectOk(await folder.files.read('epicenter.json')).bytes,
		);
	expectOk(await workspace.folder.files.create('epicenter.json', declared));
	workspace.input('edited\n');
	await workspace.flush();
	await workspace.commit();
	expect(workspace.snapshot.lastCommit?.status).toBe('committed');
	expect(await read(workspace.folder)).toBe(declared);
	// Opened before the declaration existed, this handle has no tables.
	expect(workspace.folder.definition.tables).toEqual({});

	await workspace.close();
	opened.splice(opened.indexOf(workspace), 1);
	const again = await openWorkingCopy('a', '');
	opened.push(again);
	expect(Object.keys(again.folder.definition.tables)).toEqual(['notes']);
	await again.select('a.txt');
	again.input('edited again\n');
	await again.flush();
	expect(await read(again.folder)).toBe(declared);
});

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

/** Save `content` at `path` of `folder` over whatever is there, without merging. */
async function put(
	folder: Awaited<ReturnType<typeof elsewhere>>,
	path: string,
	content: string,
) {
	const current = await folder.files.read(path);
	if (current.error?.name === 'NotFound')
		return expectOk(await folder.files.create(path, content));
	return expectOk(
		await folder.files.save(expectOk(current), content, { merge: false }),
	).stored;
}

const fileText = async (workspace: (typeof opened)[number], path: string) =>
	new TextDecoder().decode(
		expectOk(await workspace.folder.files.read(path)).bytes,
	);

test('a change from another page rereads a clean editor; typed text merges with it and wins the lines both changed', async () => {
	const { workspace } = await setup();
	const other = await elsewhere(workspace);
	await put(other, 'a.txt', 'first outside\n');
	await until(() => workspace.buffer === 'first outside\n');
	expect(workspace.dirty).toBe(false);

	workspace.input('my unsaved text\n');
	await put(other, 'a.txt', 'outside\n');
	expectOk(await other.files.create('c.txt', ''));
	await until(() =>
		workspace.listing.files.some((file) => file.path === 'c.txt'),
	);
	expect(workspace.buffer).toBe('my unsaved text\n');
	// Both changed the one line: the typed text stands.
	await workspace.flush();
	expect(workspace.dirty).toBe(false);
	expect(workspace.buffer).toBe('my unsaved text\n');
	expect(await fileText(workspace, 'a.txt')).toBe('my unsaved text\n');
});

test('a save of a file deleted elsewhere fails and keeps the text; discarding it closes editing', async () => {
	const { workspace } = await setup();
	workspace.input('my text\n');
	const other = await elsewhere(workspace);
	expectOk(await other.files.remove(expectOk(await other.files.read('a.txt'))));
	await expect(workspace.flush()).rejects.toThrow();
	expect(workspace.buffer).toBe('my text\n');
	expect(workspace.dirty).toBe(true);
	await workspace.useSavedText();
	expect(workspace.editable).toBe(false);
	expect(workspace.saveMessage).toContain('No file');
});

test('two copies sync; a line both changed goes to the copy that syncs, and the other receives it', async () => {
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
		expect(b.output).toContain('Synced');
		// B synced last: its line stands, and the merge names A's as lost.
		expect(await git(bare, 'show', 'main:notes/color.txt')).toBe('color=green');
		expect(await git(bare, 'log', '-1', '--format=%B', 'main')).toContain(
			'Overrode:',
		);
		await a.sync();
		expect(a.buffer).toBe('color=green\n');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

/**
 * Native Coherent Capture Tests
 *
 * A capture enumerates the folder and then reads each file. A batch from the
 * same boundary that lands between those two phases would be seen half done:
 * a renamed row is gone from its old path when it is read and was never
 * enumerated at its new one, so a checkpoint would commit a tree without it.
 * One boundary therefore runs a capture and its own batches one at a time.
 * This covers the boundary's own batches only; another program still races.
 *
 * Key behaviors:
 * - A rename through the same boundary does not start while a capture is
 *   between enumerating and reading, and the capture holds the old files
 * - A checkpoint that overlaps a table rename commits the files from before
 *   the rename, never an empty tree
 * - Reads do not wait behind a capture
 * - A capture that fails releases the batches and captures queued after it
 *
 * See also:
 * - `native-concurrency.test.ts` for batches ordered against each other
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FileChange } from './boundary.js';
import { defineFolder, defineTable, field } from './contract.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';

const real = { ...realFs };
const { mkdir, readdir, realpath, rm, writeFile } = real;

/** Runs before the next read of this absolute path, once, when set. */
let beforeRead: { path: string; run: () => Promise<void> } | undefined;
/** Makes the next enumeration of this absolute directory fail, once. */
let failList: string | undefined;

// The native store reads these bindings at call time, so the hooks observe
// the real capture without a production seam.
mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async open(...args: Parameters<typeof real.open>) {
		if (beforeRead !== undefined && String(args[0]) === beforeRead.path) {
			const { run } = beforeRead;
			beforeRead = undefined;
			await run();
		}
		return real.open(...args);
	},
	async readdir(...args: Parameters<typeof real.readdir>) {
		if (failList !== undefined && String(args[0]) === failList) {
			failList = undefined;
			throw Object.assign(new Error('enumeration refused'), { code: 'EIO' });
		}
		return (real.readdir as (...rest: unknown[]) => Promise<unknown>)(...args);
	},
}));

const { createNativeFileBoundary } = await import('./native-store.js');
const { openNativeFolder } = await import('./directory.test-support.js');

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const author = { name: 'App', email: 'app@example.test' };
const roots: string[] = [];
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});
afterEach(async () => {
	beforeRead = undefined;
	failList = undefined;
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function root(prefix: string) {
	const created = await realpath(await scratch(prefix));
	roots.push(created);
	return created;
}

/**
 * Pause the capture after it enumerated, just before it reads `path`. The
 * pause ends when the work `during` starts has settled, which a boundary
 * that lets it overlap the capture allows. A boundary that orders the two
 * never settles it during the pause, so the timer releases the capture.
 */
function pauseCaptureBeforeReading(path: string) {
	const { promise: paused, resolve: reached } = Promise.withResolvers<void>();
	const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
	let overlapped = false;
	beforeRead = {
		path,
		async run() {
			reached();
			let timer: ReturnType<typeof setTimeout> | undefined;
			overlapped = await Promise.race([
				settled.then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), 250);
				}),
			]);
			clearTimeout(timer);
		},
	};
	return {
		paused,
		during<T>(work: Promise<T>): Promise<T> {
			return work.finally(settle);
		},
		get overlapped() {
			return overlapped;
		},
	};
}

const renameOldToNew: FileChange[] = [
	{
		kind: 'move',
		from: 'todos/old.md',
		to: 'todos/new.md',
	},
	{
		kind: 'move',
		from: 'todos/old.png',
		to: 'todos/new.png',
	},
];

test('a rename through the same boundary cannot land between enumerating and reading', async () => {
	const folder = await root('native-capture-');
	await mkdir(join(folder, 'todos'));
	await writeFile(join(folder, 'todos', 'old.md'), 'row');
	await writeFile(join(folder, 'todos', 'old.png'), 'image');
	const boundary = createNativeFileBoundary(folder);
	const pause = pauseCaptureBeforeReading(join(folder, 'todos', 'old.md'));

	const capturing = boundary.capture();
	await pause.paused;
	// A read is not ordered behind the capture it overlaps.
	expect(
		new TextDecoder().decode(
			expectOk(await boundary.read('todos/old.png')).bytes,
		),
	).toBe('image');
	const renaming = pause.during(boundary.apply(renameOldToNew));
	const captured = expectOk(await capturing);
	expectOk(await renaming);

	expect(
		[...captured.files].map(([path, bytes]) => [
			path,
			new TextDecoder().decode(bytes),
		]),
	).toEqual([
		['todos/old.md', 'row'],
		['todos/old.png', 'image'],
	]);
	expect(captured.unreadable).toEqual([]);
	expect(pause.overlapped).toBe(false);
	// Directory order is the filesystem's: ext4 lists in hash order.
	expect((await readdir(join(folder, 'todos'))).sort()).toEqual([
		'new.md',
		'new.png',
	]);
	expect([...expectOk(await boundary.capture()).files.keys()]).toEqual([
		'todos/new.md',
		'todos/new.png',
	]);
});

test('a checkpoint that overlaps a table rename commits the files from before it, never an empty tree', async () => {
	const folder = await root('native-capture-history-');
	const opened = await openNativeFolder({
		root: folder,
		definition,
		git: { author },
	});
	try {
		const entry = expectOk(
			await opened.tables.todos.create(
				{ fields: { title: 'Old', done: false }, body: '' },
				{ stem: 'old' },
			),
		);
		expectOk(
			await opened.files.create('todos/old.png', new Uint8Array([1, 2, 3])),
		);
		// The saves' automatic commit, or this one if it gets there first.
		await opened.git.commit();
		const tree = () => git(folder, 'ls-tree', '-r', '--name-only', 'HEAD');
		expect(await tree()).toBe('epicenter.json\ntodos/old.md\ntodos/old.png');
		const pause = pauseCaptureBeforeReading(join(folder, 'todos', 'old.md'));

		const committing = opened.git.commit();
		await pause.paused;
		const renaming = pause.during(opened.tables.todos.rename(entry, 'new'));
		// The overlapping commit read the files from before the rename: nothing
		// had changed, so it committed nothing, and never an empty tree.
		expect((await committing).status).toBe('unchanged');
		expectOk(await renaming);
		expect(expectOk(await opened.tables.todos.get('new'))?.sha256).toBe(
			entry.sha256,
		);
		expect(pause.overlapped).toBe(false);
		// The rename's own commit, or this one.
		await opened.git.commit();
		// Only the row moved; the image beside it stays where it was.
		expect(await tree()).toBe('epicenter.json\ntodos/new.md\ntodos/old.png');
	} finally {
		await opened.close();
	}
});

test('a capture that fails releases the batch and the capture queued after it', async () => {
	const folder = await root('native-capture-failure-');
	await mkdir(join(folder, 'todos'));
	await writeFile(join(folder, 'todos', 'old.md'), 'row');
	await writeFile(join(folder, 'todos', 'old.png'), 'image');
	const boundary = createNativeFileBoundary(folder);
	failList = folder;

	const [failed, renamed, captured] = await Promise.all([
		boundary.capture(),
		boundary.apply(renameOldToNew),
		boundary.capture(),
	]);

	expect(expectErr(failed).name).toBe('Io');
	expectOk(renamed);
	expect([...expectOk(captured).files.keys()]).toEqual([
		'todos/new.md',
		'todos/new.png',
	]);
});

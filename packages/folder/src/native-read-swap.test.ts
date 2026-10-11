/**
 * Native Read Swap Tests
 *
 * A read inspects each component of a path and then opens it. Another program
 * can replace the file in between. Opening a named pipe for reading waits for
 * a writer, so a read that opened a swapped-in pipe would never settle, and
 * one that followed a swapped-in link would read outside the folder.
 *
 * Key behaviors:
 * - A file swapped for a pipe after it was inspected is `InvalidPath`, and the
 *   read settles
 * - A file swapped for a link after it was inspected is `InvalidPath`, and the
 *   link's target is never read
 * - A capture refuses the same swaps the same way
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as realFs from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr } from 'wellcrafted/testing';
import { scratch } from './git-http.test-support.js';

const real = { ...realFs };
const { open, realpath, rm, symlink, unlink, writeFile } = real;

/** Runs after the next inspection of this absolute path, once, when set. */
let afterInspect: { path: string; run: () => Promise<void> } | undefined;

// The native store reads these bindings at call time, so the hook lands
// between its inspection and its open without a production seam.
mock.module('node:fs/promises', () => ({
	...real,
	default: real,
	async lstat(...args: Parameters<typeof real.lstat>) {
		const stats = await real.lstat(...args);
		if (afterInspect !== undefined && String(args[0]) === afterInspect.path) {
			const { run } = afterInspect;
			afterInspect = undefined;
			await run();
		}
		return stats;
	},
}));

const { createNativeFileBoundary } = await import('./native-store.js');

const roots: string[] = [];
afterEach(async () => {
	afterInspect = undefined;
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function folder(prefix: string) {
	const root = await realpath(await scratch(prefix));
	roots.push(root);
	await writeFile(join(root, 'a.md'), 'a');
	return root;
}

/** Settle `work`, or report that it did not within a few seconds. */
async function settled<T>(work: Promise<T>): Promise<T | 'blocked'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const blocked = new Promise<'blocked'>((resolve) => {
		timer = setTimeout(() => resolve('blocked'), 3000);
	});
	try {
		return await Promise.race([work, blocked]);
	} finally {
		clearTimeout(timer);
	}
}

/** Open a pipe for writing and close it, so a reader waiting on it ends. */
async function release(pipe: string) {
	const writer = await open(pipe, 'w').catch(() => undefined);
	await writer?.close();
}

test('a file swapped for a pipe after it was inspected is refused, and the read settles', async () => {
	const root = await folder('read-swap-pipe-');
	const target = join(root, 'a.md');
	afterInspect = {
		path: target,
		async run() {
			await unlink(target);
			expect(spawnSync('mkfifo', [target]).status).toBe(0);
		},
	};
	const outcome = await settled(createNativeFileBoundary(root).read('a.md'));
	if (outcome === 'blocked') await release(target);
	expect(outcome).not.toBe('blocked');
	expect(expectErr(outcome as never)).toMatchObject({
		name: 'InvalidPath',
		path: 'a.md',
		reason: 'the path is not a regular file',
	});
});

test('a file swapped for a link after it was inspected is refused, and its target is never read', async () => {
	const root = await folder('read-swap-link-');
	const outside = await realpath(await scratch('read-swap-outside-'));
	roots.push(outside);
	await writeFile(join(outside, 'secret.md'), 'secret');
	const target = join(root, 'a.md');
	afterInspect = {
		path: target,
		async run() {
			await unlink(target);
			await symlink(join(outside, 'secret.md'), target);
		},
	};
	expect(
		expectErr(await createNativeFileBoundary(root).read('a.md')),
	).toMatchObject({
		name: 'InvalidPath',
		path: 'a.md',
		reason: 'the path passes through a symbolic link',
	});
});

test('a capture skips a file swapped for a pipe or a link after enumeration', async () => {
	for (const swap of ['pipe', 'link'] as const) {
		const root = await folder(`capture-swap-${swap}-`);
		await writeFile(join(root, 'b.md'), 'b');
		const outside = await realpath(await scratch('capture-swap-outside-'));
		roots.push(outside);
		await writeFile(join(outside, 'secret.md'), 'secret');
		const target = join(root, 'a.md');
		// Enumeration inspects each entry it lists, then the capture reads it.
		afterInspect = {
			path: target,
			async run() {
				await unlink(target);
				if (swap === 'pipe')
					expect(spawnSync('mkfifo', [target]).status).toBe(0);
				else await symlink(join(outside, 'secret.md'), target);
			},
		};
		const outcome = await settled(createNativeFileBoundary(root).capture());
		if (outcome === 'blocked') await release(target);
		expect(outcome).not.toBe('blocked');
		const captured = (outcome as Exclude<typeof outcome, 'blocked'>).data;
		expect(captured === null ? null : [...captured.files.keys()]).toEqual([
			'b.md',
		]);
	}
});

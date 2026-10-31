/**
 * Capture over a real device client (`@epicenter/folder/node`) in a
 * temporary directory, as one view composes it. The client the list writes
 * through can be made to fail, or to hold its writes until released, the
 * way a full disk or a slow write would.
 *
 * Import `svelte-dom.test-support.js` (or `svelte-modules`) first: the store
 * and `fromClient` need Svelte's client runtime.
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Capture, capture } from '@epicenter/capture';
import { type Client, ClientError } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import type { View } from './captures.svelte.ts';

const { fromClient } = await import('@epicenter/svelte/client');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { flushSync } = await import('svelte');
const { createCaptures } = await import('./captures.svelte.ts');

type Files = Record<string, string | Uint8Array>;

/** A temporary directory holding `files`. */
async function directory(files: Files) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-capture-'));
	for (const [path, data] of Object.entries(files)) await put(root, path, data);
	return root;
}

/** Write a file the way another program would: no client hears it from here. */
async function put(root: string, path: string, data: string | Uint8Array) {
	await mkdir(join(root, path, '..'), { recursive: true });
	await writeFile(join(root, path), data);
}

/** Wait for `check`, flushing Svelte's effects between looks. */
export async function until(
	check: () => boolean | Promise<boolean>,
	timeout = 5000,
) {
	const end = Date.now() + timeout;
	flushSync();
	while (!(await check())) {
		if (Date.now() > end) throw new Error('Timed out waiting');
		await Bun.sleep(5);
		flushSync();
	}
}

/**
 * The capture store of the view `view` over a client holding `files`, as
 * its page composes it. Writes fail or wait on command.
 */
export async function openCaptures(
	files: Files = {},
	{ view = 'device' }: { view?: View } = {},
) {
	const root = await directory(files);
	const device = openDevice(capture, { path: root });

	let failing: string | null = null;
	let gate: Promise<void> | null = null;
	const guarded = <TArgs extends unknown[], TResult>(
		write: (...args: TArgs) => Promise<TResult>,
	) =>
		(async (...args: TArgs) => {
			await gate;
			if (failing !== null)
				return ClientError.Unavailable({ cause: new Error(failing) });
			return write(...args);
		}) as (...args: TArgs) => Promise<TResult>;
	const { captures: notes } = device;
	const client: Client<Capture> = {
		captures: {
			...notes,
			create: guarded(notes.create),
			update: guarded(notes.update),
			replace: guarded(notes.replace),
			delete: guarded(notes.delete),
		},
	};

	const list = fromClient(client).captures;
	const captures = createCaptures(list, { view });
	// Read the list in an effect, as the views do, so it lists and listens.
	const watching = follow(() => [list.items, list.invalid, list.loading]);
	await until(() => !list.loading);

	return {
		captures,
		list,
		device,
		/** The text at `path` on the device, or null. */
		text: (path: string) =>
			readFile(join(root, path), 'utf8').catch(() => null),
		/** Write `path` on the device as another tab or program would. */
		writeElsewhere: (path: string, text: string) => put(root, path, text),
		/** Delete `path` on the device as another tab or program would. */
		deleteElsewhere: (path: string) => unlink(join(root, path)),
		/** Fail every write until the returned function is called. */
		failWrites(reason = 'the disk is full') {
			failing = reason;
			return () => {
				failing = null;
			};
		},
		/** Hold every write until the returned function is called. */
		holdWrites() {
			let release = () => {};
			gate = new Promise<void>((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
		async close() {
			watching.stop();
			await rm(root, { recursive: true, force: true });
		},
	};
}
export type CapturesHarness = Awaited<ReturnType<typeof openCaptures>>;

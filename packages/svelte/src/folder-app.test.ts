/**
 * FolderApp's injected opener owns construction while the component owns
 * retry and cleanup. These tests use real browser folders, including an
 * opener that finishes after the component is gone.
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { OpenFolderError, openFolder } from '@epicenter/folder/browser';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { FolderContext } from './folder-context.js';
import { click } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: FolderAppHost } = await import(
	'./fixtures/FolderAppHost.svelte'
);
const tables = { notes: Type.Object({ title: Type.String() }) };
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function until(check: () => boolean) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error('FolderApp did not finish the expected transition');
}

test.each(['refusal', 'rejection'] as const)(
	'a retry calls the supplied opener again after an opening %s',
	async (failure) => {
		globalThis.indexedDB = new IDBFactory();
		const target = document.createElement('div');
		document.body.append(target);
		cleanup.push(() => target.remove());
		let calls = 0;
		let context: FolderContext | undefined;
		const view = mount(FolderAppHost, {
			target,
			props: {
				open: async () => {
					calls++;
					if (calls === 1) {
						const cause = new Error('Storage is temporarily unavailable');
						if (failure === 'rejection') throw cause;
						return OpenFolderError.Unavailable({ cause });
					}
					return openFolder({ tables });
				},
				onContext: (opened: FolderContext) => {
					context = opened;
				},
			},
		});
		cleanup.push(() => unmount(view));

		await until(() => target.querySelector('button') !== null);
		expect(target.textContent).toContain('Could not open storage');
		expect(context).toBeUndefined();
		expect(calls).toBe(1);
		click(target, 'Try again');
		await until(() => context !== undefined);

		expect(calls).toBe(2);
		expect(target.textContent).not.toContain('Could not open storage');
		const notes = context?.folder.tables.notes;
		if (notes === undefined)
			throw new Error('The supplied folder was not provided');
		expect(expectOk(await notes.list())).toEqual([]);
	},
);

test('a folder returned after unmount is closed without mounting its children', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables }));
	const close = spyOn(folder, 'close');
	cleanup.push(() => close.mockRestore());
	cleanup.push(() => folder.close());
	const opening = Promise.withResolvers<void>();
	const target = document.createElement('div');
	document.body.append(target);
	cleanup.push(() => target.remove());
	let childrenMounted = false;
	const view = mount(FolderAppHost, {
		target,
		props: {
			open: async () => {
				await opening.promise;
				return Ok(folder);
			},
			onContext: () => {
				childrenMounted = true;
			},
		},
	});
	flushSync();
	const loading = target.textContent;
	await unmount(view);
	opening.resolve();
	await until(() => close.mock.calls.length > 0);
	await close.mock.results[0]?.value;

	expect(loading).toContain('Opening…');
	expect(close).toHaveBeenCalledTimes(1);
	expect(childrenMounted).toBe(false);
	expect(() => folder.files.list()).toThrow('closed');
});


test('document departure warns for accepted input until its save lands', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables, saveAfterMs: 60_000 }));
	expectOk(await folder.tables.notes.set('milk', null, {
		fields: { title: 'Milk' }, body: 'Before',
	}));
	cleanup.push(() => folder.close());
	const target = document.createElement('div');
	document.body.append(target);
	cleanup.push(() => target.remove());
	let context: FolderContext | undefined;
	const view = mount(FolderAppHost, {
		target,
		props: { open: async () => Ok(folder), onContext: (opened: FolderContext) => { context = opened; } },
	});
	cleanup.push(() => unmount(view));
	await until(() => context !== undefined);

	const leaves = () => {
		const event = new window.Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		return !event.defaultPrevented;
	};
	expect(leaves()).toBe(true);
	const edit = folder.tables.notes.edit('milk');
	expectOk(await edit.read());
	expectOk(edit.change({ body: 'Accepted, not published yet' }));
	expect(folder.getStatus().unsaved).toContain('notes/milk.md');
	expect(leaves()).toBe(false);
	await folder.settle();
	expect(leaves()).toBe(true);
});

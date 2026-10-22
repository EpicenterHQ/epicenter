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
import {
	desktop,
	nativeWindow,
	untilListening,
} from './tauri-window.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: FolderAppHost } = await import(
	'./fixtures/FolderAppHost.svelte'
);
const tables = { notes: Type.Object({ title: Type.String() }) };
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	nativeWindow.reset();
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
	desktop(true);
	await unmount(view);
	opening.resolve();
	await until(() => close.mock.calls.length > 0);
	await close.mock.results[0]?.value;

	expect(loading).toContain('Opening…');
	expect(close).toHaveBeenCalledTimes(1);
	expect(childrenMounted).toBe(false);
	expect(nativeWindow.listeners).toBe(0);
	expect(() => folder.files.list()).toThrow('closed');
});

test('an old late opener cannot steal or retire a replacement FolderApp guard', async () => {
	globalThis.indexedDB = new IDBFactory();
	const oldFolder = expectOk(await openFolder({ tables }));
	const replacementFolder = expectOk(await openFolder({ tables }));
	cleanup.push(
		() => oldFolder.close(),
		() => replacementFolder.close(),
	);
	const oldOpening = Promise.withResolvers<void>();
	const oldTarget = document.createElement('div');
	const replacementTarget = document.createElement('div');
	document.body.append(oldTarget, replacementTarget);
	cleanup.push(
		() => oldTarget.remove(),
		() => replacementTarget.remove(),
	);
	const oldView = mount(FolderAppHost, {
		target: oldTarget,
		props: {
			open: async () => {
				await oldOpening.promise;
				return Ok(oldFolder);
			},
			onContext: () => {},
		},
	});
	desktop(true);
	await unmount(oldView);
	const replacementView = mount(FolderAppHost, {
		target: replacementTarget,
		props: { open: async () => Ok(replacementFolder), onContext: () => {} },
	});
	cleanup.push(() => unmount(replacementView));
	await untilListening();
	oldOpening.resolve();
	await until(() => oldFolder.getStatus().closing);
	expect(nativeWindow.listeners).toBe(1);
});

test.each(['resolve', 'reject'] as const)(
	'unmount closes a context while native registration is pending, then registration may %s',
	async (outcome) => {
		globalThis.indexedDB = new IDBFactory();
		const folder = expectOk(await openFolder({ tables }));
		const close = spyOn(folder, 'close');
		cleanup.push(
			() => close.mockRestore(),
			() => folder.close(),
		);
		const registration = Promise.withResolvers<void>();
		nativeWindow.registration = registration.promise;
		desktop(true);
		const target = document.createElement('div');
		document.body.append(target);
		cleanup.push(() => target.remove());
		const view = mount(FolderAppHost, {
			target,
			props: { open: async () => Ok(folder), onContext: () => {} },
		});
		await Bun.sleep(5);
		await unmount(view);
		expect(close).toHaveBeenCalledTimes(1);
		if (outcome === 'resolve') registration.resolve();
		else registration.reject(new Error('Registration failed late'));
		await Bun.sleep(5);
		expect(nativeWindow.listeners).toBe(0);
		expect(folder.getStatus().closing).toBe(true);
	},
);

test('document departure warns for accepted input until its save lands', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables, saveAfterMs: 60_000 }));
	expectOk(
		await folder.tables.notes.write('milk', {
			fields: { title: 'Milk' },
			body: 'Before',
		}),
	);
	cleanup.push(() => folder.close());
	const target = document.createElement('div');
	document.body.append(target);
	cleanup.push(() => target.remove());
	let context: FolderContext | undefined;
	const view = mount(FolderAppHost, {
		target,
		props: {
			open: async () => Ok(folder),
			onContext: (opened: FolderContext) => {
				context = opened;
			},
		},
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
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: 'Accepted, not published yet' }));
	expect(folder.getStatus().unsaved).toContain('notes/milk.md');
	expect(leaves()).toBe(false);
	expectOk(await edit.save());
	expect(leaves()).toBe(true);
});

test('pagehide and hidden visibility flush synchronously without waiting', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables, saveAfterMs: 60_000 }));
	cleanup.push(() => folder.close());
	const flush = spyOn(folder, 'flush');
	cleanup.push(() => flush.mockRestore());
	const target = document.createElement('div');
	document.body.append(target);
	cleanup.push(() => target.remove());
	let ready = false;
	const view = mount(FolderAppHost, {
		target,
		props: {
			open: async () => Ok(folder),
			onContext: () => {
				ready = true;
			},
		},
	});
	cleanup.push(() => unmount(view));
	await until(() => ready);
	const edit = folder.files.edit('held.md');
	expectOk(edit.replaceText('held'));
	window.dispatchEvent(new window.Event('pagehide'));
	expect(flush).toHaveBeenCalledTimes(1);
	expect(flush.mock.results[0]?.value).toBeUndefined();
	const visibility = Object.getOwnPropertyDescriptor(
		document,
		'visibilityState',
	);
	try {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			value: 'hidden',
		});
		document.dispatchEvent(new window.Event('visibilitychange'));
		expect(flush).toHaveBeenCalledTimes(2);
		expect(flush.mock.results[1]?.value).toBeUndefined();
		await until(() => !folder.getStatus().saving);
	} finally {
		if (visibility)
			Object.defineProperty(document, 'visibilityState', visibility);
		else Reflect.deleteProperty(document, 'visibilityState');
	}
});

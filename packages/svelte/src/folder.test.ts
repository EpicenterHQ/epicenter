/**
 * Reactive folder reads, editor-owned drafts, and folder close.
 * Draft tests mount real components so lifecycle flushes and listeners run.
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { createFolder, memoryHost, SaveError } from '@epicenter/folder/testing';
import { Type } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	desktop,
	nativeWindow,
	requestClose,
	untilListening,
} from './tauri-window.test-support.js';

const { svelteFolder } = await import('./folder.js');
const { FOLDER_CLOSE } = await import('./draft.svelte.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: DraftHost } = await import('./fixtures/DraftHost.svelte');
const { default: FileDraftHost } = await import(
	'./fixtures/FileDraftHost.svelte'
);
const { default: OpenFolderHost } = await import(
	'./fixtures/OpenFolderHost.svelte'
);

const tables = { notes: Type.Object({ title: Type.String() }) };
const text = (title: string) => `---\ntitle: ${title}\n---\nBody\n`;
const failure = { message: 'disk full' };
type Failure = { message: string };
type Editor = ReturnType<
	typeof import('./draft.svelte.js').draft<string, Failure>
>;

async function until(check: () => boolean) {
	for (let turn = 0; turn < 100 && !check(); turn++) {
		await Bun.sleep(2);
		flushSync();
	}
	expect(check()).toBe(true);
}

function mountedDraft(
	source: () => string,
	save: (value: string) => Promise<Result<unknown, Failure>>,
	delay = 10,
) {
	const target = document.createElement('div');
	document.body.append(target);
	let editor: Editor | undefined;
	const view = mount(DraftHost, {
		target,
		props: {
			source,
			save,
			delay,
			expose: (draft) => {
				editor = draft;
			},
		},
	});
	flushSync();
	if (editor === undefined) throw new Error('Draft did not mount');
	return {
		editor,
		target,
		async unmount() {
			await unmount(view);
			target.remove();
		},
	};
}

test('folder files and rows are tracked and unchanged rows keep identity', async () => {
	const memory = memoryHost({
		'notes/milk.md': text('Milk'),
		'notes/eggs.md': text('Eggs'),
	});
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables })),
	);
	const titles = follow(() =>
		folder.tables.notes.rows.map((row) => row.fields?.title),
	);
	const eggs = follow(() => folder.tables.notes.row('eggs'));
	const files = follow(() => folder.files);
	flushSync();
	const firstEgg = eggs.values[0];
	await folder.tables.notes.update('milk', { fields: { title: 'Oat milk' } });
	await until(() => titles.values.at(-1)?.[1] === 'Oat milk');
	expect(eggs.values.at(-1)).toBe(firstEgg);
	expect(folder.tables.notes.row('eggs')).toBe(firstEgg);
	expect(files.values.length).toBeGreaterThan(1);
	titles.stop();
	eggs.stop();
	files.stop();
});

test('file and saving reads track a queued write', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables })),
	);
	const file = follow(() => folder.file('note.txt')?.data);
	const saving = follow(() => folder.saving);
	flushSync();
	let release: () => void = () => {};
	memory.control.putGate = new Promise((resolve) => {
		release = resolve;
	});
	const saved = folder.write('note.txt', 'New');
	flushSync();
	expect(saving.values.at(-1)).toBe(true);
	expect(file.values.at(-1)).toBe('Disk');
	memory.control.putGate = undefined;
	release();
	expectOk(await saved);
	flushSync();
	expect(file.values.at(-1)).toBe('New');
	expect(saving.values.at(-1)).toBe(false);
	file.stop();
	saving.stop();
});

test('svelteFolder passes refresh through to the core', async () => {
	const memory = memoryHost({ 'notes/milk.md': text('Milk') });
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables })),
	);
	memory.outside('notes/milk.md', text('Oat'), { hint: false });
	await folder.refresh();
	expect(folder.tables.notes.row('milk')?.fields?.title).toBe('Oat');
});

test('a burst of typing debounces to one synchronous save call', async () => {
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
		20,
	);
	mounted.editor.value = 'A';
	mounted.editor.value = 'AB';
	expect(mounted.editor.value).toBe('AB');
	expect(calls).toEqual([]);
	await until(() => calls.length === 1);
	expect(calls).toEqual(['AB']);
	await mounted.unmount();
});

test('land sends a pending debounce and waits for its answer', async () => {
	const pending = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return pending.promise;
		},
		1000,
	);
	mounted.editor.value = 'Typed';
	const landed = mounted.editor.land();
	expect(calls).toEqual(['Typed']);
	pending.resolve(Ok(undefined));
	expectOk(await landed);
	expect(mounted.editor.value).toBe('Disk');
	await mounted.unmount();
});

test('land waits for an out save then sends newer typing', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const second = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return calls.length === 1 ? first.promise : second.promise;
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	const landed = mounted.editor.land();
	expect(calls).toEqual(['First']);
	first.resolve(Ok(undefined));
	await until(() => calls.length === 2);
	expect(calls).toEqual(['First', 'Second']);
	second.resolve(Ok(undefined));
	expectOk(await landed);
	await mounted.unmount();
});

test('land returns a failed save and leaves its error visible', async () => {
	let calls = 0;
	const mounted = mountedDraft(
		() => 'Disk',
		() => {
			calls++;
			return Promise.resolve(Err(failure));
		},
	);
	mounted.editor.value = 'Typed';
	expectErr(await mounted.editor.land());
	expect(mounted.editor.error).toEqual(failure);
	expect(mounted.editor.value).toBe('Typed');
	await mounted.unmount();
	expect(calls).toBe(1);
	expectOk(await mounted.editor.land());
	expect(calls).toBe(1);
});

test('fileDraft edits LF text and sends with current file newline style', async () => {
	const memory = memoryHost({ 'note.txt': 'First\r\nSecond\r\n' });
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables })),
	);
	const target = document.createElement('div');
	document.body.append(target);
	let editor: ReturnType<typeof import('./folder.js').fileDraft> | undefined;
	const view = mount(FileDraftHost, {
		target,
		props: {
			folder,
			path: 'note.txt',
			expose: (value) => {
				editor = value;
			},
		},
	});
	flushSync();
	if (editor === undefined) throw new Error('File draft did not mount');
	expect(editor.value).toBe('First\nSecond\n');
	editor.value = 'Changed\n';
	expectOk(await editor.land());
	expect(memory.text('note.txt')).toBe('Changed\r\n');
	await unmount(view);
	target.remove();
});

test('fileDraft keeps a byte order mark and starts empty for non-text data', async () => {
	const memory = memoryHost({
		'bom.txt': '\ufeffFirst\r\n',
		'binary.txt': Uint8Array.of(255),
	});
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables })),
	);
	for (const [path, shown, typed, stored] of [
		['bom.txt', '\ufeffFirst\n', '\ufeffChanged\n', '\ufeffChanged\r\n'],
		['binary.txt', '', 'New\n', 'New\n'],
	] as const) {
		const target = document.createElement('div');
		document.body.append(target);
		let editor: ReturnType<typeof import('./folder.js').fileDraft> | undefined;
		const view = mount(FileDraftHost, {
			target,
			props: {
				folder,
				path,
				expose: (value) => {
					editor = value;
				},
			},
		});
		flushSync();
		if (editor === undefined) throw new Error('File draft did not mount');
		expect(editor.value).toBe(shown);
		editor.value = typed;
		expectOk(await editor.land());
		expect(folder.file(path)?.data).toBe(stored);
		expect(memory.text(path)).toBe(stored.replace(/^\ufeff/, ''));
		if (path === 'bom.txt') {
			const result = (await memory.storage.read([path])).get(path);
			if (result === undefined) throw new Error('Read did not answer');
			const fetched = expectOk(result);
			if (fetched === null) throw new Error('File disappeared');
			expect([...fetched.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		}
		await unmount(view);
		target.remove();
	}
});

test('a timed send waits for an out save, then sends the newest value', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const second = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return calls.length === 1 ? first.promise : second.promise;
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	mounted.editor.value = 'Newest';
	await Bun.sleep(20);
	expect(calls).toEqual(['First']);
	first.resolve(Ok(undefined));
	await until(() => calls.length === 2);
	expect(calls).toEqual(['First', 'Newest']);
	expect(mounted.editor.value).toBe('Newest');
	second.resolve(Ok(undefined));
	await Promise.resolve();
	expect(mounted.editor.value).toBe('Disk');
	await mounted.unmount();
});

test('folder close event flushes the newest value while an earlier save is out', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return calls.length === 1
				? first.promise
				: Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	window.dispatchEvent(new CustomEvent(FOLDER_CLOSE));
	expect(calls).toEqual(['First', 'Second']);
	first.resolve(Ok(undefined));
	await mounted.unmount();
});

test('pagehide flush calls save synchronously before the event returns', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const mounted = mountedDraft(
		() => {
			const data = folder.file('note.txt')?.data;
			return typeof data === 'string' ? data : '';
		},
		(value) => folder.write('note.txt', value),
		1000,
	);
	mounted.editor.value = 'Typed';
	window.dispatchEvent(new Event('pagehide'));
	expect(folder.saving()).toBe(true);
	await folder.close();
	expect(memory.text('note.txt')).toBe('Typed');
	await mounted.unmount();
});

test('teardown flushes pending input and never saves after teardown', async () => {
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
		1000,
	);
	mounted.editor.value = 'Last';
	await mounted.unmount();
	expect(calls).toEqual(['Last']);
	await Bun.sleep(20);
	expect(calls).toEqual(['Last']);
});

test('rejected and thrown saves leave typed input and an error', async () => {
	const rejected = mountedDraft(
		() => 'Disk',
		() => Promise.reject(failure),
	);
	rejected.editor.value = 'Rejected';
	await until(() => rejected.editor.error !== null);
	expect(rejected.editor.error).toEqual(failure);
	expect(rejected.editor.value).toBe('Rejected');
	await rejected.unmount();
	const thrown = mountedDraft(
		() => 'Disk',
		() => {
			throw failure;
		},
	);
	thrown.editor.value = 'Thrown';
	await until(() => thrown.editor.error !== null);
	expect(thrown.editor.error).toEqual(failure);
	await thrown.unmount();
});

test('failed input retries and discard ignores an out answer', async () => {
	let fails = true;
	const pending = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedDraft(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return fails ? Promise.resolve(Err(failure)) : pending.promise;
		},
	);
	mounted.editor.value = 'Typed';
	await until(() => mounted.editor.error !== null);
	expect(mounted.editor.value).toBe('Typed');
	fails = false;
	mounted.editor.retry();
	expect(calls).toEqual(['Typed', 'Typed']);
	mounted.editor.discard();
	pending.resolve(Ok(undefined));
	await Promise.resolve();
	expect(mounted.editor.value).toBe('Disk');
	expect(mounted.editor.error).toBeNull();
	await mounted.unmount();
});

test('OpenFolder closes after a draft flushes behind an out save', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(OpenFolderHost, {
		target,
		props: {
			open: () => Promise.resolve(Ok(folder)),
			holdWindowClose: false,
			edit: true,
		},
	});
	await until(() => target.querySelector('input') !== null);
	const input = target.querySelector('input');
	if (input === null) throw new Error('Missing editor');
	let release: () => void = () => {};
	memory.control.putGate = new Promise((resolve) => {
		release = resolve;
	});
	input.value = 'First';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await until(() => memory.log.puts.length === 1);
	input.value = 'Second';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	const closed = unmount(view);
	await closed;
	expect(memory.log.puts).toHaveLength(1);
	memory.control.putGate = undefined;
	release();
	await until(() => memory.control.closed);
	expect(memory.log.puts).toEqual([{ path: 'note.txt' }, { path: 'note.txt' }]);
	expect(memory.text('note.txt')).toBe('Second');
	target.remove();
});

test('desktop close waits for a pending draft write before destroying the window', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	desktop(true);
	const view = mount(OpenFolderHost, {
		target,
		props: { open: () => Promise.resolve(Ok(folder)), edit: true },
	});
	let release: () => void = () => {};
	try {
		await untilListening();
		await until(() => target.querySelector('input') !== null);
		const input = target.querySelector('input');
		if (input === null) throw new Error('Missing editor');
		memory.control.putGate = new Promise((resolve) => {
			release = resolve;
		});
		input.value = 'Typed just before close';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const closing = requestClose();
		await until(() => folder.saving());
		expect(nativeWindow.destroyed).toBe(0);
		expect(memory.text('note.txt')).toBe('Disk');
		release();
		await closing;
		expect(nativeWindow.destroyed).toBe(1);
		expect(memory.text('note.txt')).toBe('Typed just before close');
		expect(memory.control.closed).toBe(false);
	} finally {
		release();
		await unmount(view);
		await until(() => memory.control.closed);
		nativeWindow.reset();
		target.remove();
	}
});

test('desktop close stays open while a mounted draft holds text that did not save', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	desktop(true);
	let editor: Editor | undefined;
	const view = mount(OpenFolderHost, {
		target,
		props: {
			open: () => Promise.resolve(Ok(folder)),
			edit: true,
			expose: (draft: Editor) => {
				editor = draft;
			},
		},
	});
	try {
		await untilListening();
		await until(() => editor !== undefined);
		if (editor === undefined) throw new Error('Missing editor');
		const typed = editor;
		memory.control.failPut.set(
			'note.txt',
			expectErr(SaveError.StorageFailed({ cause: 'full' })),
		);
		typed.value = 'Typed before a failing close';
		// The save sent by the close itself fails: the window stays open.
		await requestClose();
		expect(nativeWindow.destroyed).toBe(0);
		expect(document.documentElement.inert).toBe(false);
		expect(typed.value).toBe('Typed before a failing close');
		expect(typed.error).not.toBeNull();
		// A value that already failed is not resent, and still keeps the window.
		memory.control.failPut.clear();
		await requestClose();
		expect(nativeWindow.destroyed).toBe(0);
		expect(memory.text('note.txt')).toBe('Disk');
		// Save again lands it; the next close goes.
		typed.retry();
		await until(() => typed.error === null && !folder.saving());
		await requestClose();
		expect(nativeWindow.destroyed).toBe(1);
		expect(memory.text('note.txt')).toBe('Typed before a failing close');
	} finally {
		await unmount(view);
		await until(() => memory.control.closed);
		nativeWindow.reset();
		target.remove();
	}
});

test('a page unload asks while a draft holds text whose save failed', async () => {
	const mounted = mountedDraft(
		() => 'Disk',
		() => Promise.resolve(Err(failure)),
	);
	const unload = () => {
		const event = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		return event.defaultPrevented;
	};
	expect(unload()).toBe(false);
	mounted.editor.value = 'Typed';
	await until(() => mounted.editor.error !== null);
	expect(unload()).toBe(true);
	mounted.editor.discard();
	expect(unload()).toBe(false);
	await mounted.unmount();
});

test('a failed desktop destroy leaves the mounted Folder writable', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	desktop(true);
	const view = mount(OpenFolderHost, {
		target,
		props: { open: () => Promise.resolve(Ok(folder)) },
	});
	try {
		await untilListening();
		nativeWindow.refuseDestroy = true;
		await requestClose();
		expect(nativeWindow.destroyed).toBe(0);
		expect(memory.control.closed).toBe(false);
		expectOk(await folder.write('note.txt', 'Saved after failed close'));
		expect(memory.text('note.txt')).toBe('Saved after failed close');
		nativeWindow.refuseDestroy = false;
		await requestClose();
		expect(nativeWindow.destroyed).toBe(1);
	} finally {
		await unmount(view);
		await until(() => memory.control.closed);
		nativeWindow.reset();
		target.remove();
	}
});

test('holdWindowClose false registers no desktop close listener', async () => {
	const memory = memoryHost();
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	desktop(true);
	try {
		const view = mount(OpenFolderHost, {
			target,
			props: {
				open: () => Promise.resolve(Ok(folder)),
				holdWindowClose: false,
			},
		});
		await until(() => target.textContent?.includes('Ready') ?? false);
		expect(nativeWindow.listeners).toBe(0);
		await unmount(view);
		await until(() => memory.control.closed);
	} finally {
		nativeWindow.reset();
		target.remove();
	}
});

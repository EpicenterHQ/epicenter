/**
 * Reactive folder reads, editor-owned edits, and folder close.
 * Edit tests mount real components so immediate saves and listeners run.
 */
import './svelte-dom.test-support.js';
import { expect, mock, test } from 'bun:test';
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

/** The native close question; a folder test should never reach it. */
const ask = mock(async () => false);
mock.module('@tauri-apps/plugin-dialog', () => ({ ask }));

const { svelteFolder } = await import('./folder.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: EditHost } = await import('./fixtures/EditHost.svelte');
const { default: FileEditHost } = await import(
	'./fixtures/FileEditHost.svelte'
);
const { default: OpenFolderHost } = await import(
	'./fixtures/OpenFolderHost.svelte'
);

const tables = { notes: Type.Object({ title: Type.String() }) };
const text = (title: string) => `---\ntitle: ${title}\n---\nBody\n`;
const failure = { message: 'disk full' };
type Failure = { message: string };
type Editor = ReturnType<
	typeof import('./edit.svelte.js').edit<string, Failure>
>;

async function until(check: () => boolean) {
	for (let turn = 0; turn < 100 && !check(); turn++) {
		await Bun.sleep(2);
		flushSync();
	}
	expect(check()).toBe(true);
}

function mountedEdit(
	source: () => string,
	save: (value: string) => Promise<Result<unknown, Failure>>,
) {
	const target = document.createElement('div');
	document.body.append(target);
	let editor: Editor | undefined;
	const view = mount(EditHost, {
		target,
		props: {
			source,
			save,
			expose: (edit) => {
				editor = edit;
			},
		},
	});
	flushSync();
	if (editor === undefined) throw new Error('Edit did not mount');
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

test('each typed value calls save immediately', async () => {
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'A';
	mounted.editor.value = 'AB';
	expect(mounted.editor.value).toBe('AB');
	expect(calls).toEqual(['A', 'AB']);
	await mounted.unmount();
});

test('landed waits for the newest sent value', async () => {
	const pending = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return pending.promise;
		},
	);
	mounted.editor.value = 'Typed';
	const landed = mounted.editor.landed();
	expect(calls).toEqual(['Typed']);
	pending.resolve(Ok(undefined));
	expectOk(await landed);
	expect(mounted.editor.value).toBe('Disk');
	await mounted.unmount();
});

test('landed waits for newer typing while an older save is out', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const second = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return calls.length === 1 ? first.promise : second.promise;
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	const landed = mounted.editor.landed();
	expect(calls).toEqual(['First', 'Second']);
	first.resolve(Ok(undefined));
	expect(calls).toEqual(['First', 'Second']);
	second.resolve(Ok(undefined));
	expectOk(await landed);
	await mounted.unmount();
});

test('landed returns a failed save and leaves its error visible', async () => {
	let calls = 0;
	const mounted = mountedEdit(
		() => 'Disk',
		() => {
			calls++;
			return Promise.resolve(Err(failure));
		},
	);
	mounted.editor.value = 'Typed';
	expectErr(await mounted.editor.landed());
	expect(mounted.editor.error).toEqual(failure);
	expect(mounted.editor.value).toBe('Typed');
	await mounted.unmount();
	expect(calls).toBe(1);
	expectOk(await mounted.editor.landed());
	expect(calls).toBe(1);
});

test('fileEdit edits LF text and sends with current file newline style', async () => {
	const memory = memoryHost({ 'note.txt': 'First\r\nSecond\r\n' });
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables })),
	);
	const target = document.createElement('div');
	document.body.append(target);
	let editor: ReturnType<typeof import('./folder.js').fileEdit> | undefined;
	const view = mount(FileEditHost, {
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
	if (editor === undefined) throw new Error('File edit did not mount');
	expect(editor.value).toBe('First\nSecond\n');
	editor.value = 'Changed\n';
	expectOk(await editor.landed());
	expect(memory.text('note.txt')).toBe('Changed\r\n');
	await unmount(view);
	target.remove();
});

test('fileEdit keeps a byte order mark and starts empty for non-text data', async () => {
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
		let editor: ReturnType<typeof import('./folder.js').fileEdit> | undefined;
		const view = mount(FileEditHost, {
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
		if (editor === undefined) throw new Error('File edit did not mount');
		expect(editor.value).toBe(shown);
		editor.value = typed;
		expectOk(await editor.landed());
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

test('older answers do not replace the newest typed value', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const second = Promise.withResolvers<Result<unknown, Failure>>();
	const third = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			switch (calls.length) {
				case 1:
					return first.promise;
				case 2:
					return second.promise;
				default:
					return third.promise;
			}
		},
	);
	mounted.editor.value = 'First';
	await until(() => calls.length === 1);
	mounted.editor.value = 'Second';
	mounted.editor.value = 'Newest';
	expect(calls).toEqual(['First', 'Second', 'Newest']);
	first.resolve(Ok(undefined));
	second.resolve(Ok(undefined));
	await Promise.resolve();
	expect(mounted.editor.value).toBe('Newest');
	third.resolve(Ok(undefined));
	await until(() => mounted.editor.value === 'Disk');
	expect(mounted.editor.value).toBe('Disk');
	await mounted.unmount();
});

test('an edit does not register a beforeunload prompt', async () => {
	const first = Promise.withResolvers<Result<unknown, Failure>>();
	const calls: string[] = [];
	const mounted = mountedEdit(
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
	const leaving = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(leaving);
	expect(calls).toEqual(['First', 'Second']);
	expect(leaving.defaultPrevented).toBe(false);
	first.resolve(Ok(undefined));
	await mounted.unmount();
});

test('pagehide does not resend an already sent value', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const mounted = mountedEdit(
		() => {
			const data = folder.file('note.txt')?.data;
			return typeof data === 'string' ? data : '';
		},
		(value) => folder.write('note.txt', value),
	);
	mounted.editor.value = 'Typed';
	window.dispatchEvent(new Event('pagehide'));
	expect(folder.saving()).toBe(true);
	await folder.close();
	expect(memory.text('note.txt')).toBe('Typed');
	expect(memory.log.puts).toHaveLength(1);
	await mounted.unmount();
});

test('teardown does not resend input or save after teardown', async () => {
	const calls: string[] = [];
	const mounted = mountedEdit(
		() => 'Disk',
		(value) => {
			calls.push(value);
			return Promise.resolve(Ok(undefined));
		},
	);
	mounted.editor.value = 'Last';
	await mounted.unmount();
	expect(calls).toEqual(['Last']);
	await Bun.sleep(20);
	expect(calls).toEqual(['Last']);
});

test('rejected and thrown saves leave typed input and an error', async () => {
	const rejected = mountedEdit(
		() => 'Disk',
		() => Promise.reject(failure),
	);
	rejected.editor.value = 'Rejected';
	await until(() => rejected.editor.error !== null);
	expect(rejected.editor.error).toEqual(failure);
	expect(rejected.editor.value).toBe('Rejected');
	await rejected.unmount();
	const thrown = mountedEdit(
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
	const mounted = mountedEdit(
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

test('OpenFolder closes after queued immediate saves land', async () => {
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

test('desktop close waits for a pending edit write before destroying the window', async () => {
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

test('desktop close discards text whose save failed, without asking', async () => {
	const memory = memoryHost({ 'note.txt': 'Disk' });
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	desktop(true);
	ask.mockClear();
	const view = mount(OpenFolderHost, {
		target,
		props: { open: () => Promise.resolve(Ok(folder)), edit: true },
	});
	try {
		await untilListening();
		await until(() => target.querySelector('input') !== null);
		memory.control.failPut.set(
			'note.txt',
			expectErr(SaveError.StorageFailed({ cause: 'full' })),
		);
		const input = target.querySelector('input');
		if (input === null) throw new Error('Missing editor');
		input.value = 'Shown inline, then discarded';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await requestClose();
		expect(ask).not.toHaveBeenCalled();
		expect(nativeWindow.destroyed).toBe(1);
		expect(memory.text('note.txt')).toBe('Disk');
	} finally {
		await unmount(view);
		await until(() => memory.control.closed);
		nativeWindow.reset();
		target.remove();
	}
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

/**
 * File editing during cache refresh. Background reads keep the existing text
 * editable; failed exact-source input stays visible after the saved file is
 * replaced by binary content. Failed row input stays available when its file
 * disappears. The mounted view uses real IndexedDB storage.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { isMissing } = await import('../../lib/local.test-support.js');

import { afterEach, expect, test } from 'bun:test';
import { ReadError } from '@epicenter/folder';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openNotes, noteText, quiet, until } = await import(
	'../../lib/local.test-support.ts'
);
const FileDetail = (await import('./FileDetail.svelte')).default;
const Host = (await import('../../lib/ui-host.test-support.svelte')).default;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});
async function open(path = 'draft.txt', content = 'Original text') {
	const fixture = await openNotes();
	await fixture.write(path, content);
	fixture.observe(path);
	await quiet(fixture.notes);
	const target = document.createElement('main');
	document.body.append(target);
	const view = mount(Host, {
		target,
		props: {
			client: fixture.notes.queryClient,
			component: FileDetail as never,
			props: { notes: fixture.notes, path, as: 'text' },
		},
	});
	let viewAlive = true;
	async function unmountView() {
		if (!viewAlive) return;
		viewAlive = false;
		await unmount(view);
	}
	cleanups.push(async () => {
		await unmountView();
		await fixture.close();
	});
	const input = () =>
		target.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="Contents of ${path.split('/').at(-1)}"]`,
		);
	await until(() => {
		flushSync();
		return input()?.value === content;
	}, 'the file editor');
	return { ...fixture, target, input, unmountView };
}

test('a background reread leaves the saved text editable', async () => {
	const { folder, local, input } = await open();
	const read = folder.files.read;
	const gate = Promise.withResolvers<void>();
	let waiting = false;
	folder.files.read = async (...args) => {
		if (args[0] === 'draft.txt') {
			waiting = true;
			await gate.promise;
		}
		return read(...args);
	};
	cleanups.push(() => {
		folder.files.read = read;
		gate.resolve();
	});
	const refreshing = local.refresh(['draft.txt']);
	await until(() => waiting, 'a background read');
	flushSync();
	expect(input()?.readOnly).toBe(false);
	type(input(), 'Typed during refresh');
	flushSync();
	expect(input()?.value).toBe('Typed during refresh');
	gate.resolve();
	await refreshing;
	flushSync();
	expect(input()?.value).toBe('Typed during refresh');
});

test('saved words stay shown when the reread fails, and typing on keeps them', async () => {
	const { folder, notes, local, input, text } = await open();
	const read = folder.files.read;
	folder.files.read = async (path) =>
		path === 'draft.txt'
			? ReadError.StorageFailed({ cause: new Error('read refused') })
			: read(path);
	cleanups.push(() => {
		folder.files.read = read;
	});
	type(input(), 'Committed words');
	flushSync();
	await notes.folder.files.document('draft.txt').save();
	await local.refresh(['draft.txt']);
	flushSync();
	expect(folder.files.document('draft.txt').getSnapshot().isDirty).toBe(false);
	expect(await text('draft.txt')).toBe('Committed words');
	expect(input()?.value).toBe('Committed words');
	expect(input()?.readOnly).toBe(false);

	type(input(), 'Committed words, and more');
	flushSync();
	await notes.folder.files.document('draft.txt').save();
	expect(await text('draft.txt')).toBe('Committed words, and more');
	folder.files.read = read;
	await local.refresh(['draft.txt']);
	flushSync();
	expect(input()?.value).toBe('Committed words, and more');
});

test('failed source input stays visible when the saved file becomes binary', async () => {
	const { notes, otherTab, failSaves, local, input } = await open();
	type(input(), 'Keep this unsaved text');
	flushSync();
	failSaves();
	await notes.folder.files.document('draft.txt').save();
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	failSaves(false);
	const other = await otherTab();
	const before = expectOk(await other.files.read('draft.txt'));
	if (before === undefined) throw new Error('The test file disappeared');
	expectOk(await other.files.write('draft.txt', new Uint8Array([0, 1, 2])));
	await local.refresh(['draft.txt']);
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	expect(notes.folder.files.document('draft.txt').getSnapshot().text).toBe(
		'Keep this unsaved text',
	);
});

test('failed row changes remain editable after deletion and Save again recreates the file', async () => {
	const path = 'notes/a.md';
	const { notes, folder, otherTab, failSaves, local, target, text } =
		await open(path, noteText());
	notes.folder.tables.notes
		.document(path.slice('notes/'.length, -3))
		.patch({ body: 'Keep my row changes\n' });
	failSaves();
	await folder.files.document(path).save();
	failSaves(false);
	const other = await otherTab();
	const stored = expectOk(await other.files.read(path));
	if (stored === undefined) throw new Error('The test note disappeared');
	expectOk(await other.files.delete(path));
	await local.refresh([path]);
	await until(() => {
		flushSync();
		return isMissing(folder.files.document(path));
	}, 'the missing note');
	expect(inputForRecovery(target)).toContain('Keep my row changes');
	expect(target.textContent).toContain('Save again');
	expect(target.textContent).toContain('Discard changes');
	click(target, 'Save again');
	await until(
		() => folder.files.document(path).getSnapshot().isDirty === false,
		'the explicit retry',
	);
	expect(await text(path)).toContain('Keep my row changes');
});

test('pending fields remain editable after broken stored source and Save again replaces it', async () => {
	const path = 'notes/a.md';
	const { notes, folder, otherTab, failSaves, local, target, input, text } =
		await open(path, noteText());
	notes.folder.tables.notes
		.document(path.slice('notes/'.length, -3))
		.patch({ fields: { title: 'Keep this title' } });
	failSaves();
	await folder.files.document(path).save();
	failSaves(false);
	const other = await otherTab();
	const before = await text(path);
	if (before === undefined) throw new Error('The test note disappeared');
	const broken = before.replace('\n---\n', '\n');
	expectOk(await other.files.write(path, broken));
	await local.refresh([path]);
	flushSync();
	expect(input()?.value).toContain('Keep this title');
	expect(target.querySelectorAll('[data-testid="write-status"]')).toHaveLength(
		1,
	);
	expect(
		[...target.querySelectorAll('button')].filter(
			(button) => button.textContent?.trim() === 'Save again',
		),
	).toHaveLength(1);
	click(target, 'Save again');
	await until(
		() => folder.files.document(path).getSnapshot().isDirty === false,
		'the explicit source replacement',
	);
	expect(await text(path)).toContain('Keep this title');
});

function inputForRecovery(target: ParentNode) {
	return target.querySelector<HTMLTextAreaElement>('textarea')?.value;
}

test.each(['missing', 'binary'] as const)(
	'clean acquired text survives %s replacement and unmounting before a new view',
	async (kind) => {
		const { notes, folder, otherTab, local, input, unmountView } = await open();
		const other = await otherTab();
		if (kind === 'missing') expectOk(await other.files.delete('draft.txt'));
		else
			expectOk(await other.files.write('draft.txt', new Uint8Array([0, 1, 2])));
		await local.refresh(['draft.txt']);
		flushSync();
		expect(folder.files.document('draft.txt').getSnapshot().isDirty).toBe(
			false,
		);
		expect(input()?.value).toBe('Original text');
		expect(input()?.readOnly).toBe(false);
		const retired = input();
		await unmountView();
		const target = document.createElement('main');
		document.body.append(target);
		const second = mount(Host, {
			target,
			props: {
				client: notes.queryClient,
				component: FileDetail as never,
				props: { notes, path: 'draft.txt', as: 'text' },
			},
		});
		cleanups.push(() => unmount(second));
		await until(() => {
			flushSync();
			return (
				target.querySelector<HTMLTextAreaElement>('textarea')?.value ===
				'Original text'
			);
		}, 'the retained clean text in a second view');
		type(target.querySelector('textarea'), 'Typed after replacement');
		flushSync();
		expect(folder.files.document('draft.txt').getSnapshot().text).toBe(
			'Typed after replacement',
		);
		type(retired, 'Late input from a destroyed view');
		expect(folder.files.document('draft.txt').getSnapshot().text).toBe(
			'Typed after replacement',
		);
		expectOk(await folder.files.document('draft.txt').save());
	},
);

test('a clean missing file can be reread without a write, then explicitly restored', async () => {
	const { folder, otherTab, local, target, text, saves } = await open();
	const other = await otherTab();
	expectOk(await other.files.delete('draft.txt'));
	await local.refresh(['draft.txt']);
	flushSync();
	await until(() => {
		flushSync();
		return isMissing(folder.files.document('draft.txt'));
	}, 'the missing editor acquisition');
	const before = saves('draft.txt');
	click(target, 'Try again');
	expect(
		expectErr(await folder.files.document('draft.txt').refresh()).name,
	).toBe('Missing');
	expect(await text('draft.txt')).toBeUndefined();
	expect(saves('draft.txt')).toBe(before);
	click(target, 'Restore text');
	await until(
		() => saves('draft.txt') === before + 1,
		'the explicit text restoration',
	);
	expect(await text('draft.txt')).toBe('Original text');
});

test('classifying initial large UTF-8 text does not acquire or mount its editor', async () => {
	const fixture = await openNotes();
	const path = 'large.txt';
	await fixture.write(path, 'x'.repeat(1024 * 1024 + 1));
	const { textRead } = await import('../../lib/file-reads.js');
	const classified = await fixture.notes.queryClient.fetchQuery(
		fixture.notes.queries.file(path, textRead),
	);
	expect(classified.kind).toBe('tooLarge');
	expect(
		fixture.folder.files.document(path).getSnapshot().text,
	).toBeUndefined();
	const target = document.createElement('main');
	document.body.append(target);
	const view = mount(Host, {
		target,
		props: {
			client: fixture.notes.queryClient,
			component: FileDetail as never,
			props: { notes: fixture.notes, path, as: 'text' },
		},
	});
	cleanups.push(async () => {
		await unmount(view);
		await fixture.close();
	});
	await until(() => {
		flushSync();
		return target.textContent?.includes('larger than 1 MB') ?? false;
	}, 'the initial file-size limit');
	expect(target.querySelector('textarea')).toBeNull();
	expect(
		fixture.folder.files.document(path).getSnapshot().text,
	).toBeUndefined();
	expect(fixture.saves(path)).toBe(0);
});

test('a clean note deleted in another tab stays shown as a note beside its deletion, and Restore text recreates it', async () => {
	const path = 'notes/a.md';
	const fixture = await openNotes();
	await fixture.write(path, noteText({ title: 'Kept' }));
	fixture.observe(path);
	await quiet(fixture.notes);
	const target = document.createElement('main');
	document.body.append(target);
	const view = mount(Host, {
		target,
		props: {
			client: fixture.notes.queryClient,
			component: FileDetail as never,
			props: { notes: fixture.notes, path, as: 'note' },
		},
	});
	cleanups.push(async () => {
		await unmount(view);
		await fixture.close();
	});
	const title = () =>
		target.querySelector<HTMLInputElement>('input[aria-label="Title"]');
	await until(() => {
		flushSync();
		return title()?.value === 'Kept';
	}, 'the note');
	const other = await fixture.otherTab();
	expectOk(await other.files.delete(path));
	await fixture.local.refresh([path]);
	await until(() => {
		flushSync();
		return isMissing(fixture.folder.files.document(path));
	}, 'the deletion');
	// The retained note stays editable, and the deletion shows beside it.
	expect(title()?.value).toBe('Kept');
	expect(target.querySelector('[role="alert"]')?.textContent).toContain(
		`${path} does not exist.`,
	);
	expect(target.textContent).toContain('Text kept here');
	click(target, 'Restore text');
	await until(
		() =>
			fixture.folder.files.document(path).getSnapshot().loadError === undefined,
		'the restored note',
	);
	expect(await fixture.text(path)).toBe(noteText({ title: 'Kept' }));
});

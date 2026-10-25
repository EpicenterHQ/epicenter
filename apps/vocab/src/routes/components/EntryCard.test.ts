import { createMemory, until } from '../../lib/folder.test-support.js';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, spyOn, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { createEntries } = await import('../../lib/entries.svelte.js');
const { toast } = await import('@epicenter/ui/sonner');
const { confirmationDialog } = await import(
	'@epicenter/ui/confirmation-dialog'
);

const { flushSync, mount, unmount } = await import('svelte');
const { cardProps } = await import('./card-props.test-support.svelte.js');
const { default: EntryCardHost } = await import(
	'./fixtures/EntryCardHost.svelte'
);

function noteOf(target: HTMLElement): HTMLTextAreaElement {
	const note = target.querySelector(
		'textarea[aria-label="Your note for lucid"]',
	);
	if (!(note instanceof HTMLTextAreaElement))
		throw new Error('Note editor missing');
	return note;
}

async function setup() {
	const { folder, core, host } = await createMemory();
	const entries = createEntries(folder);
	expectOk(await entries.add('lucid'));
	const id = entries.words[0]!.id;
	const card = cardProps(entries, entries.words[0]!);
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(EntryCardHost, { target, props: { card } });
	flushSync();
	return {
		folder,
		core,
		host,
		entries,
		id,
		card,
		target,
		mounted,
		async close() {
			await unmount(mounted);
			target.remove();
			await core.close();
		},
	};
}

test('note draft stays visible until save and then follows the row', async () => {
	const context = await setup();
	const note = noteOf(context.target);
	type(note, 'clear');
	flushSync();
	expect(note.value).toBe('clear');
	await until(() => {
		const row = context.folder.tables.entries.row(context.id);
		return row?.issues === null && row.fields.note === 'clear';
	}, 'note save');
	flushSync();
	expect(note.value).toBe('clear');
	await context.close();
});

test('typing again during a note save keeps the newer value', async () => {
	const context = await setup();
	const gate = Promise.withResolvers<void>();
	context.host.control.putGate = gate.promise;
	const note = noteOf(context.target);
	type(note, 'first');
	await until(() => context.folder.saving, 'first note save');
	type(note, 'second');
	flushSync();
	expect(note.value).toBe('second');
	gate.resolve();
	await until(() => context.folder.tables.entries.row(context.id)?.fields?.note === 'second', 'second note save');
	flushSync();
	expect(note.value).toBe('second');
	expect(context.folder.tables.entries.row(context.id)?.fields?.note).toBe('second');
	await context.close();
});

test('a failed note keeps its typed text and can retry or discard', async () => {
	const context = await setup();
	const path = `entries/${context.id}.md`;
	context.host.control.failPut.set(path, {
		name: 'StorageFailed',
		message: 'storage refused',
		cause: 'full',
	});
	const note = noteOf(context.target);
	type(note, 'failed text');
	await until(() => context.target.textContent?.includes('Not saved:') ?? false, 'failed save report');
	flushSync();
	expect(note.value).toBe('failed text');
	expect(context.target.textContent).toContain('Not saved:');
	expect(context.target.textContent).toContain('Save again');
	const row = context.folder.tables.entries.row(context.id);
	expect(row?.issues === null && row.fields.note).toBe('');
	context.host.control.failPut.delete(path);
	click(context.target, 'Save again');
	await until(() => context.folder.tables.entries.row(context.id)?.fields?.note === 'failed text', 'retried note save');
	flushSync();
	expect(context.target.textContent).not.toContain('Not saved:');
	context.host.control.failPut.set(path, {
		name: 'StorageFailed',
		message: 'storage refused',
		cause: 'full',
	});
	type(note, 'another attempt');
	await until(() => {
		flushSync();
		return context.target.textContent?.includes('Not saved:') ?? false;
	}, 'second failed save');
	flushSync();
	expect(note.value).toBe('another attempt');
	click(context.target, 'Discard');
	flushSync();
	expect(note.value).toBe('failed text');
	expect(context.target.textContent).not.toContain('Not saved:');
	await context.close();
});

test('note and stage updates merge over one path', async () => {
	const context = await setup();
	const note = noteOf(context.target);
	type(note, 'new note');
	click(context.target, 'Understand');
	await until(() => {
		const row = context.folder.tables.entries.row(context.id);
		return (
			row?.issues === null &&
			row.fields.stage === 'understood' &&
			row.fields.note === 'new note'
		);
	}, 'merged updates');
	await context.close();
});

test('failed stage and delete commands show their errors', async () => {
	const context = await setup();
	const path = `entries/${context.id}.md`;
	context.host.control.failPut.set(path, {
		name: 'StorageFailed',
		message: 'storage refused',
		cause: 'full',
	});
	const errorToast = spyOn(toast, 'error');
	try {
		click(context.target, 'Understand');
		await until(() => errorToast.mock.calls.length === 1, 'stage error');
		expect(errorToast.mock.calls[0]?.[0]).toBe('The stage was not saved');
		click(context.target, 'Delete');
		await confirmationDialog.confirm();
		expect(errorToast.mock.calls[1]?.[0]).toBe('The word was not deleted');
		expect(context.folder.tables.entries.row(context.id)).toBeDefined();
	} finally {
		errorToast.mockRestore();
		await context.close();
	}
});

test('Delete asks first; Cancel changes nothing, and confirming deletes the word', async () => {
	const context = await setup();
	const before = context.folder.tables.entries.row(context.id);
	click(context.target, 'Delete');
	expect(confirmationDialog.isOpen).toBe(true);
	expect(confirmationDialog.options?.title).toContain('lucid');
	confirmationDialog.cancel();
	expect(context.folder.tables.entries.row(context.id)).toEqual(before);
	click(context.target, 'Delete');
	await confirmationDialog.confirm();
	expect(context.folder.tables.entries.row(context.id)).toBeUndefined();
	await context.close();
});

import type { SaveFailure } from '@epicenter/svelte/folder-next';
import { createMemory, until } from '../../lib/folder.test-support.js';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { createEntries } = await import('../../lib/entries.svelte.js');
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
	const failures: SaveFailure[] = [];
	const { folder, core, host } = await createMemory({}, (failure) =>
		failures.push(failure),
	);
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
		failures,
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

test('a failed note save reports its typed text and the card follows disk', async () => {
	const context = await setup();
	const path = `entries/${context.id}.md`;
	context.host.control.failPut.set(path, {
		name: 'StorageFailed',
		message: 'storage refused',
		cause: 'full',
	});
	const note = noteOf(context.target);
	type(note, 'failed text');
	await until(() => context.failures.length > 0, 'failed save report');
	flushSync();
	expect(context.failures[0]?.text).toBe('failed text');
	expect(note.value).toBe('');
	const row = context.folder.tables.entries.row(context.id);
	expect(row?.issues === null && row.fields.note).toBe('');
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

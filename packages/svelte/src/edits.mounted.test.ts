/**
 * Two mounted views of each edit, over real Folder storage. Delivered input
 * updates both views; subsequent input uses the updated body, including a
 * deliberate revert. jsdom does not exercise browser selection or IME.
 */
import 'fake-indexeddb/auto';
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { fileBytes } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: EditViewsHost } = await import(
	'./fixtures/EditViewsHost.svelte'
);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

test('mounted row and text views follow each other and can revert held input', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(
		await openFolder({
			tables: { notes: Type.Object({ title: Type.String() }) },
			saveAfterMs: 60_000,
		}),
	);
	cleanup.push(() => folder.close());
	const initial = 'one\ntwo\nthree\n';
	expectOk(
		await folder.tables.notes.set('a', null, {
			fields: { title: 'A' },
			body: initial,
		}),
	);
	expectOk(await folder.files.write('b.md', null, initial));
	const observed = expectOk(await folder.tables.notes.get('a'))!;
	const bytes = await fileBytes(
		expectOk(await folder.files.read('b.md'))!.content,
	);
	const edit = folder.tables.notes.edit('a');
	const textEdit = folder.files.edit('b.md');
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(EditViewsHost, {
		target,
		props: { edit, observed, textEdit, bytes },
	});
	cleanup.push(async () => {
		await unmount(component);
		target.remove();
	});
	flushSync();
	const field = (label: string) =>
		target.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
	for (const kind of ['Row', 'Text']) {
		type(field(`${kind} 0`), 'ONE\ntwo\nthree\n');
		flushSync();
		expect(field(`${kind} 1`).value).toBe('ONE\ntwo\nthree\n');
		type(
			field(`${kind} 1`),
			field(`${kind} 1`).value.replace('three', 'THREE'),
		);
		flushSync();
		expect(field(`${kind} 0`).value).toBe('ONE\ntwo\nTHREE\n');
		type(field(`${kind} 0`), 'one\ntwo\nTHREE\n');
		flushSync();
		expect(field(`${kind} 1`).value).toBe('one\ntwo\nTHREE\n');
	}
	await Promise.all([edit.save(), textEdit.save()]);
	flushSync();
	expect(expectOk(await folder.tables.notes.get('a'))?.body).toBe(
		'one\ntwo\nTHREE\n',
	);
	expect(await expectOk(await folder.files.read('b.md'))?.content.text()).toBe(
		'one\ntwo\nTHREE\n',
	);
});

/**
 * Two mounted views of each edit, over real Folder storage. Delivered input
 * updates both views; subsequent input uses the updated body, including a
 * deliberate revert. jsdom does not exercise browser selection or IME.
 */
import 'fake-indexeddb/auto';
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount, tick } = await import('svelte');
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
		await folder.tables.notes.write('a', {
			fields: { title: 'A' },
			body: initial,
		}),
	);
	expectOk(await folder.files.write('b.md', initial));
	expectOk(
		await folder.tables.notes.write('c', {
			fields: { title: 'C' },
			body: 'Other address\n',
		}),
	);
	const edit = folder.tables.notes.edit('a');
	const textEdit = folder.files.edit('b.md');
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(EditViewsHost, { target, props: { folder } });
	cleanup.push(async () => {
		await unmount(component);
		target.remove();
	});
	flushSync();
	const field = (label: string) =>
		target.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
	// The views read the row and the file the first time they show them.
	for (
		let turn = 0;
		turn < 100 &&
		(field('Row 1')?.value !== initial || field('Text 1')?.value !== initial);
		turn++
	) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(field('Row 1').value).toBe(initial);
	expect(field('Text 1').value).toBe(initial);
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
	expect(field('Whole row text').value).toContain('one\ntwo\nTHREE\n');
	expect(
		target.querySelector('[aria-label="Shared adapter"]')?.textContent,
	).toBe('one');
	expect(
		target.querySelector('[aria-label="Shared pending"]')?.textContent,
	).toBe(edit.getSnapshot().content?.text);
	type(
		field('Whole row text'),
		field('Whole row text').value.replace('THREE', 'Three from text'),
	);
	flushSync();
	expect(field('Row 0').value).toBe('one\ntwo\nThree from text\n');
	expect(field('Row 1').value).toBe('one\ntwo\nThree from text\n');
	expect(
		target.querySelector('[aria-label="Shared pending"]')?.textContent,
	).toBe(edit.getSnapshot().content?.text);
	type(field('Row 1'), 'one\ntwo\nTHREE\n');
	flushSync();
	expect(field('Whole row text').value).toContain('one\ntwo\nTHREE\n');
	await Promise.all([edit.save(), textEdit.save()]);
	flushSync();
	expect(expectOk(await folder.tables.notes.get('a'))?.body).toBe(
		'one\ntwo\nTHREE\n',
	);
	expect(await expectOk(await folder.files.read('b.md'))?.content.text()).toBe(
		'one\ntwo\nTHREE\n',
	);
	type(field('Row 0'), 'Unsent A\n');
	flushSync();
	await tick();
	const switchAddress = target.querySelector('button')!;
	switchAddress.click();
	flushSync();
	for (
		let turn = 0;
		turn < 100 && field('Row 0')?.value !== 'Other address\n';
		turn++
	) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(field('Row 0').value).toBe('Other address\n');
	expect(field('Whole row text').value).toContain('title: C');
	expect(
		target.querySelector('[aria-label="Shared pending"]')?.textContent,
	).toBe('saved');
	switchAddress.click();
	flushSync();
	expect(field('Row 1').value).toBe('Unsent A\n');
	expect(field('Whole row text').value).toContain('Unsent A\n');
	expect(expectOk(await folder.tables.notes.get('a'))?.body).toBe(
		'one\ntwo\nTHREE\n',
	);
});

test('unmounted views leave held input with the folder, and a new mount shows it', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(
		await openFolder({
			tables: { notes: Type.Object({ title: Type.String() }) },
			saveAfterMs: 60_000,
		}),
	);
	cleanup.push(() => folder.close());
	expectOk(
		await folder.tables.notes.write('a', {
			fields: { title: 'A' },
			body: 'one\n',
		}),
	);
	expectOk(await folder.files.write('b.md', 'b\n'));
	const show = () => {
		const target = document.createElement('div');
		document.body.append(target);
		const component = mount(EditViewsHost, { target, props: { folder } });
		flushSync();
		return { target, component };
	};
	const first = show();
	const field = (target: HTMLElement, label: string) =>
		target.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`);
	for (
		let turn = 0;
		turn < 100 && field(first.target, 'Row 0')?.value !== 'one\n';
		turn++
	) {
		await Bun.sleep(5);
		flushSync();
	}
	type(field(first.target, 'Row 0')!, 'typed before unmount\n');
	flushSync();
	await unmount(first.component);
	first.target.remove();
	await tick();
	const edit = folder.tables.notes.edit('a');
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { body: 'typed before unmount\n' },
	});
	const second = show();
	cleanup.push(async () => {
		await unmount(second.component);
		second.target.remove();
	});
	expect(field(second.target, 'Row 1')?.value).toBe('typed before unmount\n');
	expect(folder.getStatus().unsaved).toEqual(['notes/a.md']);
});

/**
 * `svelteFolder` and `draft` over an in-memory host, read in effects as
 * components do.
 *
 * Key behaviors:
 * - `rows`, `row(id)`, and `files` are tracked: an effect reruns when they change
 * - `row(id)` answers the same object until that row changes
 * - A draft shows typing until its save answers, then follows the disk
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { createFolder, type FolderHost } from '@epicenter/folder/next';
import { Type } from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { SvelteTable } from './folder-next.js';

const { svelteFolder } = await import('./folder-next.js');
const { draft } = await import('./draft.svelte.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const tables = { notes: Type.Object({ title: Type.String() }) };
const text = (title: string, body = 'Body\n') =>
	`---\ntitle: ${title}\n---\n${body}`;
const encoder = new TextEncoder();

/** What a test does to the host: hold puts until `gate` settles, or fail them. */
type Control = { gate: Promise<void> | undefined; fail: boolean };

async function setup() {
	const files = new Map([
		['notes/milk.md', text('Milk')],
		['notes/eggs.md', text('Eggs')],
	]);
	let version = 1;
	const control: Control = { gate: undefined, fail: false };
	const host: FolderHost = {
		list: async () =>
			Ok(new Map([...files.keys()].map((path) => [path, { token: 't1' }]))),
		async read(paths) {
			return new Map(
				paths.map((path) => {
					const data = files.get(path);
					return [
						path,
						Ok(
							data === undefined
								? null
								: {
										bytes: encoder.encode(data),
										version: `v${version}`,
										token: `t${version}`,
									},
						),
					];
				}),
			);
		},
		async put(path, bytes) {
			await control.gate;
			if (control.fail)
				return Err({
					name: 'StorageFailed',
					message: 'disk full',
					cause: null,
				});
			if (bytes === null) files.delete(path);
			else files.set(path, new TextDecoder().decode(bytes));
			version++;
			return Ok({
				landed:
					bytes === null
						? null
						: { version: `v${version}`, token: `t${version}` },
			});
		},
	};
	const folder = svelteFolder(
		expectOk(await createFolder(host, { tables, throttleMs: 0 })),
	);
	return { folder, notes: folder.tables.notes, control };
}

type Notes = SvelteTable<(typeof tables)['notes']>;
const titleOf = (row: ReturnType<Notes['row']>) =>
	row?.issues === null ? row.fields.title : '';

async function until(check: () => boolean) {
	for (let turn = 0; turn < 100 && !check(); turn++) {
		await Bun.sleep(2);
		flushSync();
	}
	expect(check()).toBe(true);
}

test('rows is tracked, and an effect reruns when a row lands', async () => {
	const { notes } = await setup();
	const titles = follow(() => notes.rows.map((note) => note.fields?.title));
	flushSync();
	expect(titles.values).toEqual([['Milk', 'Eggs']]);
	await notes.update('milk', { fields: { title: 'Oat milk' } });
	await until(() => titles.values.length === 2);
	expect(titles.values[1]).toEqual(['Oat milk', 'Eggs']);
	titles.stop();
});

test('row(id) answers the same object until its own row changes', async () => {
	const { notes } = await setup();
	const eggs = follow(() => notes.row('eggs'));
	flushSync();
	await notes.update('milk', { fields: { title: 'Oat milk' } });
	await until(() => eggs.values.length >= 2);
	expect(eggs.values[1]).toBe(eggs.values[0]);
	expect(notes.row('eggs')).toBe(notes.rows[1]);
	eggs.stop();
});

test('a draft shows typing until its save lands, then follows the row', async () => {
	const { notes, control } = await setup();
	let open: () => void = () => {};
	control.gate = new Promise((resolve) => {
		open = resolve;
	});
	const title = draft(
		() => titleOf(notes.row('milk')),
		(title) => notes.update('milk', { fields: { title } }),
	);
	title.text = 'Oat';
	expect(title.text).toBe('Oat');
	expect(notes.row('milk')?.fields?.title).toBe('Milk');
	open();
	control.gate = undefined;
	await until(() => notes.row('milk')?.fields?.title === 'Oat');
	expect(title.text).toBe('Oat');
});

test('a draft whose save fails follows the disk again', async () => {
	const { notes, control } = await setup();
	control.fail = true;
	const title = draft(
		() => titleOf(notes.row('milk')),
		(title) => notes.update('milk', { fields: { title } }),
	);
	title.text = 'Oat';
	await until(() => title.text === 'Milk');
});

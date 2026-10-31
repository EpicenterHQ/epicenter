/**
 * `openDevice` from `@epicenter/folder/tauri`: the typed client over the
 * directory the desktop shell bound to this window, through the folder
 * plugin's storage commands. The shell here is `createGrantedShell`, a real
 * directory behind the plugin's command names, so what lands is what a
 * desktop folder holds.
 *
 * Key behaviors:
 * - The default is the bound directory itself; the page names no directory
 * - `path` names a folder inside it, and the client sees only that folder
 * - Versions are sha256, so a stale `over` is a `Conflict` and lands nothing
 * - A refusal from the shell, or a page outside Tauri, is `Unavailable`
 * - The shell's watcher reaches a collection's listeners, inside `path` only
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
} from './granted-shell.test-support.js';

let shell: GrantedShell;
let inTauri = true;
/** The channel each `open_folder` handed the shell, as its watcher would send on. */
const watchers: { onmessage?: (change: { paths: string[] | null }) => void }[] =
	[];

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => inTauri,
	transformCallback: () => 0,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => {
		if (cmd === 'plugin:epicenter-folder|open_folder')
			watchers.push((body as { onChange: (typeof watchers)[number] }).onChange);
		return shell.invoke(cmd, body, options);
	},
}));

const { openDevice } = await import('./tauri.js');

const notes = defineContract({
	name: 'notes',
	collections: {
		notes: {
			path: 'notes/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
	},
});

beforeEach(async () => {
	shell = createGrantedShell(await grantedDirectory('tauri-device-'));
	inTauri = true;
});

afterEach(async () => {
	await rm(shell.root, { recursive: true, force: true });
	await rm(shell.scratch, { recursive: true, force: true });
});

test('the default is the bound directory: a create lands there in house style', async () => {
	const device = openDevice(notes);
	const created = expectOk(
		await device.notes.create({ id: 'a', title: 'First', body: 'Hello.\n' }),
	);
	expect(await readFile(join(shell.root, 'notes/a.md'), 'utf8')).toBe(
		'---\ntitle: First\n---\nHello.\n',
	);
	expect(expectOk(await device.notes.get({ id: 'a' }))).toEqual(created);
	expect(
		expectOk(await device.notes.list()).items.map((note) => note.id),
	).toEqual(['a']);
});

test('a stale write is a Conflict and lands nothing; a current one lands', async () => {
	const device = openDevice(notes);
	const first = expectOk(await device.notes.create({ id: 'a', title: 'One' }));
	const second = expectOk(
		await device.notes.update(
			{ id: 'a' },
			{ title: 'Two' },
			{ over: first.version },
		),
	);
	const stale = expectErr(
		await device.notes.update(
			{ id: 'a' },
			{ title: 'Three' },
			{ over: first.version },
		),
	);
	expect(stale).toMatchObject({ name: 'Conflict', current: second.version });
	expect(await shell.text('notes/a.md')).toBe('---\ntitle: Two\n---\n');
	expectOk(await device.notes.delete({ id: 'a' }, { over: second.version }));
	expect(await shell.text('notes/a.md')).toBeUndefined();
});

test('another program’s edit is read with its own version', async () => {
	const device = openDevice(notes);
	await shell.write('notes/b.md', '---\ntitle: From git\n---\n');
	const read = expectOk(await device.notes.get({ id: 'b' }));
	expect(read.title).toBe('From git');
	expectOk(
		await device.notes.update(
			{ id: 'b' },
			{ title: 'Edited' },
			{ over: read.version },
		),
	);
	expect(await shell.text('notes/b.md')).toBe('---\ntitle: Edited\n---\n');
});

test('path names a folder inside the bound directory, and the client sees only it', async () => {
	await shell.write('notes/outside.md', '---\ntitle: Outside\n---\n');
	const device = openDevice(notes, { path: 'apps/notes' });
	expectOk(await device.notes.create({ id: 'a', title: 'Inside' }));
	expect(await shell.text('apps/notes/notes/a.md')).toBe(
		'---\ntitle: Inside\n---\n',
	);
	expect(
		expectOk(await device.notes.list()).items.map((note) => note.id),
	).toEqual(['a']);
});

test('a path that leaves the bound directory throws at once', () => {
	for (const path of ['../elsewhere', '/Users/me/Notes', 'a//b', 'a/./b'])
		expect(() => openDevice(notes, { path })).toThrow();
});

test('a refusal from the shell is Unavailable, and the next call tries again', async () => {
	const device = openDevice(notes);
	shell.control.refuseNext = 1;
	const refused = expectErr(
		await device.notes.create({ id: 'a', title: 'One' }),
	);
	expect(refused.name).toBe('Unavailable');
	expectOk(await device.notes.create({ id: 'a', title: 'One' }));
});

test('outside Tauri every call is Unavailable', async () => {
	inTauri = false;
	const device = openDevice(notes);
	expect(expectErr(await device.notes.list()).name).toBe('Unavailable');
	expect(shell.calls).toEqual([]);
});

test("the shell's watcher reaches a collection's listeners, and a folder inside hears only its own paths", async () => {
	const device = openDevice(notes);
	const inside = openDevice(notes, { path: 'inner' });
	let heard = 0;
	let heardInside = 0;
	const stop = device.notes.subscribe(() => heard++);
	const stopInside = inside.notes.subscribe(() => heardInside++);
	await Bun.sleep(0);
	const watcher = watchers.at(-1);
	if (watcher?.onmessage === undefined)
		throw new Error('no watcher was opened');
	watcher.onmessage({ paths: ['notes/a.md'] });
	expect([heard, heardInside]).toEqual([1, 0]);
	watcher.onmessage({ paths: ['inner/notes/a.md'] });
	expect([heard, heardInside]).toEqual([1, 1]);
	watcher.onmessage({ paths: ['elsewhere/x.md'] });
	expect([heard, heardInside]).toEqual([1, 1]);
	watcher.onmessage({ paths: null });
	expect([heard, heardInside]).toEqual([2, 2]);
	stop();
	stopInside();
	watcher.onmessage({ paths: ['notes/a.md'] });
	expect([heard, heardInside]).toEqual([2, 2]);
});

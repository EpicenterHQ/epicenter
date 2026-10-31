/**
 * Device Client Tests
 *
 * `openDevice` from `@epicenter/folder/node` is the typed client over a
 * directory: what an app writes there is what a desktop folder holds, so a
 * miss here is a lost or clobbered file, or a note out of house style.
 *
 * Key behaviors:
 * - A note is written in house style: the contract's keys first, in its order
 * - `create` never replaces a file (`Occupied`); a stale `over` never lands (`Conflict`)
 * - Fields and placeholders that do not fit the contract are refused (`Invalid`)
 * - A version is the sha256 of the bytes, the same from `list`, `get` and a write
 * - Reads are lenient: a hand-written note reads, and its next write formats it
 * - A note that does not read is listed with its text, to show and repair it
 * - A collection's listeners hear its own writes at once and outside ones soon
 * - An appended file is heard when it is made and when announced, not per piece
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineContract, type Version } from '@epicenter/definition/contract';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from '../hash.js';
import { openDevice } from '../node.js';
import { createDeviceClient, storeOf } from './client.js';
import type { DeviceStore } from './store.js';

const recorder = defineContract({
	name: 'recorder',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				durationMs: { type: 'number', minimum: 0 },
			},
			required: ['title'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function setup() {
	const parent = await mkdtemp(join(tmpdir(), 'epicenter-device-'));
	folders.push(parent);
	const root = join(parent, 'data');
	const device = unwrap(await openDevice(recorder, { path: root }));
	return {
		root,
		device,
		text: (path: string) => readFile(join(root, path), 'utf8'),
		async put(path: string, value: string | Uint8Array) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), value);
		},
	};
}

const bytes = (...values: number[]) => new Uint8Array(values);

test('create writes a note in house style, in the contract key order, into a folder it makes', async () => {
	const { device, text } = await setup();
	const created = expectOk(
		await device.recordings.create({
			id: 'a',
			durationMs: 1500,
			title: 'Standup',
			body: 'Notes.\n',
		}),
	);
	const written = await text('recordings/a.md');
	expect(written).toBe('---\ntitle: Standup\ndurationMs: 1500\n---\nNotes.\n');
	expect(created).toEqual({
		id: 'a',
		title: 'Standup',
		durationMs: 1500,
		body: 'Notes.\n',
		version: (await hashBytes(new TextEncoder().encode(written))) as Version,
	});
	expect(expectOk(await device.recordings.get({ id: 'a' }))).toEqual(created);
});

test('a read value spread back into a write never writes its version as front matter', async () => {
	const { device, text } = await setup();
	const read = expectOk(
		await device.recordings.create({ id: 'a', title: 'One' }),
	);
	const { id: _id, version, ...rest } = read;
	expectOk(
		await device.recordings.update(
			{ id: 'a' },
			{ ...rest, ...{ version } },
			{
				over: version,
			},
		),
	);
	expectOk(await device.recordings.create({ ...read, id: 'b' }));
	expect(await text('recordings/a.md')).toBe('---\ntitle: One\n---\n');
	expect(await text('recordings/b.md')).toBe('---\ntitle: One\n---\n');
});

test('create refuses a path that already holds a file, and changes nothing', async () => {
	const { device, text, put } = await setup();
	await put('recordings/a.md', '---\ntitle: Mine\n---\n');
	const refused = expectErr(
		await device.recordings.create({ id: 'a', title: 'Theirs' }),
	);
	expect(refused.name).toBe('Occupied');
	expect(await text('recordings/a.md')).toBe('---\ntitle: Mine\n---\n');
});

test('fields and placeholders that do not fit the contract are refused before anything is written', async () => {
	const { device, root } = await setup();
	const wrongType = expectErr(
		// @ts-expect-error durationMs is a number
		await device.recordings.create({ id: 'a', title: 'x', durationMs: 'long' }),
	);
	expect(wrongType.name).toBe('Invalid');
	const missing = expectErr(
		// @ts-expect-error title is required
		await device.recordings.create({ id: 'a' }),
	);
	expect(missing.name).toBe('Invalid');
	const escaping = expectErr(
		await device.recordings.create({ id: '../a', title: 'x' }),
	);
	expect(escaping.name).toBe('Invalid');
	expect(expectOk(await device.recordings.list()).items).toEqual([]);
	await expect(readFile(join(root, 'a.md'))).rejects.toThrow();
});

test('update patches fields, keeps undeclared keys, and formats a hand-written note', async () => {
	const { device, text, put } = await setup();
	await put(
		'recordings/a.md',
		'---\nmood: calm\ndurationMs: 10\ntitle: "Standup"\n---\nBody\n',
	);
	const read = expectOk(await device.recordings.get({ id: 'a' }));
	expect(read.title).toBe('Standup');
	const updated = expectOk(
		await device.recordings.update(
			{ id: 'a' },
			{ title: 'Daily', durationMs: undefined },
			{ over: read.version },
		),
	);
	expect(await text('recordings/a.md')).toBe(
		'---\ntitle: Daily\nmood: calm\n---\nBody\n',
	);
	expect(updated.title).toBe('Daily');
	expect(updated.durationMs).toBeUndefined();
	expect(updated.version).not.toBe(read.version);
});

test('a write over a stale version is a Conflict naming the current one, and lands nothing', async () => {
	const { device, text } = await setup();
	const first = expectOk(
		await device.recordings.create({ id: 'a', title: 'One' }),
	);
	const second = expectOk(
		await device.recordings.update(
			{ id: 'a' },
			{ title: 'Two' },
			{ over: first.version },
		),
	);
	const stale = expectErr(
		await device.recordings.update(
			{ id: 'a' },
			{ title: 'Three' },
			{ over: first.version },
		),
	);
	expect(stale).toMatchObject({ name: 'Conflict', current: second.version });
	const staleDelete = expectErr(
		await device.recordings.delete({ id: 'a' }, { over: first.version }),
	);
	expect(staleDelete).toMatchObject({
		name: 'Conflict',
		current: second.version,
	});
	expect(await text('recordings/a.md')).toBe('---\ntitle: Two\n---\n');
	expectOk(
		await device.recordings.delete({ id: 'a' }, { over: second.version }),
	);
	expect(expectErr(await device.recordings.get({ id: 'a' })).name).toBe(
		'NotFound',
	);
	const gone = expectErr(
		await device.recordings.update(
			{ id: 'a' },
			{ title: 'Four' },
			{ over: second.version },
		),
	);
	expect(gone).toMatchObject({ name: 'Conflict', current: null });
});

test('list reads every note of the collection, reports the ones that do not fit, and ignores other paths', async () => {
	const { device, put } = await setup();
	await put('recordings/a.md', '---\ntitle: A\n---\n');
	await put('recordings/b.md', '---\ntitle: [unclosed\n---\n');
	await put('recordings/c.md', '---\ndurationMs: 3\n---\n');
	await put('recordings/a.webm', bytes(1, 2, 3));
	await put('notes/elsewhere.md', '---\ntitle: X\n---\n');
	await put('.obsidian/workspace.json', '{}');
	const { items, invalid } = expectOk(await device.recordings.list());
	expect(items.map(({ id, title }) => ({ id, title }))).toEqual([
		{ id: 'a', title: 'A' },
	]);
	expect(invalid.map(({ path }) => path).sort()).toEqual([
		'recordings/b.md',
		'recordings/c.md',
	]);
	const invalidGet = expectErr(await device.recordings.get({ id: 'c' }));
	expect(invalidGet.name).toBe('Invalid');
});

test('a file collection takes both placeholders of {id}.{ext}, and its versions agree across list, get and writes', async () => {
	const { device, root } = await setup();
	const created = expectOk(
		await device.audio.create({ id: 'a', ext: 'm4a', bytes: bytes(1, 2, 3) }),
	);
	expect(created).toEqual({
		id: 'a',
		ext: 'm4a',
		version: (await hashBytes(bytes(1, 2, 3))) as Version,
	});
	expect(
		new Uint8Array(await readFile(join(root, 'recordings/a.m4a'))),
	).toEqual(bytes(1, 2, 3));
	expect(expectOk(await device.audio.list()).items).toEqual([created]);
	const read = expectOk(await device.audio.get({ id: 'a', ext: 'm4a' }));
	expect(read).toEqual({ ...created, bytes: bytes(1, 2, 3) });
	expect(
		expectErr(
			await device.audio.create({ id: 'a', ext: 'm4a', bytes: bytes(9) }),
		).name,
	).toBe('Occupied');
	const updated = expectOk(
		await device.audio.update(
			{ id: 'a', ext: 'm4a' },
			{ bytes: bytes(4, 5) },
			{ over: created.version },
		),
	);
	expect(expectOk(await device.audio.list()).items).toEqual([updated]);
	expect(
		expectErr(
			await device.audio.update(
				{ id: 'a', ext: 'm4a' },
				{ bytes: bytes(6) },
				{ over: created.version },
			),
		),
	).toMatchObject({ name: 'Conflict', current: updated.version });
	expectOk(
		await device.audio.delete(
			{ id: 'a', ext: 'm4a' },
			{ over: updated.version },
		),
	);
	expect(expectOk(await device.audio.list()).items).toEqual([]);
});

test('a file collection never names a note, and a note collection never lists a file', async () => {
	const { device } = await setup();
	const refused = expectErr(
		await device.audio.create({ id: 'a', ext: 'md', bytes: bytes(1) }),
	);
	expect(refused.name).toBe('Invalid');
});

test('a folder that cannot be made opens as Unreadable, not a throw', async () => {
	const { root, put } = await setup();
	await put('file', 'not a directory');
	const below = join(root, 'file', 'below');
	const opened = await openDevice(recorder, { path: below });
	expect(opened.error).toMatchObject({ name: 'Unreadable', folder: below });
	const file = await openDevice(recorder, { path: join(root, 'file') });
	expect(file.error?.name).toBe('Unreadable');
});

test('a note that does not read is listed with its placeholders, text and version, and replace repairs it', async () => {
	const { device, put, text } = await setup();
	const broken = '---\ntitle: [unclosed\n---\nKept.\n';
	await put('recordings/b.md', broken);
	await put('recordings/z.md', bytes(0xff, 0xfe));
	const { invalid } = expectOk(await device.recordings.list());
	expect(invalid.map(({ issues: _, ...rest }) => rest)).toEqual([
		{
			id: 'b',
			path: 'recordings/b.md',
			text: broken,
			version: (await hashBytes(new TextEncoder().encode(broken))) as Version,
		},
		{
			id: 'z',
			path: 'recordings/z.md',
			text: null,
			version: (await hashBytes(bytes(0xff, 0xfe))) as Version,
		},
	]);
	const [b] = invalid;
	if (b === undefined) throw new Error('expected the broken note');

	// Text that still does not read is refused, and nothing is written.
	const refused = expectErr(
		await device.recordings.replace({ id: 'b' }, '---\ntitle: [\n---\n', {
			over: b.version,
		}),
	);
	expect(refused.name).toBe('Invalid');
	expect(await text('recordings/b.md')).toBe(broken);

	const repaired = expectOk(
		await device.recordings.replace(
			{ id: 'b' },
			'---\ndurationMs: 3\ntitle: Fixed\n---\nKept.\n',
			{ over: b.version },
		),
	);
	expect(await text('recordings/b.md')).toBe(
		'---\ntitle: Fixed\ndurationMs: 3\n---\nKept.\n',
	);
	expect(repaired).toMatchObject({ id: 'b', title: 'Fixed', body: 'Kept.\n' });
	expect(
		expectErr(
			await device.recordings.replace({ id: 'b' }, '---\ntitle: X\n---\n', {
				over: b.version,
			}),
		),
	).toMatchObject({ name: 'Conflict', current: repaired.version });
});

test("a collection's listeners hear its writes before they resolve, and only its own paths", async () => {
	const { device, put } = await setup();
	const heard: string[] = [];
	const stopNotes = device.recordings.subscribe(() => heard.push('notes'));
	const stopAudio = device.audio.subscribe(() => heard.push('audio'));
	const note = expectOk(
		await device.recordings.create({ id: 'a', title: 'One' }),
	);
	// The folder's watcher may also echo a write, sooner or later.
	expect(new Set(heard)).toEqual(new Set(['notes']));
	await Bun.sleep(300);
	heard.length = 0;
	expectOk(await device.audio.create({ id: 'a', ext: 'm4a', bytes: bytes(1) }));
	expect(new Set(heard)).toEqual(new Set(['audio']));

	stopNotes();
	stopAudio();
	heard.length = 0;
	expectOk(
		await device.recordings.update(
			{ id: 'a' },
			{ title: 'Two' },
			{ over: note.version },
		),
	);
	await put('recordings/b.md', '---\ntitle: B\n---\n');
	await Bun.sleep(150);
	expect(heard).toEqual([]);
});

test('a write by another program to the folder reaches listeners; a hidden path does not', async () => {
	const { device, put } = await setup();
	// The folder exists once the client has opened it.
	expectOk(await device.recordings.list());
	let heard = 0;
	const stop = device.recordings.subscribe(() => heard++);
	await Bun.sleep(50);
	await put('.obsidian/workspace.json', '{}');
	await Bun.sleep(150);
	expect(heard).toBe(0);
	await put('recordings/b.md', '---\ntitle: B\n---\n');
	for (let turn = 0; turn < 300 && heard === 0; turn++) await Bun.sleep(10);
	expect(heard).toBeGreaterThan(0);
	stop();
});

test("an appended file's listeners hear it made and announced, not every piece", async () => {
	const files = new Map<string, Uint8Array>();
	const store: DeviceStore = {
		list: async () =>
			Ok([...files.keys()].map((path) => ({ path, stamp: '' }))),
		read: async () => Ok(null),
		write: async () => Ok('landed'),
		async append(path, added, { create }) {
			const there = files.get(path);
			if (create === (there !== undefined)) return Ok('stale');
			files.set(path, new Uint8Array([...(there ?? []), ...added]));
			return Ok('landed');
		},
		watch: () => () => {},
	};
	const device = createDeviceClient(recorder, store);
	let heard = 0;
	const stop = device.audio.subscribe(() => heard++);
	const appended = storeOf(device);
	const piece = (create: boolean, announce = false) =>
		appended.append!('recordings/a.m4a', bytes(1), { create, announce });

	expect(expectOk(await piece(true))).toBe('landed');
	expect(heard).toBe(1);
	expect(expectOk(await piece(true))).toBe('stale');
	expectOk(await piece(false));
	expectOk(await piece(false));
	expect(heard).toBe(1);
	expectOk(await piece(false, true));
	expect(heard).toBe(2);
	expect(files.get('recordings/a.m4a')).toEqual(bytes(1, 1, 1, 1));
	expect(
		expectOk(
			await appended.append!('recordings/b.m4a', bytes(2), {
				create: false,
				announce: true,
			}),
		),
	).toBe('stale');
	expect(heard).toBe(2);
	stop();
});

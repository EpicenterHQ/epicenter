/**
 * Device Client Tests
 *
 * A contract's collections over a directory (`directory(path)` from
 * `@epicenter/folder/node` opens a folder to it), and the folder's writes
 * there: what an app writes is what a desktop folder holds, so a miss here
 * is a lost or clobbered file, or a note out of house style.
 *
 * Key behaviors:
 * - A note is written in house style: the contract's keys first, in its order
 * - A write lands only over the version read (`'stale'` otherwise)
 * - A version is the sha256 of the bytes, the same from a listing, a read and a write
 * - Reads are lenient: a hand-written note reads, and its next write formats it
 * - A note that does not read is listed with its text, to show and repair it
 * - A collection's listeners hear its own writes at once and outside ones soon
 * - An appended file is heard when it is made and when announced, not per piece
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from '../hash.js';
import { directory } from '../node.js';
import { openFolder } from '../open-folder.js';
import { type CollectionFiles, createDeviceClient } from './client.js';
import { nodeStore } from './node-store.js';
import type { Store, Unavailable, Version } from './store.js';

const recorder = defineContract({
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
	await mkdir(root, { recursive: true });
	const client = createDeviceClient(recorder, nodeStore(root));
	return {
		root,
		folder: openFolder(recorder, directory(root)),
		recordings: client.collections.get('recordings') as CollectionFiles,
		audio: client.collections.get('audio') as CollectionFiles,
		text: (path: string) => readFile(join(root, path), 'utf8'),
		async put(path: string, value: string | Uint8Array) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), value);
		},
	};
}

const bytes = (...values: number[]) => new Uint8Array(values);
const versionOf = async (value: string | Uint8Array) =>
	(await hashBytes(
		typeof value === 'string' ? new TextEncoder().encode(value) : value,
	)) as Version;

test('set writes a note in house style, in the contract key order, into a folder it makes', async () => {
	const { folder, text, recordings } = await setup();
	await folder.recordings.set(
		{ id: 'a' },
		{ durationMs: 1500, title: 'Standup', body: 'Notes.\n' },
	);
	const written = await text('recordings/a.md');
	expect(written).toBe('---\ntitle: Standup\ndurationMs: 1500\n---\nNotes.\n');
	expect(folder.recordings.get({ id: 'a' })).toEqual({
		id: 'a',
		title: 'Standup',
		durationMs: 1500,
		body: 'Notes.\n',
	});
	const read = expectOk(await recordings.read('recordings/a.md'));
	expect(read?.version).toBe(await versionOf(written));
});

test('a read entry spread back into a set never writes its placeholders as front matter', async () => {
	const { folder, text } = await setup();
	await folder.recordings.set({ id: 'a' }, { title: 'One' });
	const read = folder.recordings.get({ id: 'a' });
	if (read === undefined) throw new Error('expected the note shown');
	await folder.recordings.set({ id: 'b' }, read);
	expect(await text('recordings/b.md')).toBe('---\ntitle: One\n---\n');
});

test('set changes the fields it names, keeps undeclared keys, and formats a hand-written note', async () => {
	const { folder, text, put } = await setup();
	await put(
		'recordings/a.md',
		'---\nmood: calm\ndurationMs: 10\ntitle: "Standup"\n---\nBody\n',
	);
	await folder.recordings.set(
		{ id: 'a' },
		{ title: 'Daily', durationMs: undefined },
	);
	expect(await text('recordings/a.md')).toBe(
		'---\ntitle: Daily\nmood: calm\n---\nBody\n',
	);
	expect(folder.recordings.get({ id: 'a' })).toMatchObject({ title: 'Daily' });
	expect(folder.recordings.get({ id: 'a' })?.durationMs).toBeUndefined();
});

test('a write over a stale version is stale and lands nothing; one over nothing lands only where nothing is', async () => {
	const { recordings, text, put } = await setup();
	const one = new TextEncoder().encode('---\ntitle: One\n---\n');
	const first = expectOk(await recordings.write('recordings/a.md', one, null));
	if (first === null || first === 'stale')
		throw new Error('expected a landing');
	expect(expectOk(await recordings.write('recordings/a.md', one, null))).toBe(
		'stale',
	);
	const two = new TextEncoder().encode('---\ntitle: Two\n---\n');
	const second = expectOk(
		await recordings.write('recordings/a.md', two, first.version),
	);
	if (second === null || second === 'stale')
		throw new Error('expected a landing');
	expect(second.item).toMatchObject({ id: 'a', title: 'Two' });
	expect(
		expectOk(await recordings.write('recordings/a.md', null, first.version)),
	).toBe('stale');
	expect(await text('recordings/a.md')).toBe('---\ntitle: Two\n---\n');
	expect(
		expectOk(await recordings.write('recordings/a.md', null, second.version)),
	).toBeNull();
	expect(expectOk(await recordings.read('recordings/a.md'))).toBeNull();
	await put('recordings/b.md', 'x');
	expect(
		expectOk(await recordings.write('recordings/b.md', null, second.version)),
	).toBe('stale');
});

test('list reads every note of the collection, reports the ones that do not fit, and ignores other paths', async () => {
	const { folder, put } = await setup();
	await put('recordings/a.md', '---\ntitle: A\n---\n');
	await put('recordings/b.md', '---\ntitle: [unclosed\n---\n');
	await put('recordings/c.md', '---\ndurationMs: 3\n---\n');
	await put('recordings/a.webm', bytes(1, 2, 3));
	await put('notes/elsewhere.md', '---\ntitle: X\n---\n');
	await put('.obsidian/workspace.json', '{}');
	const { items, invalid } = expectOk(await folder.recordings.list());
	expect(items.map(({ id, title }) => ({ id, title }))).toEqual([
		{ id: 'a', title: 'A' },
	]);
	expect(invalid.map(({ path }) => path).sort()).toEqual([
		'recordings/b.md',
		'recordings/c.md',
	]);
	expect(folder.recordings.get({ id: 'c' })).toBeUndefined();
});

test('a file collection takes both placeholders of {id}.{ext}, and its versions agree across list, read and writes', async () => {
	const { folder, audio, root } = await setup();
	const at = { id: 'a', ext: 'm4a' };
	await folder.audio.set(at, bytes(1, 2, 3));
	expect(
		new Uint8Array(await readFile(join(root, 'recordings/a.m4a'))),
	).toEqual(bytes(1, 2, 3));
	expect(expectOk(await folder.audio.list()).items).toEqual([at]);
	expect(expectOk(await folder.audio.read(at))).toEqual({
		...at,
		bytes: bytes(1, 2, 3),
	});
	const listed = expectOk(await audio.list());
	const read = expectOk(await audio.read('recordings/a.m4a'));
	expect(listed[0]?.version).toEqual(expect.any(String));
	expect(read?.version).toBe(listed[0]?.version);
	await folder.audio.set(at, bytes(4, 5));
	expect(expectOk(await folder.audio.read(at))?.bytes).toEqual(bytes(4, 5));
	await folder.audio.delete(at);
	expect(expectOk(await folder.audio.list()).items).toEqual([]);
});

test('a file collection never names a note', async () => {
	const { folder } = await setup();
	expect(() => folder.audio.set({ id: 'a', ext: 'md' }, bytes(1))).toThrow();
});

test('a folder that cannot be made opens as Unreadable, not a throw', async () => {
	const { root, put } = await setup();
	await put('file', 'not a directory');
	const below = join(root, 'file', 'below');
	const opened = openFolder(recorder, directory(below));
	expect(expectErr(await opened.recordings.list())).toMatchObject({
		name: 'Unreadable',
		folder: below,
	});
	const file = openFolder(recorder, directory(join(root, 'file')));
	expect(expectErr(await file.recordings.list()).name).toBe('Unreadable');
});

test('a note that does not read is listed with its placeholders and text, and its whole text repairs it', async () => {
	const { folder, put, text } = await setup();
	const broken = '---\ntitle: [unclosed\n---\nKept.\n';
	await put('recordings/b.md', broken);
	await put('recordings/z.md', bytes(0xff, 0xfe));
	const { invalid } = expectOk(await folder.recordings.list());
	expect(invalid.map(({ issues: _, ...rest }) => rest)).toEqual([
		{ id: 'b', path: 'recordings/b.md', text: broken },
		{ id: 'z', path: 'recordings/z.md', text: null },
	]);

	const editor = folder.recordings.edit({ id: 'b' });
	expect(editor.text).toBe(broken);
	editor.text = '---\ndurationMs: 3\ntitle: Fixed\n---\nKept.\n';
	await editor.landed();
	expect(await text('recordings/b.md')).toBe(
		'---\ntitle: Fixed\ndurationMs: 3\n---\nKept.\n',
	);
	expect(folder.recordings.get({ id: 'b' })).toMatchObject({
		id: 'b',
		title: 'Fixed',
		body: 'Kept.\n',
	});
});

test("a collection's listeners hear its writes before they resolve, and only its own paths", async () => {
	const { recordings, audio, put } = await setup();
	const heard: string[] = [];
	const stopNotes = recordings.subscribe(() => heard.push('notes'));
	const stopAudio = audio.subscribe(() => heard.push('audio'));
	// The watcher says once that it is live, to every collection.
	for (let turn = 0; turn < 300 && !heard.includes('audio'); turn++)
		await Bun.sleep(10);
	heard.length = 0;
	const one = new TextEncoder().encode('---\ntitle: One\n---\n');
	const note = expectOk(await recordings.write('recordings/a.md', one, null));
	// The folder's watcher may also echo a write, sooner or later.
	expect(new Set(heard)).toEqual(new Set(['notes']));
	await Bun.sleep(300);
	heard.length = 0;
	expectOk(await audio.write('recordings/a.m4a', bytes(1), null));
	expect(new Set(heard)).toEqual(new Set(['audio']));

	stopNotes();
	stopAudio();
	heard.length = 0;
	if (note === null || note === 'stale') throw new Error('expected a landing');
	expectOk(
		await recordings.write(
			'recordings/a.md',
			new TextEncoder().encode('---\ntitle: Two\n---\n'),
			note.version,
		),
	);
	await put('recordings/b.md', '---\ntitle: B\n---\n');
	await Bun.sleep(150);
	expect(heard).toEqual([]);
});

test('a write by another program to the folder reaches listeners; a hidden path does not', async () => {
	const { recordings, put } = await setup();
	expectOk(await recordings.list());
	let heard = 0;
	const stop = recordings.subscribe(() => heard++);
	// The watcher says once that it is live.
	for (let turn = 0; turn < 300 && heard === 0; turn++) await Bun.sleep(10);
	heard = 0;
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
	const store: Store & {
		append(
			path: string,
			added: Uint8Array,
			options: { create: boolean },
		): Promise<Result<'landed' | 'stale', Unavailable>>;
	} = {
		list: async () =>
			Ok(
				[...files.keys()].map((path) => ({
					path,
					version: '' as Version,
					size: 0,
				})),
			),
		read: async (paths) => Ok(paths.map((path) => ({ path, gone: true as const }))),
		write: async () => Ok(null),
		async append(path, added, { create }) {
			const there = files.get(path);
			if (create === (there !== undefined)) return Ok('stale');
			files.set(path, new Uint8Array([...(there ?? []), ...added]));
			return Ok('landed');
		},
		watch: async () => Ok(() => {}),
		close() {},
	};
	const audio = createDeviceClient(recorder, store).collections.get(
		'audio',
	) as CollectionFiles;
	let heard = 0;
	const stop = audio.subscribe(() => heard++);
	const piece = (create: boolean, announce = false) =>
		audio.append!('recordings/a.m4a', bytes(1), { create, announce });

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
			await audio.append!('recordings/b.m4a', bytes(2), {
				create: false,
				announce: true,
			}),
		),
	).toBe('stale');
	expect(heard).toBe(2);
	stop();
});

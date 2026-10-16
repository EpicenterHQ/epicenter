/**
 * KV Tests
 *
 * `folder.kv` reads and sets the root `kv.json`, one key at a time. These
 * drive the KV methods over one browser storage whose reads and
 * publications are counted, and whose next reads can be followed by another
 * writer.
 *
 * Key behaviors:
 * - `get` is `undefined` only for a missing file; every declared value that
 *   validated is in `values`, and a stored value that does not conform is
 *   left out and reported at its line, so the other keys still read
 * - Only text that is not one strict JSON object, or has a key twice, is
 *   `InvalidKv`, with its exact text, hash, and a located issue
 * - `set` merges one key into the current file, keeps every other key as its
 *   raw text, writes the Git-merge format, creates a missing file, and
 *   removes a key set to `undefined`
 * - A value that is not declared, does not conform, or cannot be stored is
 *   refused before anything is read, and the value is owned at the call
 * - Sets from one handle land in the order they were called
 * - A set that loses a race to another writer merges with it by key, so
 *   both writers' keys stick; a file that keeps changing past the merges is
 *   `KeptChanging`
 *
 * See also:
 * - `kv-merge.test.ts` for the Git merge that shares this file format
 */
import { expect, test } from 'bun:test';
import { jsonValue } from '@epicenter/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, field, type KvOf } from './contract.js';
import { FileError } from './errors.js';
import { createFiles } from './files.js';
import { createKv } from './kv.js';
import { mergeKv } from './kv-merge.js';
import { put } from './put.test-support.js';
import { WRITE_ATTEMPTS } from './save-file.js';

const definition = defineFolder({
	kv: {
		theme: field.string(),
		size: field.number(),
		layout: field.json(jsonValue),
	},
	tables: {},
});
type Values = KvOf<typeof definition>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** KV and file methods over one storage whose reads and publications are counted. */
async function setup(initial?: string | Uint8Array) {
	const base = (await rawBrowserFolder({ id: 'kv' })).boundary;
	const calls = { reads: 0, applies: 0 };
	/** Run after each of the next reads has its bytes, before the caller sees them. */
	let afterRead: (() => Promise<void>)[] = [];
	const storage: FolderStorage = {
		...base,
		async read(path) {
			calls.reads += 1;
			const read = await base.read(path);
			await afterRead.shift()?.();
			return read;
		},
		put(path, bytes, ifMatch) {
			calls.applies += 1;
			return base.put(path, bytes, ifMatch);
		},
	};
	const files = createFiles({ storage: base });
	if (initial !== undefined) expectOk(await files.create('kv.json', initial));
	return {
		kv: createKv<Values>({ storage }, definition.kv),
		files,
		calls,
		source: async () =>
			decoder.decode(expectOk(await files.read('kv.json')).bytes),
		afterNextReads(...work: (() => Promise<void>)[]) {
			afterRead = work;
		},
		/** Write kv.json as another program would, with no guard. */
		async elsewhere(text: string) {
			expectOk(await put(files, 'kv.json', text));
		},
	};
}

// -- Reading ------------------------------------------------------------------

test('get is undefined for a missing file and the stored values for a present one', async () => {
	expect(expectOk(await (await setup()).kv.get())).toBeUndefined();

	const text = '{\n  "theme": "dark",\n  "extra": 1\n}\n';
	const s = await setup(text);
	expect(expectOk(await s.kv.get())).toEqual({
		path: 'kv.json',
		sha256: await hashBytes(encoder.encode(text)),
		values: { theme: 'dark' },
		issues: [],
	});
});

test('bytes that are not UTF-8 are InvalidUtf8, not a missing file', async () => {
	const s = await setup(new Uint8Array([0x7b, 0xff, 0x7d]));
	expect(expectErr(await s.kv.get()).name).toBe('InvalidUtf8');
});

test('a stored value that does not conform falls back alone and is reported at its line', async () => {
	const s = await setup('{\n  "theme": "dark",\n  "size": "big"\n}\n');
	const reading = expectOk(await s.kv.get());
	expect(reading?.values).toEqual({ theme: 'dark' });
	expect(reading?.issues).toMatchObject([{ field: 'size', line: 3 }]);
});

test('an integer outside the safe range is an issue, not a rounded value', async () => {
	const s = await setup('{"size": 9007199254740993}');
	const reading = expectOk(await s.kv.get());
	expect(reading?.values).toEqual({});
	expect(reading?.issues).toMatchObject([{ field: 'size', line: 1 }]);
});

test('text that is not one strict JSON object, or has a key twice, is InvalidKv at its line', async () => {
	for (const [text, line] of [
		['{\n  "theme": "dark",\n  // a comment\n}\n', 3],
		['{\n  "theme": "dark"\n  "size": 1\n}\n', 3],
		['[1, 2]\n', 1],
		['{\n  "theme": "a",\n  "theme": "b"\n}\n', 3],
	] as const) {
		const s = await setup(text);
		const error = expectErr(await s.kv.get());
		expect(error).toMatchObject({
			name: 'InvalidKv',
			path: 'kv.json',
			text,
			sha256: await hashBytes(encoder.encode(text)),
		});
		if (error.name !== 'InvalidKv') continue;
		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]?.line).toBe(line);
	}
});

// -- Setting ------------------------------------------------------------------

test('set creates a missing file in the merge format and returns what it wrote', async () => {
	const s = await setup();
	const reading = expectOk(await s.kv.set('theme', 'dark'));
	expect(await s.source()).toBe('{\n  "theme": "dark"\n}\n');
	expect(reading).toEqual({
		path: 'kv.json',
		sha256: await hashBytes(encoder.encode('{\n  "theme": "dark"\n}\n')),
		values: { theme: 'dark' },
		issues: [],
	});
	expect(expectOk(await s.kv.get())).toEqual(reading);
});

test('set keeps every key it does not change as its raw text, valid or not', async () => {
	const s = await setup(
		'﻿{"size": 1.50, "zeta": [1,2], "theme": "light", "layout": {"b": 1, "a": 2}, "big": 9007199254740993}',
	);
	expectOk(await s.kv.set('theme', 'dark'));
	expect(await s.source()).toBe(
		'{\n  "big": 9007199254740993,\n  "layout": {"b": 1, "a": 2},\n  "size": 1.50,\n  "theme": "dark",\n  "zeta": [1,2]\n}\n',
	);
});

test('what set writes is what a merge of that file writes', async () => {
	const s = await setup('{"zeta": true, "size": 2}');
	expectOk(await s.kv.set('theme', 'dark'));
	const text = await s.source();
	expect(mergeKv({ base: text, ours: text, theirs: text })).toEqual({
		kind: 'merged',
		text,
	});
});

test('set with undefined removes the key, so the app default applies', async () => {
	const s = await setup('{"theme": "dark", "size": 2}');
	const reading = expectOk(await s.kv.set('theme', undefined));
	expect(await s.source()).toBe('{\n  "size": 2\n}\n');
	expect(reading.values).toEqual({ size: 2 });
});

test('a value that cannot be set is refused before anything is read', async () => {
	const s = await setup('{"theme": "light"}');
	const cases: [string, unknown][] = [
		['size', 'not a number'],
		['size', Number.NaN],
		['size', Number.MAX_SAFE_INTEGER + 2],
		['undeclared', 1],
		['__proto__', { polluted: true }],
		['layout', [1, undefined]],
	];
	for (const [key, value] of cases)
		expect(
			expectErr(await s.kv.set(key as 'size', value as number)),
		).toMatchObject({ name: 'InvalidValues' });
	expect(s.calls).toEqual({ reads: 0, applies: 0 });
	expect(await s.source()).toBe('{"theme": "light"}');
});

test('a value is owned at the call: changing it afterward changes nothing saved', async () => {
	const s = await setup();
	const layout = { panes: ['a'] };
	const pending = s.kv.set('layout', layout);
	layout.panes.push('b');
	expectOk(await pending);
	expect(expectOk(await s.kv.get())?.values.layout).toEqual({ panes: ['a'] });
	expect(Object.isFrozen(layout)).toBe(false);
});

test('sets from one handle land in the order they were called', async () => {
	const s = await setup('{}');
	const first = s.kv.set('theme', 'a');
	const second = s.kv.set('theme', 'ab');
	const third = s.kv.set('theme', 'abc');
	const size = s.kv.set('size', 3);
	expectOk(await first);
	expectOk(await second);
	expect(expectOk(await third).values).toEqual({ theme: 'abc', size: 3 });
	expectOk(await size);
	expect(expectOk(await s.kv.get())?.values).toEqual({
		theme: 'abc',
		size: 3,
	});
});

test('a set that loses a race merges by key, so both writers keep their keys', async () => {
	const s = await setup('{"theme": "light"}');
	s.afterNextReads(() => s.elsewhere('{"theme": "light", "size": 9}'));
	const reading = expectOk(await s.kv.set('theme', 'dark'));
	expect(reading.values).toEqual({ theme: 'dark', size: 9 });
	expect(await s.source()).toBe('{\n  "size": 9,\n  "theme": "dark"\n}\n');
});

test('a file that keeps changing past the merges is KeptChanging, and the other writer stays', async () => {
	const s = await setup('{"size": 0}');
	let n = 0;
	const write = () => s.elsewhere(`{"size": ${++n}}`);
	// Before the set's first save, and before each of its merges' saves.
	s.afterNextReads(write, write, write, write);
	expect(expectErr(await s.kv.set('theme', 'dark'))).toMatchObject({
		name: 'KeptChanging',
		attempts: WRITE_ATTEMPTS,
	});
	expect(await s.source()).toBe('{"size": 4}');
});

test('two creators of a missing file both keep their keys', async () => {
	const s = await setup();
	s.afterNextReads(async () => {
		expectOk(await s.files.create('kv.json', '{"size": 4}'));
	});
	expect(expectOk(await s.kv.set('theme', 'dark')).values).toEqual({
		theme: 'dark',
		size: 4,
	});
});

test('set refuses a file that cannot be read as settings, and writes nothing', async () => {
	const text = '{"theme": "a", // no\n}';
	const s = await setup(text);
	expect(expectErr(await s.kv.set('size', 1)).name).toBe('InvalidKv');
	expect(await s.source()).toBe(text);
});

test('text nested too deep is InvalidKv, and a set refused by it leaves the handle usable', async () => {
	const s = await setup(`{"layout": ${'['.repeat(100_000)}`);
	expect(expectErr(await s.kv.get()).name).toBe('InvalidKv');
	expect(expectErr(await s.kv.set('theme', 'a')).name).toBe('InvalidKv');
	await s.elsewhere('{}');
	expect(expectOk(await s.kv.set('theme', 'b')).values).toEqual({ theme: 'b' });
});

test('a key that appears twice at any depth is InvalidKv at the repeated key', async () => {
	const s = await setup('{\n  "layout": {\n    "a": 1,\n    "a": 2\n  }\n}\n');
	const error = expectErr(await s.kv.get());
	if (error.name !== 'InvalidKv') throw new Error(error.message);
	expect(error.issues).toEqual([
		{ message: 'The key "a" appears twice', line: 4, field: 'layout' },
	]);
});

test('a storage defect settles the set that hit it, and later sets still run', async () => {
	const base = (await rawBrowserFolder({ id: 'kv-defect' })).boundary;
	let fail = true;
	const kv = createKv<Values>(
		{
			storage: {
				...base,
				read(path) {
					if (fail) {
						fail = false;
						throw new Error('broken read');
					}
					return base.read(path);
				},
			},
		},
		definition.kv,
	);
	expect(expectErr(await kv.set('theme', 'a')).name).toBe('Io');
	expect(expectOk(await kv.set('theme', 'b')).values).toEqual({ theme: 'b' });
});

test('an Unconfirmed save is read again and re-applied, since a set does not depend on what was there', async () => {
	const base = (await rawBrowserFolder({ id: 'kv-unconfirmed' })).boundary;
	let lose = true;
	const kv = createKv<Values>(
		{
			storage: {
				...base,
				async put(path, bytes, ifMatch) {
					const result = await base.put(path, bytes, ifMatch);
					if (!lose) return result;
					lose = false;
					return FileError.Unconfirmed({
						path: 'kv.json',
						operation: 'publishing',
						cause: 'the reply was lost',
					});
				},
			},
		},
		definition.kv,
	);
	expect(expectOk(await kv.set('theme', 'dark')).values).toEqual({
		theme: 'dark',
	});
});

test('a stored value over the budget is an issue on read, as a set of it is refused', async () => {
	const wide = Object.fromEntries(
		Array.from({ length: 1_100 }, (_, i) => [`k${i}`, i]),
	);
	const s = await setup(JSON.stringify({ theme: 'dark', layout: wide }));
	const reading = expectOk(await s.kv.get());
	expect(reading?.values).toEqual({ theme: 'dark' });
	expect(reading?.issues).toMatchObject([{ field: 'layout' }]);
	expect(expectErr(await s.kv.set('layout', wide)).name).toBe('InvalidValues');
});

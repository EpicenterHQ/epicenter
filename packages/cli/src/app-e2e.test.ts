/**
 * The look at a page's private files that app end-to-end suites take
 * (`digestTree`, which `opfsFiles` runs in the page).
 *
 * The page's own writes run beside the walk, and a read a write lands on
 * fails with the same names (`NotFoundError` in WebKit, `NotReadableError`
 * in Chromium) a read of a file that went does. Whispering's first e2e step
 * failed under load in WebKit because its note, rewritten with its length
 * just after Stop, was left out of a listing while it was there.
 *
 * Key behaviors:
 * - A file a write landed on mid-read is read again and listed.
 * - A file that went mid-walk is left out.
 * - An unfinished file (a write's staged bytes) is never listed.
 */
import { expect, test } from 'bun:test';
import { digestTree } from './app-e2e.test-support.ts';

type FakeFile = { arrayBuffer(): Promise<ArrayBuffer> };
type Entry = { kind: 'file'; getFile(): Promise<FakeFile> } | FakeDirectory;
type FakeDirectory = {
	kind: 'directory';
	entries(): AsyncIterable<[string, Entry]>;
	getFileHandle(name: string): Promise<Entry>;
};

/** A directory over `children`; `getFileHandle` misses what is gone. */
function directory(children: Record<string, Entry>): FakeDirectory {
	return {
		kind: 'directory',
		async *entries() {
			yield* Object.entries(children);
		},
		async getFileHandle(name) {
			const child = children[name];
			if (child?.kind !== 'file')
				throw new DOMException(`${name} is not there`, 'NotFoundError');
			return child;
		},
	};
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
const file = (text: string): Entry => ({
	kind: 'file',
	getFile: async () => new Blob([bytesOf(text)]),
});
const sha256 = async (text: string) =>
	new Bun.CryptoHasher('sha256').update(bytesOf(text)).digest('hex');
const walk = (root: FakeDirectory) =>
	digestTree(root as unknown as FileSystemDirectoryHandle);

test('a file a write lands on while it is read is read again and listed', async () => {
	let reads = 0;
	const note: Entry = {
		kind: 'file',
		async getFile() {
			reads += 1;
			// WebKit: the snapshot taken before the write no longer reads.
			if (reads === 1)
				return {
					arrayBuffer: () =>
						Promise.reject(
							new DOMException(
								'The object can not be found here.',
								'NotFoundError',
							),
						),
				};
			return new Blob([bytesOf('durationMs: 1500')]);
		},
	};
	const files = await walk(
		directory({
			recordings: directory({ 'a.md': note, 'a.m4a': file('audio') }),
		}),
	);
	expect(files).toEqual({
		'recordings/a.md': await sha256('durationMs: 1500'),
		'recordings/a.m4a': await sha256('audio'),
	});
});

test('a file that went while the walk ran is left out', async () => {
	const children: Record<string, Entry> = { 'b.md': file('kept') };
	children['a.md'] = {
		kind: 'file',
		async getFile() {
			delete children['a.md'];
			throw new DOMException('gone', 'NotReadableError');
		},
	};
	const files = await walk(directory({ recordings: directory(children) }));
	expect(files).toEqual({ 'recordings/b.md': await sha256('kept') });
});

test('an unfinished file is not listed', async () => {
	const files = await walk(
		directory({
			notes: directory({
				'.lz0-0123456789abcdef0123456789abcdef-1.epicenter-pending':
					file('staged'),
				'.hidden.md': file('mine'),
			}),
			'notes.md': file('note'),
		}),
	);
	expect(files).toEqual({
		'notes.md': await sha256('note'),
		'notes/.hidden.md': await sha256('mine'),
	});
});

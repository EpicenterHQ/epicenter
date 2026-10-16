/**
 * Sync's Merge Commit, as Objects
 *
 * `chooseBase` and `mergeHistories` over commits written straight into a
 * browser folder's private repository: no files, index, or refs change.
 *
 * Key behaviors:
 * - Several merge bases, as hand-run merges leave, resolve to the newest by
 *   committer time, then the smallest object ID, so every host picks one
 * - A path one side changed keeps that side's blob; one both changed merges
 *   by kind with this device winning, each lost unit an override naming the
 *   losing head
 * - A rename on one side carries the other side's edit to the new path
 * - A file against a directory stands beside it as `~local` or `~remote`
 * - `epicenter.json` merges whole, and local paths are in no merge
 * - `mergeMessage` writes one `Overrode:` trailer per lost unit
 */
import { expect, test } from 'bun:test';
import * as isogit from 'isomorphic-git';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import { fileKindOf } from '../merge-file.js';
import { chooseBase, mergeHistories, mergeMessage } from './merge.js';
import {
	type ObjectAccess,
	readBlob,
	readTreeFiles,
	writeFilesTree,
} from './objects.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let folders = 0;

async function objects() {
	const raw = await rawBrowserFolder({ id: `merge-objects-${folders++}` });
	const backend = await raw.backend();
	return <T>(work: (access: ObjectAccess) => Promise<T>) =>
		backend.withObjects(work);
}

/** A commit of exactly `files` with `parents`, made at `time` (seconds). */
function commitOf(
	access: ObjectAccess,
	files: Record<string, string>,
	parents: string[],
	time: number,
) {
	return (async () => {
		const tree = await writeFilesTree(
			access,
			new Map(
				Object.entries(files).map(([path, text]) => [
					path,
					encoder.encode(text),
				]),
			),
		);
		const signature = {
			name: 'Test',
			email: 'test@example.test',
			timestamp: time,
			timezoneOffset: 0,
		};
		return isogit.writeCommit({
			...access,
			commit: {
				tree,
				parent: parents,
				author: signature,
				committer: signature,
				message: `At ${time}\n`,
			},
		});
	})();
}

async function treeText(access: ObjectAccess, tree: string) {
	const files = await readTreeFiles(access, tree);
	const out: Record<string, string> = {};
	for (const [path, entry] of files)
		out[path] = decoder.decode(await readBlob(access, entry.oid));
	return out;
}

const plain = () => ({ kind: 'file' }) as const;

test('several merge bases resolve to the newest, then the smallest object ID', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const root = await commitOf(access, { a: '0\n' }, [], 100);
		const x = await commitOf(access, { a: 'x\n' }, [root], 200);
		const y = await commitOf(access, { a: 'y\n' }, [root], 300);
		// A criss-cross: each side merged the other by hand.
		const ours = await commitOf(access, { a: 'x\n' }, [x, y], 400);
		const theirs = await commitOf(access, { a: 'y\n' }, [y, x], 400);
		expect(
			(await isogit.findMergeBase({ ...access, oids: [ours, theirs] }))
				.slice()
				.sort(),
		).toEqual([x, y].sort());
		expect(await chooseBase(access, ours, theirs)).toBe(y);
		expect(await chooseBase(access, theirs, ours)).toBe(y);

		// Committed at the same second, the smaller object ID.
		const p = await commitOf(access, { a: 'p\n' }, [root], 500);
		const q = await commitOf(access, { a: 'q\n' }, [root], 500);
		const left = await commitOf(access, { a: 'p\n' }, [p, q], 600);
		const right = await commitOf(access, { a: 'q\n' }, [q, p], 600);
		expect(await chooseBase(access, left, right)).toBe(p < q ? p : q);

		const alone = await commitOf(access, { b: '1\n' }, [], 100);
		expect(await chooseBase(access, ours, alone)).toBeUndefined();
	});
});

test('one-sided changes keep their blob, and competing ones go to this device', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const base = await commitOf(
			access,
			{
				'notes.md': 'one\ntwo\nthree\n',
				'only-ours': 'b\n',
				'only-theirs': 'b\n',
			},
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{
				'notes.md': 'ONE\ntwo\nmine\n',
				'only-ours': 'o\n',
				'only-theirs': 'b\n',
			},
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{
				'notes.md': 'one\ntwo\ntheirs\n',
				'only-ours': 'b\n',
				'only-theirs': 't\n',
			},
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			kindOf: plain,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			'notes.md': 'ONE\ntwo\nmine\n',
			'only-ours': 'o\n',
			'only-theirs': 't\n',
		});
		expect(merged.overrides).toEqual([
			{
				path: 'notes.md',
				unit: { kind: 'lines', part: 'text', line: 3, count: 1 },
				losing: theirs,
			},
		]);
		expect(mergeMessage('Merge', merged.overrides)).toBe(
			`Merge\n\nOverrode: ${theirs} lines=text:3+1 "notes.md"`,
		);
		expect(mergeMessage('Merge', [])).toBe('Merge');
	});
});

test("a rename carries the other side's edit to the new path", async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const row = '---\ntitle: Walk\ndone: false\n---\n';
		const base = await commitOf(access, { 'todos/walk.md': row }, [], 100);
		const ours = await commitOf(
			access,
			{ 'todos/stroll.md': row },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ 'todos/walk.md': row.replace('done: false', 'done: true') },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			kindOf: plain,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			'todos/stroll.md': '---\ntitle: Walk\ndone: true\n---\n',
		});
		expect(merged.overrides).toEqual([]);
	});
});

test('a file against a directory stands beside it, by the side it came from', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const base = await commitOf(access, { keep: 'k\n' }, [], 100);
		const ours = await commitOf(
			access,
			{ keep: 'k\n', a: 'mine\n', 'b/c': 'dir\n' },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ keep: 'k\n', 'a/b': 'dir\n', b: 'theirs\n' },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			kindOf: plain,
			isLocal: () => false,
		});
		expect(await treeText(access, merged.tree)).toEqual({
			keep: 'k\n',
			'a/b': 'dir\n',
			'a~local': 'mine\n',
			'b/c': 'dir\n',
			'b~remote': 'theirs\n',
		});
	});
});

test('epicenter.json merges whole, and local paths are in no merge', async () => {
	const withObjects = await objects();
	await withObjects(async (access) => {
		const declaration = (theme: string, size: string) =>
			`{\n\t"kv": {\n\t\t"theme": ${theme},\n\t\t"size": ${size}\n\t}\n}\n`;
		const base = await commitOf(
			access,
			{ 'epicenter.json': declaration('1', '1'), 'cache.db': 'base\n' },
			[],
			100,
		);
		const ours = await commitOf(
			access,
			{ 'epicenter.json': declaration('2', '1'), 'cache.db': 'ours\n' },
			[base],
			200,
		);
		const theirs = await commitOf(
			access,
			{ 'epicenter.json': declaration('1', '2'), 'cache.db': 'theirs\n' },
			[base],
			200,
		);
		const merged = await mergeHistories(access, {
			base,
			ours,
			theirs,
			kindOf: (path) => fileKindOf(undefined, path),
			isLocal: (path) => path.endsWith('.db'),
		});
		// Lines that did not compete would merge as text; the declaration
		// does not, and this device's whole file wins.
		expect(await treeText(access, merged.tree)).toEqual({
			'epicenter.json': declaration('2', '1'),
		});
		expect(merged.overrides).toEqual([
			{
				path: 'epicenter.json',
				unit: { kind: 'file', lost: 'theirs' },
				losing: theirs,
			},
		]);
	});
});

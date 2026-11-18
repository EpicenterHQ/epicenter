/**
 * The one conformance suite every `Files` passes: the five operations as
 * Whispering relies on them. It needs no test runner, so the same checks
 * run under `bun test` (`files.test.ts`: memory, and the desktop's over a
 * real directory) and in a browser against the Origin Private File System:
 *
 * ```js
 * const { runFilesChecks } = await import('/src/lib/files/conformance.ts');
 * const { opfsFiles } = await import('/src/lib/files/opfs.ts');
 * await runFilesChecks(() => opfsFiles(`conformance-${Date.now()}`));
 * ```
 *
 * Each check is given a fresh, empty `Files`.
 */
import type { Result } from 'wellcrafted/result';
import { decode, encode, type Files } from './files.js';

export type FilesCheck = {
	readonly name: string;
	run(files: Files): Promise<void>;
};

function fail(message: string): never {
	throw new Error(message);
}

/** The data of `result`, or a failure naming `what`. */
function ok<T, E extends { message: string }>(
	result: Result<T, E>,
	what: string,
): T {
	if (result.error !== null) fail(`${what} failed: ${result.error.message}`);
	return result.data as T;
}

function same(actual: unknown, expected: unknown, what: string) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) fail(`${what}: expected ${b}, got ${a}`);
}

/** The names a listing answers. */
const names = async (files: Files, dir: string) =>
	ok(await files.list(dir), `list ${dir}`).map(({ name }) => name);

const text = async (files: Files, path: string) => {
	const bytes = ok(await files.read(path), `read ${path}`);
	return bytes === null ? null : decode(bytes);
};

export const filesChecks: readonly FilesCheck[] = [
	{
		name: 'a file that is not there reads as null',
		async run(files) {
			same(await text(files, 'recordings/none.md'), null, 'read');
		},
	},
	{
		name: 'a write reads back byte for byte, its directories made',
		async run(files) {
			const bytes = new Uint8Array([0, 1, 2, 254, 255]);
			ok(await files.write('recordings/a/b.webm', bytes), 'write');
			same(
				[...(ok(await files.read('recordings/a/b.webm'), 'read') ?? [])],
				[...bytes],
				'bytes',
			);
		},
	},
	{
		name: 'a write replaces the file whole, longer or shorter',
		async run(files) {
			ok(
				await files.write('settings.md', encode('a long first text')),
				'write',
			);
			ok(await files.write('settings.md', encode('short')), 'write');
			same(await text(files, 'settings.md'), 'short', 'text');
			ok(
				await files.write('settings.md', encode('a longer text than before')),
				'write',
			);
			same(
				await text(files, 'settings.md'),
				'a longer text than before',
				'text',
			);
		},
	},
	{
		name: 'an empty file is a file',
		async run(files) {
			ok(await files.write('empty.md', new Uint8Array()), 'write');
			same(await text(files, 'empty.md'), '', 'text');
			same(await names(files, ''), ['empty.md'], 'list');
		},
	},
	{
		name: 'a caller changing its bytes after a write changes nothing kept',
		async run(files) {
			const bytes = encode('kept');
			ok(await files.write('a.md', bytes), 'write');
			bytes[0] = 0;
			same(await text(files, 'a.md'), 'kept', 'text');
		},
	},
	{
		name: 'a list names the files directly in a directory, sorted',
		async run(files) {
			for (const path of [
				'recordings/b.md',
				'recordings/a.md',
				'recordings/a.webm',
				'recordings/deep/c.md',
				'transcriptions/t.md',
				'settings.md',
			])
				ok(await files.write(path, encode(path)), `write ${path}`);
			same(
				await names(files, 'recordings'),
				['a.md', 'a.webm', 'b.md'],
				'recordings',
			);
			same(await names(files, ''), ['settings.md'], 'folder');
			same(await names(files, 'recordings/deep'), ['c.md'], 'nested');
		},
	},
	{
		name: 'a directory that is not there lists nothing',
		async run(files) {
			same(await names(files, 'transformations'), [], 'list');
		},
	},
	{
		name: 'a listing gives each file its size and when it changed',
		async run(files) {
			ok(await files.write('recordings/a.md', encode('four')), 'write');
			const [first] = ok(await files.list('recordings'), 'list');
			same(first?.size, 4, 'size');
			if (!(typeof first?.modifiedMs === 'number' && first.modifiedMs > 0))
				fail(`modifiedMs: ${first?.modifiedMs}`);
			ok(await files.write('recordings/a.md', encode('longer text')), 'write');
			const [second] = ok(await files.list('recordings'), 'list');
			same(second?.size, 11, 'size after a write');
		},
	},
	{
		name: 'readMany answers each file that is there, by path, and no other',
		async run(files) {
			ok(await files.write('recordings/a.md', encode('a')), 'write');
			ok(await files.write('transcriptions/b.md', encode('')), 'write');
			const read = ok(
				await files.readMany([
					'recordings/a.md',
					'recordings/none.md',
					'transcriptions/b.md',
				]),
				'readMany',
			);
			same(
				[...read].map(([path, bytes]) => [path, decode(bytes)]),
				[
					['recordings/a.md', 'a'],
					['transcriptions/b.md', ''],
				],
				'read',
			);
			same(ok(await files.readMany([]), 'readMany none').size, 0, 'none');
		},
	},
	{
		name: 'a removed file reads as null and leaves the list',
		async run(files) {
			ok(await files.write('recordings/a.md', encode('a')), 'write');
			ok(await files.write('recordings/b.md', encode('b')), 'write');
			ok(await files.remove('recordings/a.md'), 'remove');
			same(await text(files, 'recordings/a.md'), null, 'read');
			same(await names(files, 'recordings'), ['b.md'], 'list');
		},
	},
	{
		name: 'removing what is not there succeeds',
		async run(files) {
			ok(await files.remove('recordings/none.md'), 'remove');
			ok(await files.remove('none/none.md'), 'remove');
		},
	},
	{
		name: 'both id formats are plain names, and keep their case',
		async run(files) {
			for (const path of [
				'recordings/k3x9a2f8.md',
				'recordings/2026-10-30T22-41-05-123Z-k3x9a2f8.webm',
				'transformation_runs/Run_1.md',
			]) {
				ok(await files.write(path, encode(path)), `write ${path}`);
				same(await text(files, path), path, path);
			}
			same(
				await names(files, 'recordings'),
				['2026-10-30T22-41-05-123Z-k3x9a2f8.webm', 'k3x9a2f8.md'],
				'list',
			);
		},
	},
	{
		name: 'only plain names pass, and nothing else is written',
		async run(files) {
			for (const path of [
				'',
				'/abs.md',
				'../out.md',
				'a/../b.md',
				'a//b.md',
				'a/',
				'./a.md',
				'a\\b.md',
				'.hidden',
				'recordings/.ep-k3x9.save',
				'recordings/a.b.md',
				'recordings.d/a.md',
				'recordings/a take.md',
				'recordings/naïve.md',
			]) {
				const written = await files.write(path, encode('x'));
				if (written.error === null)
					fail(`write ${JSON.stringify(path)} was not refused`);
				same(written.error.name, 'Refused', `write ${JSON.stringify(path)}`);
				if ((await files.read(path)).error === null)
					fail(`read ${JSON.stringify(path)} was not refused`);
				if ((await files.readMany([path])).error === null)
					fail(`readMany ${JSON.stringify(path)} was not refused`);
				if ((await files.remove(path)).error === null)
					fail(`remove ${JSON.stringify(path)} was not refused`);
			}
			same(await names(files, ''), [], 'list');
			for (const dir of ['../', '.git', 'a.b'])
				if ((await files.list(dir)).error === null)
					fail(`list ${dir} was not refused`);
		},
	},
	{
		name: 'writes to many files at once all land',
		async run(files) {
			const paths = Array.from(
				{ length: 20 },
				(_, i) => `transcriptions/t${String(i).padStart(2, '0')}.md`,
			);
			const written = await Promise.all(
				paths.map((path) => files.write(path, encode(path))),
			);
			for (const result of written) ok(result, 'write');
			same(
				await names(files, 'transcriptions'),
				paths.map((path) => path.slice('transcriptions/'.length)),
				'list',
			);
			for (const path of paths) same(await text(files, path), path, path);
		},
	},
];

/**
 * Run every check, each over a fresh `Files` from `make`, and answer each
 * one's name with why it failed (null when it passed). For a browser, where
 * no test runner is.
 */
export async function runFilesChecks(
	make: () => Files | Promise<Files>,
): Promise<{ name: string; failure: string | null }[]> {
	const results: { name: string; failure: string | null }[] = [];
	for (const check of filesChecks) {
		try {
			await check.run(await make());
			results.push({ name: check.name, failure: null });
		} catch (cause) {
			results.push({
				name: check.name,
				failure: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
	return results;
}

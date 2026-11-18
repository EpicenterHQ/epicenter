/**
 * The conformance suite (`conformance.ts`) over `memoryFiles`, and over
 * `tauriFiles` talking to a stand-in for the shell's five commands on a
 * real directory, answering as the shell answers: raw bytes for reads, the
 * `files_read_many` buffer, and `{ name, message }` refusals. The shell's
 * own Rust tests check the commands themselves; `opfsFiles` runs the suite
 * in a browser (see `conformance.ts`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { filesChecks } from './conformance.js';
import { checkPath, isPlainName } from './files.js';
import { memoryFiles } from './memory.js';
import { type Invoke, readManyAnswer, tauriFiles } from './tauri.js';

describe('memoryFiles', () => {
	for (const check of filesChecks)
		test(check.name, () => check.run(memoryFiles()));
});

const refusal = (name: string, message: string) => ({ name, message });

/** The shell's file commands over Node's file system, for `tauriFiles` to call. */
function shellOver(): Invoke {
	const at = (folder: string, path: string) => {
		const checked = checkPath(path, { directory: path === '' });
		if (checked.error !== null) throw checked.error;
		return join(folder, ...checked.data);
	};
	const readOrNull = (path: string) =>
		nodeFs.readFile(path).then(
			(buffer) => new Uint8Array(buffer),
			() => null,
		);
	return async (command, args, options) => {
		if (command === 'files_write') {
			const headers = options?.headers ?? {};
			const folder = decodeURIComponent(headers['x-folder'] ?? '');
			const target = at(folder, decodeURIComponent(headers['x-path'] ?? ''));
			await nodeFs.mkdir(dirname(target), { recursive: true });
			await nodeFs.writeFile(target, args as Uint8Array);
			return null;
		}
		const { folder, path, paths, dir } = args as {
			folder: string;
			path: string;
			paths: string[];
			dir: string;
		};
		switch (command) {
			case 'files_read': {
				const bytes = await readOrNull(at(folder, path));
				if (bytes === null) throw refusal('NotFound', `${path} is not there`);
				return bytes.buffer;
			}
			case 'files_read_many': {
				const read = await Promise.all(
					paths.map((one) => readOrNull(at(folder, one))),
				);
				const body = read.flatMap((bytes) => (bytes ? [...bytes] : []));
				const head = new DataView(new ArrayBuffer(4 + 4 * read.length));
				head.setUint32(0, read.length, true);
				for (const [index, bytes] of read.entries())
					head.setUint32(4 + 4 * index, bytes?.length ?? 0xffff_ffff, true);
				return Uint8Array.from([...new Uint8Array(head.buffer), ...body])
					.buffer;
			}
			case 'files_list': {
				const directory = at(folder, dir);
				const entries = await nodeFs
					.readdir(directory, { withFileTypes: true })
					.catch(() => []);
				const listed = [];
				for (const entry of entries) {
					if (!entry.isFile() || !isPlainName(entry.name)) continue;
					const stat = await nodeFs.stat(join(directory, entry.name));
					listed.push({
						name: entry.name,
						size: stat.size,
						modifiedMs: Math.round(stat.mtimeMs),
					});
				}
				return listed.sort((a, b) => (a.name < b.name ? -1 : 1));
			}
			case 'files_remove':
				await nodeFs.rm(at(folder, path), { force: true });
				return null;
			default:
				throw new Error(`no command ${command}`);
		}
	};
}

const made: string[] = [];
afterAll(async () => {
	for (const dir of made)
		await nodeFs.rm(dir, { recursive: true, force: true });
});

describe('tauriFiles over the shell', () => {
	for (const check of filesChecks)
		test(check.name, async () => {
			const dir = await nodeFs.mkdtemp(join(tmpdir(), 'whispering-files-'));
			made.push(dir);
			await check.run(tauriFiles(join(dir, 'data'), shellOver()));
		});

	test('a refusal the shell answers keeps its name', async () => {
		const files = tauriFiles('/folder', async () => {
			throw refusal('Refused', '/folder is not a folder this app may use');
		});
		const listed = await files.list('recordings');
		expect(listed.error).toEqual({
			name: 'Refused',
			message: '/folder is not a folder this app may use',
		});
	});

	test('anything else the shell throws is Io', async () => {
		const files = tauriFiles('/folder', async () => {
			throw 'command files_list not allowed';
		});
		expect((await files.list('')).error?.name).toBe('Io');
	});
});

describe('the files_read_many buffer', () => {
	test('reads back each length in order, and skips a missing one', () => {
		const buffer = new Uint8Array([
			3, 0, 0, 0, 2, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 104, 105,
		]);
		const read = readManyAnswer(['a.md', 'b.md', 'c.md'], buffer);
		expect([...read.keys()]).toEqual(['a.md', 'c.md']);
		expect(new TextDecoder().decode(read.get('a.md'))).toBe('hi');
		expect(read.get('c.md')?.length).toBe(0);
	});

	test('a count that does not match what was asked is refused', () => {
		expect(() =>
			readManyAnswer(['a.md'], new Uint8Array([0, 0, 0, 0])),
		).toThrow();
	});
});

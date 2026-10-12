/**
 * Terminal filesystem conformance through real Just Bash commands.
 *
 * Browser and directory folders must preserve binary pipelines, reject
 * self-copy and recursive containment, distinguish mkdir from mkdir -p,
 * and retain empty directories when copying or moving trees.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import { testBrowserStorage } from './browser-storage.test-support.js';
import { openFolder as openDirectoryFolder } from './bun.js';
import { defineFolder, type Folder } from './contract.js';
import { scratch } from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';
import { createTerminal } from './terminal.js';

const definition = defineFolder({
	kv: {},
	tables: {},
});
const opened: Folder<typeof definition>[] = [];
const roots: string[] = [];
const author = { name: 'Terminal', email: 'terminal@example.test' };

async function open(backend: 'browser' | 'directory') {
	if (backend === 'browser') {
		const folder = expectOk(
			await openBrowserFolder({
				id: 'terminal-conformance',
				definition,
				browser: {
					author,
					...testBrowserStorage(),
				},
			}),
		);
		opened.push(folder);
		return folder;
	}
	const root = await scratch('terminal-conformance-');
	roots.push(root);
	const folder = expectOk(
		await openDirectoryFolder({
			root,
			definition,
			git: { author },
		}),
	);
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

for (const backend of ['browser', 'directory'] as const)
	describe(backend, () => {
		test('copy recognizes a missing destination and overwrites a distinct existing file', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.create('source.txt', 'source'));
			expectOk(await folder.files.create('existing.txt', 'existing'));
			const terminal = folder.terminal();
			expect(
				await terminal.exec(
					'cp source.txt new.txt && cp source.txt existing.txt',
				),
			).toEqual({ stdout: '', stderr: '', exitCode: 0 });
			for (const path of ['new.txt', 'existing.txt'])
				expect(expectOk(await folder.files.read(path)).bytes).toEqual(
					new TextEncoder().encode('source'),
				);
		});

		test('self-copy is refused and same-path move leaves the file unchanged', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.create('same.txt', 'retained'));
			const terminal = folder.terminal();
			const copied = await terminal.exec('cp same.txt ./same.txt');
			expect(copied.exitCode).toBe(1);
			expect(copied.stderr).toContain('same file');
			expect((await terminal.exec('mv same.txt ./same.txt')).exitCode).toBe(0);
			expect(expectOk(await folder.files.read('same.txt')).bytes).toEqual(
				new TextEncoder().encode('retained'),
			);
		});

		test('mkdir requires an existing parent while mkdir -p creates missing parents', async () => {
			const folder = await open(backend);
			const terminal = folder.terminal();
			const refused = await terminal.exec('mkdir absent/child');
			expect(refused.exitCode).toBe(1);
			expect(refused.stderr).toContain('No such file or directory');
			expect(expectOk(await folder.files.list()).directories).not.toContain(
				'absent',
			);
			expect(
				(await terminal.exec('mkdir -p absent/child && mkdir -p absent/child'))
					.exitCode,
			).toBe(0);
			expect(expectOk(await folder.files.list()).directories).toContain(
				'absent/child',
			);
			expectOk(await folder.files.create('file.txt', 'file'));
			expect((await terminal.exec('mkdir -p file.txt/child')).exitCode).toBe(1);
		});

		test('recursive copy preserves empty directories and rejects copying into itself', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.mkdir('source/empty/deep'));
			expectOk(await folder.files.create('source/data.txt', 'contents'));
			const terminal = folder.terminal();
			expect((await terminal.exec('cp -r source copied')).exitCode).toBe(0);
			expect(expectOk(await folder.files.list()).directories).toContain(
				'copied/empty/deep',
			);
			expect(
				expectOk(await folder.files.read('copied/data.txt')).bytes,
			).toEqual(new TextEncoder().encode('contents'));
			const refused = await terminal.exec('cp -r source source/inside');
			expect(refused.exitCode).toBe(1);
			expect(refused.stderr).toContain('into itself');
			expect(expectOk(await folder.files.list()).directories).not.toContain(
				'source/inside',
			);
		});

		test('moving an empty tree retains its directories at the destination', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.mkdir('source/empty/deep'));
			expect((await folder.terminal().exec('mv source moved')).exitCode).toBe(
				0,
			);
			const listing = expectOk(await folder.files.list());
			expect(listing.directories).toContain('moved/empty/deep');
			expect(listing.directories).not.toContain('source');
		});

		test('tee and tee -a preserve every byte supplied by cat', async () => {
			const folder = await open(backend);
			const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
			expectOk(await folder.files.create('raw.bin', bytes));
			expect(
				(
					await folder
						.terminal()
						.exec(
							'cat raw.bin | tee copied.bin >/dev/null && cat raw.bin | tee -a copied.bin >/dev/null',
						)
				).exitCode,
			).toBe(0);
			expect(expectOk(await folder.files.read('copied.bin')).bytes).toEqual(
				new Uint8Array([...bytes, ...bytes]),
			);
		});
		test('redirection preserves non-ASCII text and all binary byte values', async () => {
			const folder = await open(backend);
			const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
			expectOk(await folder.files.create('raw.bin', bytes));
			const terminal = folder.terminal();
			expect(
				(
					await terminal.exec(
						"cat raw.bin > copy.bin && cat raw.bin >> copy.bin && printf 'café' > text.txt && cat text.txt > text-copy.txt",
					)
				).exitCode,
			).toBe(0);
			expect(expectOk(await folder.files.read('copy.bin')).bytes).toEqual(
				new Uint8Array([...bytes, ...bytes]),
			);
			expect(expectOk(await folder.files.read('text-copy.txt')).bytes).toEqual(
				new TextEncoder().encode('café'),
			);
		});

		test('move and recursive removal retire observations before recreating old paths', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.create('a.txt', 'old'));
			expectOk(await folder.files.create('dir/a.txt', 'old'));
			const terminal = folder.terminal();
			expect(
				(await terminal.exec('cat a.txt && mv a.txt b.txt && echo new > a.txt'))
					.exitCode,
			).toBe(0);
			expect(
				(
					await terminal.exec(
						'cat dir/a.txt && rm -r dir && mkdir dir && echo new > dir/a.txt',
					)
				).exitCode,
			).toBe(0);
			for (const path of ['a.txt', 'dir/a.txt'])
				expect(expectOk(await folder.files.read(path)).bytes).toEqual(
					new TextEncoder().encode('new\n'),
				);
		});

		test('moving onto an existing file preserves both files and reports the refusal', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.create('a.txt', 'first'));
			expectOk(await folder.files.create('b.txt', 'second'));
			expect((await folder.terminal().exec('mv a.txt b.txt')).exitCode).toBe(1);
			expect(expectOk(await folder.files.read('a.txt')).bytes).toEqual(
				new TextEncoder().encode('first'),
			);
			expect(expectOk(await folder.files.read('b.txt')).bytes).toEqual(
				new TextEncoder().encode('second'),
			);
		});

		test('stat reports permissions without file-type bits and missing errors are recognized', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.create('a.txt', 'file'));
			expectOk(await folder.files.mkdir('dir'));
			const terminal = folder.terminal();
			expect((await terminal.exec("stat -c '%a' a.txt dir")).stdout).toBe(
				'644\n755\n',
			);
			for (const command of [
				'cp missing.txt copy.txt',
				'rm missing.txt',
				'stat missing.txt',
			]) {
				const result = await terminal.exec(command);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain('No such file or directory');
			}
		});
		test('directory moves refuse an occupied resolved destination without merging trees', async () => {
			const folder = await open(backend);
			expectOk(await folder.files.create('source/a.txt', 'source'));
			expectOk(await folder.files.create('target/source/b.txt', 'foreign'));
			expect((await folder.terminal().exec('mv source target')).exitCode).toBe(
				1,
			);
			expect(expectOk(await folder.files.read('source/a.txt')).bytes).toEqual(
				new TextEncoder().encode('source'),
			);
			expect(
				expectOk(await folder.files.read('target/source/b.txt')).bytes,
			).toEqual(new TextEncoder().encode('foreign'));
			expect(
				expectOk(await folder.files.list()).files.map((file) => file.path),
			).not.toContain('target/source/a.txt');
		});
	});

test('a directory move leaves a file another writer adds after its source snapshot', async () => {
	const folder = await open('directory');
	const root = roots.at(-1)!;
	expectOk(await folder.files.create('source/original.txt', 'original'));
	const base = createNativeFileBoundary(root);
	let injected = false;
	let reads = 0;
	const terminal = createTerminal({
		git: folder.git,
		storage: {
			...base,
			async read(path) {
				reads++;
				return base.read(path);
			},
			async mkdir(path) {
				const result = await base.mkdir(path);
				if (path === 'moved' && !injected) {
					injected = true;
					expectOk(
						await folder.files.create('source/late.txt', 'late arrival'),
					);
				}
				return result;
			},
		},
	});
	const result = await terminal.exec('mv source moved');
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain('not empty');
	expect(reads).toBe(0);
	expect(expectOk(await folder.files.read('moved/original.txt')).bytes).toEqual(
		new TextEncoder().encode('original'),
	);
	expect(expectOk(await folder.files.read('source/late.txt')).bytes).toEqual(
		new TextEncoder().encode('late arrival'),
	);
	expect(
		expectOk(await folder.files.list()).files.map((file) => file.path),
	).not.toContain('moved/late.txt');
});

test('directory enumeration and stat share the inventory until the next command refresh', async () => {
	const folder = await open('directory');
	const root = roots.at(-1)!;
	expectOk(await folder.files.create('source/original.txt', 'original'));
	const base = createNativeFileBoundary(root);
	let injected = false;
	const terminal = createTerminal({
		git: folder.git,
		storage: {
			...base,
			async list() {
				const result = await base.list();
				if (!injected) {
					injected = true;
					expectOk(
						await folder.files.create('source/late.txt', 'late arrival'),
					);
				}
				return result;
			},
			async children() {
				throw new Error('Enumeration must use the same inventory as stat.');
			},
		},
	});
	expect(await terminal.exec('ls source')).toEqual({
		stdout: 'original.txt\n',
		stderr: '',
		exitCode: 0,
	});
	expect(await terminal.exec('ls source')).toEqual({
		stdout: 'late.txt\noriginal.txt\n',
		stderr: '',
		exitCode: 0,
	});
});

test('a partial native move refreshes landed paths before the next shell statement', async () => {
	const folder = await open('directory');
	const root = roots.at(-1)!;
	expectOk(await folder.files.create('source/a.txt', 'original a'));
	expectOk(await folder.files.create('source/b.txt', 'original b'));
	const base = createNativeFileBoundary(root);
	const terminal = createTerminal({
		git: folder.git,
		storage: {
			...base,
			async mkdir(path) {
				const result = await base.mkdir(path);
				if (path === 'moved')
					expectOk(await folder.files.create('moved/b.txt', 'foreign'));
				return result;
			},
		},
	});
	const result = await terminal.exec('mv source moved; ls moved');
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toContain('mv:');
	expect(result.stderr).not.toContain('ls:');
	expect(result.stdout).toBe('a.txt\nb.txt\n');
	expect(expectOk(await folder.files.read('moved/a.txt')).bytes).toEqual(
		new TextEncoder().encode('original a'),
	);
	expect(expectOk(await folder.files.read('moved/b.txt')).bytes).toEqual(
		new TextEncoder().encode('foreign'),
	);
	expect(expectOk(await folder.files.read('source/b.txt')).bytes).toEqual(
		new TextEncoder().encode('original b'),
	);
});

test('append reads a newcomer rather than overwriting it and skips the empty opening save', async () => {
	const folder = await open('directory');
	const root = roots.at(-1)!;
	const base = createNativeFileBoundary(root);
	let injected = false;
	let applies = 0;
	const terminal = createTerminal({
		git: folder.git,
		storage: {
			...base,
			async list() {
				const result = await base.list();
				if (!injected) {
					injected = true;
					expectOk(await folder.files.create('late.txt', 'other writer\n'));
				}
				return result;
			},
			async apply(changes) {
				applies++;
				return base.apply(changes);
			},
		},
	});
	expect((await terminal.exec('echo appended >> late.txt')).exitCode).toBe(0);
	expect(expectOk(await folder.files.read('late.txt')).bytes).toEqual(
		new TextEncoder().encode('other writer\nappended\n'),
	);
	expect(applies).toBe(1);
});

test('append exclusively creates a missing file and preserves a competing create', async () => {
	const folder = await open('directory');
	const root = roots.at(-1)!;
	const base = createNativeFileBoundary(root);
	let injected = false;
	const terminal = createTerminal({
		git: folder.git,
		storage: {
			...base,
			async read(path) {
				const result = await base.read(path);
				if (
					!injected &&
					path === 'late.txt' &&
					result.error?.name === 'NotFound'
				) {
					injected = true;
					expectOk(await folder.files.create('late.txt', 'other writer'));
				}
				return result;
			},
		},
	});
	await expect(terminal.exec('echo appended >> late.txt')).rejects.toThrow(
		'EEXIST',
	);
	expect(expectOk(await folder.files.read('late.txt')).bytes).toEqual(
		new TextEncoder().encode('other writer'),
	);
});

test('a failed source cleanup retires removed children before the next listing', async () => {
	const folder = await open('directory');
	const root = roots.at(-1)!;
	expectOk(await folder.files.mkdir('source/empty'));
	expectOk(await folder.files.create('source/a.txt', 'source'));
	const base = createNativeFileBoundary(root);
	const terminal = createTerminal({
		git: folder.git,
		storage: {
			...base,
			async mkdir(path) {
				const result = await base.mkdir(path);
				if (path === 'moved')
					expectOk(await folder.files.create('source/late.txt', 'late'));
				return result;
			},
		},
	});
	const result = await terminal.exec('mv source moved; ls source');
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toContain('mv:');
	expect(result.stdout).toBe('late.txt\n');
	expect(expectOk(await folder.files.list()).directories).not.toContain(
		'source/empty',
	);
});

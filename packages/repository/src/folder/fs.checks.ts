/**
 * The folder port's conformance checks: what every `FolderFs` promises, as
 * plain async functions that throw on the first broken promise, run under
 * `bun test` (`fs.test.ts`) against the memory and Bun adapters. Each check
 * gets a fresh, empty folder, and an outside writer (an editor, a shell)
 * that changes it without the port.
 */
import type { FolderFs } from './fs.js';

/** Changes made to the folder from outside the engine. */
export type Outside = {
	write(path: string, text: string): Promise<void>;
	symlink(path: string, target: string): Promise<void>;
	text(path: string): Promise<string | null>;
};

const blob = (text: string) => new Blob([text]);
const textOf = async (bytes: Blob | null) => (bytes === null ? null : await bytes.text());
function check(condition: boolean, what: string) {
	if (!condition) throw new Error(`FolderFs check failed: ${what}`);
}
async function collect(fs: FolderFs, skip: (path: string) => boolean = () => false) {
	const found: string[] = [];
	for await (const entry of fs.walk('', skip)) found.push(`${entry.kind} ${entry.path}`);
	return found.sort();
}

export const FOLDER_FS_CHECKS: Record<string, (fs: FolderFs, outside: Outside) => Promise<void>> = {
	'replace on an empty path writes the bytes and displaces nothing': async (fs, outside) => {
		const done = await fs.replace('notes/a.md', blob('one'), { scratch: 'd-1' });
		check(done.error === null && done.data.written && done.data.displaced === null && done.data.entry?.size === 3, 'written, nothing displaced');
		check((await outside.text('notes/a.md')) === 'one', 'the bytes are there');
	},
	'replace over a file captures what was there, which stays until dropped': async (fs, outside) => {
		await outside.write('a.md', 'theirs');
		const done = await fs.replace('a.md', blob('mine'), { scratch: 'd-1' });
		check(done.error === null && done.data.written && done.data.displaced === 'd-1', 'captured to d-1');
		check((await outside.text('a.md')) === 'mine', 'the new bytes are there');
		check((await textOf((await fs.readScratch('d-1'))?.bytes ?? null)) === 'theirs', 'the captured bytes are readable');
		check((await fs.scratches()).includes('d-1'), 'listed until dropped');
		await fs.drop('d-1');
		check((await fs.readScratch('d-1')) === null && !(await fs.scratches()).includes('d-1'), 'gone once dropped');
	},
	'remove captures the file and leaves the path empty': async (fs, outside) => {
		await outside.write('a.png', 'bytes');
		const done = await fs.remove('a.png', { scratch: 'd-2' });
		check(done.error === null && done.data === 'd-2', 'captured');
		check((await fs.stat('a.png')) === null, 'absent');
		check((await textOf((await fs.readScratch('d-2'))?.bytes ?? null)) === 'bytes', 'readable in scratch');
		const nothing = await fs.remove('a.png', { scratch: 'd-3' });
		check(nothing.error === null && nothing.data === null, 'nothing to capture');
	},
	'restore puts a captured file back only where the path is empty': async (fs, outside) => {
		await outside.write('a.md', 'one');
		await fs.remove('a.md', { scratch: 'd-1' });
		check(await fs.restore('d-1', 'a.md'), 'restored');
		check((await outside.text('a.md')) === 'one', 'its bytes are back');
		await fs.remove('a.md', { scratch: 'd-2' });
		await outside.write('a.md', 'new');
		check(!(await fs.restore('d-2', 'a.md')), 'not over a file that came meanwhile');
		check((await outside.text('a.md')) === 'new', 'that file stays');
	},
	'walk lists files and directories, skips what it is told to, and reports a symlink without following it': async (fs, outside) => {
		await outside.write('notes/a.md', 'a');
		await outside.write('notes/deep/b.md', 'b');
		await outside.write('.hidden/c.md', 'c');
		await outside.symlink('link.md', 'notes/a.md');
		const all = await collect(fs, (path) => path.split('/').some((segment) => segment.startsWith('.')));
		check(JSON.stringify(all) === JSON.stringify(['directory notes', 'directory notes/deep', 'file notes/a.md', 'file notes/deep/b.md', 'symlink link.md']), `walk found ${JSON.stringify(all)}`);
		check((await fs.read('link.md')) === null, 'a symlink is not read');
		const under = [];
		for await (const found of fs.walk('notes', () => false)) under.push(found.path);
		check(JSON.stringify(under.sort()) === JSON.stringify(['notes/a.md', 'notes/deep', 'notes/deep/b.md']), `walk under notes found ${JSON.stringify(under)}`);
		const entry = await fs.stat('notes/a.md');
		check(entry?.kind === 'file' && entry.size === 1 && entry.ino > 0, 'stat reports a file with its size and inode');
	},
};

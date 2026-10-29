/**
 * Tree Tests
 *
 * Key behaviors:
 * - A folder lists the folders and files directly in it; a folder exists only as the prefix of a file under it
 * - Files' path names the root, a folder (trailing `/`) or a file, each segment encoded
 * - A new path is refused when a file or folder is already there, by any spelling
 */
import { expect, test } from 'bun:test';
import type { FileEntry } from '@epicenter/repository';
import { folderOfPath, listingOf, newPathProblem, parentOf, pathOfFolder } from './tree.js';

const synced = (path: string): FileEntry => ({ path, state: { status: 'synced' } });
const FILES = ['README.md', 'notes/a.md', 'notes/deep/b.md', 'todos/milk.md', 'notes/z.md'].map(synced);

test('a folder lists the folders and files directly in it', () => {
	expect(listingOf(FILES, '')).toEqual({ folders: ['notes', 'todos'], files: [synced('README.md')] });
	expect(listingOf(FILES, 'notes')).toEqual({ folders: ['deep'], files: [synced('notes/a.md'), synced('notes/z.md')] });
	expect(listingOf(FILES, 'notes/deep')).toEqual({ folders: [], files: [synced('notes/deep/b.md')] });
	expect(listingOf(FILES, 'nothing')).toEqual({ folders: [], files: [] });
	expect(parentOf('notes/deep/b.md')).toBe('notes/deep');
	expect(parentOf('README.md')).toBe('');
});

test("Files' path names the root, a folder, or a file", () => {
	expect(folderOfPath('/')).toBe('');
	expect(folderOfPath('/notes/deep/')).toBe('notes/deep');
	expect(folderOfPath('/a%20b/')).toBe('a b');
	expect(folderOfPath('/notes/a.md')).toBeUndefined();
	expect(pathOfFolder('')).toBe('/');
	expect(pathOfFolder('a b/c')).toBe('/a%20b/c/');
	expect(folderOfPath(pathOfFolder('a b/c'))).toBe('a b/c');
});

test('a new path is refused when a file or folder is already there, by any spelling', () => {
	expect(newPathProblem(FILES, 'notes/new.md')).toBeUndefined();
	expect(newPathProblem(FILES, 'Notes/A.md')).toBe('A file is already at Notes/A.md.');
	expect(newPathProblem(FILES, 'notes/deep')).toBe('A folder is already at notes/deep.');
	expect(newPathProblem(FILES, '')).toBe('Enter a name.');
	expect(newPathProblem(FILES, 'notes/')).toBe('Enter a name.');
	expect(newPathProblem(FILES, '/x.md')).toContain('cannot start with /');
});

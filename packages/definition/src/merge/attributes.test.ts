/**
 * Attributes Tests
 *
 * `storedAsPointer` is the rule `ATTRIBUTES` writes for Git: what the
 * receiver requires to be an LFS pointer. `sync.e2e.test.ts` in the CLI
 * checks Git reads the block the same way (`git check-attr`).
 *
 * Key behaviors:
 * - Every file that is not a `.md` note is a pointer
 * - A note never is
 * - A hidden path is exempt at any depth: a dotfile or anything under a dot directory
 */
import { expect, test } from 'bun:test';
import { storedAsPointer } from './attributes.js';

test('every file that is not a note is a pointer', () => {
	for (const path of ['recordings/a.webm', 'a.json', 'notes/photo.JPG', 'x'])
		expect(storedAsPointer(path)).toBe(true);
});

test('a note never is', () => {
	for (const path of ['a.md', 'notes/meeting notes.md'])
		expect(storedAsPointer(path)).toBe(false);
});

test('a hidden path is exempt at any depth', () => {
	for (const path of [
		'.gitattributes',
		'.gitignore',
		'sub/.gitignore',
		'.obsidian/workspace.json',
		'sub/.trash/a.webm',
	])
		expect(storedAsPointer(path)).toBe(false);
});

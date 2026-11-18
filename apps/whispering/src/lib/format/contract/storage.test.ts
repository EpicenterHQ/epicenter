import { describe, expect, test } from 'bun:test';
import { isHiddenPath, isNotePath } from './storage.js';

describe('decision 3 with decision 58', () => {
	test('a hidden path is any path with a segment starting with a dot', () => {
		expect(isHiddenPath('.DS_Store')).toBe(true);
		expect(isHiddenPath('recordings/.cache/a.webm')).toBe(true);
		expect(isHiddenPath('recordings/a.webm')).toBe(false);
		expect(isHiddenPath('recordings/a.b.webm')).toBe(false);
	});

	test('a note is any path ending in .md, in any case', () => {
		expect(isNotePath('a.md')).toBe(true);
		expect(isNotePath('notes/Shout.MD')).toBe(true);
		expect(isNotePath('notes/mixed.Md')).toBe(true);
		expect(isNotePath('notes/a.mdx')).toBe(false);
		expect(isNotePath('notes/md')).toBe(false);
		expect(isNotePath('a.markdown')).toBe(false);
	});
});

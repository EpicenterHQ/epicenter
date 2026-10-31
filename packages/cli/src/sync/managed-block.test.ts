/**
 * Managed Block Tests
 *
 * Key behaviors:
 * - A folder without the file gets exactly Epicenter's block
 * - A person's lines stay; the block goes after them, so it overrides them
 * - A block already present is replaced in place, and lines after it stay
 * - Writing the block twice changes nothing
 * - The file the server writes in a repository's first commit is already the block
 * - The same markers hold the `.gitignore` block, which ignores `.DS_Store` and `.epicenter/`
 */
import { expect, test } from 'bun:test';
import {
	REPOSITORY_ATTRIBUTES,
	REPOSITORY_IGNORE,
} from '@epicenter/definition/contract';
import { withEpicenterBlock } from './managed-block.ts';

const withAttributes = (current: string | null) =>
	withEpicenterBlock(current, REPOSITORY_ATTRIBUTES);

test('no file gets exactly the block', () => {
	expect(withAttributes(null)).toBe(REPOSITORY_ATTRIBUTES);
	expect(withAttributes('')).toBe(REPOSITORY_ATTRIBUTES);
});

test("a person's lines stay before the block, a missing final newline added", () => {
	expect(withAttributes('*.txt text')).toBe(
		`*.txt text\n${REPOSITORY_ATTRIBUTES}`,
	);
});

test('a stale block is replaced in place, and the lines around it stay', () => {
	const stale =
		'*.txt text\n# BEGIN epicenter (old)\n* filter=lfs\n# END epicenter\n*.csv diff\n';
	expect(withAttributes(stale)).toBe(
		`*.txt text\n${REPOSITORY_ATTRIBUTES}*.csv diff\n`,
	);
});

test('writing the block twice changes nothing', () => {
	const once = withAttributes('*.txt text\n');
	expect(withAttributes(once)).toBe(once);
});

test("the server's first-commit .gitattributes is recognized as the block", () => {
	expect(withAttributes(REPOSITORY_ATTRIBUTES)).toBe(REPOSITORY_ATTRIBUTES);
});

test("the .gitignore block ignores .DS_Store and .epicenter/, beside a person's own lines", () => {
	expect(REPOSITORY_IGNORE).toContain('\n.DS_Store\n');
	expect(REPOSITORY_IGNORE).toContain('\n.epicenter/\n');
	const ignore = withEpicenterBlock('node_modules/\n', REPOSITORY_IGNORE);
	expect(ignore).toBe(`node_modules/\n${REPOSITORY_IGNORE}`);
	expect(withEpicenterBlock(ignore, REPOSITORY_IGNORE)).toBe(ignore);
});

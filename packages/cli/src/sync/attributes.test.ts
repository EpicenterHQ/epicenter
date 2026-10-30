/**
 * Attributes Block Tests
 *
 * Key behaviors:
 * - A folder without `.gitattributes` gets exactly Epicenter's block
 * - A person's lines stay; the block goes after them, so it overrides them
 * - A block already present is replaced in place, and lines after it stay
 * - Writing the block twice changes nothing
 * - The file the server writes in a repository's first commit is already the block
 */
import { expect, test } from 'bun:test';
import { REPOSITORY_ATTRIBUTES } from '@epicenter/definition/contract';
import { withAttributesBlock } from './attributes.ts';

test('no file gets exactly the block', () => {
	expect(withAttributesBlock(null)).toBe(REPOSITORY_ATTRIBUTES);
	expect(withAttributesBlock('')).toBe(REPOSITORY_ATTRIBUTES);
});

test("a person's lines stay before the block, a missing final newline added", () => {
	expect(withAttributesBlock('*.txt text')).toBe(
		`*.txt text\n${REPOSITORY_ATTRIBUTES}`,
	);
});

test('a stale block is replaced in place, and the lines around it stay', () => {
	const stale =
		'*.txt text\n# BEGIN epicenter (old)\n* filter=lfs\n# END epicenter\n*.csv diff\n';
	expect(withAttributesBlock(stale)).toBe(
		`*.txt text\n${REPOSITORY_ATTRIBUTES}*.csv diff\n`,
	);
});

test('writing the block twice changes nothing', () => {
	const once = withAttributesBlock('*.txt text\n');
	expect(withAttributesBlock(once)).toBe(once);
});

test("the server's first-commit .gitattributes is recognized as the block", () => {
	expect(withAttributesBlock(REPOSITORY_ATTRIBUTES)).toBe(
		REPOSITORY_ATTRIBUTES,
	);
});

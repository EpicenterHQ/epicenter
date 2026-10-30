/**
 * Attributes Block Tests
 *
 * Key behaviors:
 * - A folder without `.gitattributes` gets exactly Epicenter's block
 * - A person's lines stay; the block goes after them, so it overrides them
 * - A block already present is replaced in place, and lines after it stay
 * - Writing the block twice changes nothing
 */
import { expect, test } from 'bun:test';
import { ATTRIBUTES_BLOCK, withAttributesBlock } from './attributes.ts';

test('no file gets exactly the block', () => {
	expect(withAttributesBlock(null)).toBe(ATTRIBUTES_BLOCK);
	expect(withAttributesBlock('')).toBe(ATTRIBUTES_BLOCK);
});

test("a person's lines stay before the block, a missing final newline added", () => {
	expect(withAttributesBlock('*.txt text')).toBe(
		`*.txt text\n${ATTRIBUTES_BLOCK}`,
	);
});

test('a stale block is replaced in place, and the lines around it stay', () => {
	const stale =
		'*.txt text\n# BEGIN epicenter (old)\n* filter=lfs\n# END epicenter\n*.csv diff\n';
	expect(withAttributesBlock(stale)).toBe(
		`*.txt text\n${ATTRIBUTES_BLOCK}*.csv diff\n`,
	);
});

test('writing the block twice changes nothing', () => {
	const once = withAttributesBlock('*.txt text\n');
	expect(withAttributesBlock(once)).toBe(once);
});

/**
 * Attribute Filter Scan Tests
 *
 * `declaredFilter` decides which attribute files make Sync refuse a tree and
 * a native checkpoint refuse a folder. It reads lines, not patterns, so a
 * line that assigns `filter` refuses whether or not its pattern selects a
 * file, and nothing else refuses.
 *
 * Key behaviors:
 * - A line that sets `filter` or gives it a value is found, in a macro too,
 *   after a quoted pattern too, and the first by path then line is named
 * - Unsetting or unspecifying `filter`, comments, and line-ending attributes
 *   are not
 * - An attribute file is one named `.gitattributes` in any directory, in any
 *   spelling
 *
 * See also:
 * - `../incoming-attributes.test.ts` for Sync's refusal of such a tree
 */
import { expect, test } from 'bun:test';
import { declaredFilter, isAttributesPath } from './attributes.js';

const encoder = new TextEncoder();
const scan = (files: Record<string, string>) =>
	declaredFilter(
		Object.entries(files).map(
			([path, text]) => [path, encoder.encode(text)] as const,
		),
	);

test('a line that sets filter or gives it a value is found, wherever its pattern points', () => {
	for (const line of [
		'*.wav filter=lfs diff=lfs merge=lfs -text',
		'never-matches-anything.bin filter',
		'[attr]lfs filter=lfs diff=lfs',
		'"a name with spaces.wav"\tfilter=lfs',
		'  *.wav   filter=   ',
	])
		expect([line, scan({ '.gitattributes': `# audio\n${line}\r\n` })]).toEqual([
			line,
			{ path: '.gitattributes', line: 2, text: line.trim() },
		]);
});

test('unset or unspecified filters, comments, and line-ending attributes are not filters', () => {
	expect(
		scan({
			'.gitattributes': [
				'# *.wav filter=lfs',
				'*.wav -filter',
				'*.wav !filter',
				'* text=auto eol=lf',
				'*.md text eol=crlf crlf ident working-tree-encoding=UTF-16',
				'"filter=lfs" -text',
				'filtered.txt filters=no',
				'',
			].join('\n'),
		}),
	).toBeUndefined();
});

test('the first filter by path, then by line, is named', () => {
	expect(
		scan({
			'rec/.gitattributes': '*.wav filter=lfs\n',
			'.gitattributes': '* text=auto\n*.png filter=lfs\n*.jpg filter=lfs\n',
		}),
	).toEqual({ path: '.gitattributes', line: 2, text: '*.png filter=lfs' });
});

test('an attribute file is .gitattributes in any directory and spelling', () => {
	for (const path of [
		'.gitattributes',
		'rec/nested/.gitattributes',
		'.GitAttributes',
	])
		expect([path, isAttributesPath(path)]).toEqual([path, true]);
	for (const path of [
		'gitattributes',
		'rec/.gitattributes.bak',
		'.gitattributes/x',
	])
		expect([path, isAttributesPath(path)]).toEqual([path, false]);
});

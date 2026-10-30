/**
 * Note Text Tests
 *
 * The text a list shows for a note: its preview and the name a person sees.
 */
import { expect, test } from 'bun:test';
import { displayTitle, previewText } from './note-source.js';

test('a preview is plain text without Markdown markers', () => {
	expect(previewText('# Title\n\n- [x] **done** item\n> quoted `code`\n')).toBe(
		'Title done item quoted code',
	);
	expect(displayTitle('', '\n## From the body\n')).toBe('From the body');
	expect(displayTitle('Named', 'body')).toBe('Named');
	expect(displayTitle(undefined, '')).toBe('Untitled');
});

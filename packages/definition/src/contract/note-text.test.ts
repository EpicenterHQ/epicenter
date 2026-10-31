/**
 * A note as text, both ways.
 *
 * Key behaviors:
 * - `noteText` writes a note as read in house style: declared fields first,
 *   other keys sorted, placeholders and version left out, the body as is
 * - `readNoteText` accepts what `replace` accepts and refuses, with every
 *   issue, front matter that does not parse or fields that do not fit
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { NoteOf, Version } from './client.js';
import { defineContract } from './contract.js';
import { noteText, readNoteText } from './note-text.js';

const contract = defineContract({
	name: 'capture',
	collections: {
		captures: {
			path: 'captures/{id}.md',
			fields: {
				title: { type: 'string' },
				capturedAt: { type: 'string', format: 'date-time' },
			},
			required: ['capturedAt'],
		},
	},
});
const captures = contract.collections.captures;
type Capture = NoteOf<typeof captures>;

test('noteText writes a note as read in house style, without its placeholders and version', () => {
	const note = {
		id: 'one',
		zeta: 'last',
		capturedAt: '2026-10-01T10:30:00+08:00',
		alpha: ['a', 'b'],
		body: 'Text\n',
		version: 'v1' as Version,
	} as Capture;
	expect(expectOk(noteText(captures, note))).toBe(
		'---\ncapturedAt: "2026-10-01T10:30:00+08:00"\nalpha:\n  - a\n  - b\nzeta: last\n---\nText\n',
	);
});

test('readNoteText reads what replace accepts', () => {
	expect(
		expectOk(
			readNoteText(
				captures,
				'---\ncapturedAt: 2026-10-01T02:30:00Z\nsource: phone\n---\nBody\n',
			),
		),
	).toEqual({
		fields: { capturedAt: '2026-10-01T02:30:00Z', source: 'phone' },
		body: 'Body\n',
	});
});

test('readNoteText refuses front matter that does not parse, or fields that do not fit, with every issue', () => {
	const unparsed = expectErr(
		readNoteText(captures, '---\ncapturedAt: [nope\n---\nBody\n'),
	);
	expect(unparsed.name).toBe('Invalid');
	expect(unparsed.issues).toHaveLength(1);

	const unfit = expectErr(
		readNoteText(captures, '---\ntitle: 5\ncapturedAt: yesterday\n---\n'),
	);
	expect(unfit.issues.map(({ field }) => field).sort()).toEqual([
		'capturedAt',
		'title',
	]);

	expect(
		expectErr(readNoteText(captures, 'No front matter at all\n')).issues,
	).toEqual([{ field: 'capturedAt', message: 'capturedAt is missing' }]);
});

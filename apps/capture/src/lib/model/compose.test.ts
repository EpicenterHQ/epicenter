/**
 * New Capture Composition Tests
 *
 * A capture must be the same thing when reopened as when it was created, and
 * the original text's own list must never become this app's thoughts. These
 * tests parse the composed file again, as reopening does, and compare bytes.
 *
 * Key behaviors:
 * - Ordinary text is followed by the section, with thoughts when given
 * - Text with its own Thoughts list, then an open fence, gets one visible
 *   heading before it: two headings, refused on reopening, bytes intact
 *
 * See `document.test.ts` for an open fence absorbing the appended section.
 */
import { expect, test } from 'bun:test';
import { captureBody, composeBody } from './index.js';

const HEAD = '---\ncapturedAt: 2026-01-01T00:00:00.000Z\n---\n';
const OWN_LIST_THEN_OPEN_FENCE =
	'Pasted article\n\n## Thoughts\n\n- This belongs to the original article\n\n```\nnever closed';

/** A whole file read again the way an open capture reads its row's body. */
function reopen(source: string) {
	const header = /^\uFEFF?---\r?\n(?:[^\r\n]*\r?\n)*?---\r?\n/.exec(source);
	if (header === null) throw new Error('fixture');
	const { data, error } = captureBody.decode(source.slice(header[0].length));
	return {
		refusal: error ?? undefined,
		text: data?.text,
		thoughts: data?.thoughts ?? [],
	};
}

test('ordinary text is followed by the section and its thoughts', () => {
	expect(composeBody('Text', ['one', 'two\nlines', '  '])).toEqual({
		body: '\nText\n\n## Thoughts\n\n- one\n- two\n  lines\n-\n',
		refusal: undefined,
		absorbed: false,
	});
	const reopened = reopen(HEAD + composeBody('Text', ['one']).body);
	expect(reopened.text).toBe('Text');
	expect(reopened.thoughts).toEqual(['one']);
});

test('its own Thoughts list then an open fence: marked, refused on reopening, bytes intact', () => {
	const composed = composeBody(OWN_LIST_THEN_OPEN_FENCE);
	expect(composed.body).toBe(
		`\n## Thoughts\n\n${OWN_LIST_THEN_OPEN_FENCE}\n\n## Thoughts\n`,
	);
	expect(composed.refusal?.code).toBe('duplicate-heading');
	expect(composed.absorbed).toBe(true);

	const reopened = reopen(HEAD + composed.body);
	expect(reopened.refusal?.code).toBe('duplicate-heading');
	expect(reopened.thoughts).toEqual([]);
	expect(reopened.text).toBeUndefined();
	const refused = captureBody.encode(
		{ text: 'mine', thoughts: [] },
		composed.body,
	);
	expect(refused.error?.code).toBe('duplicate-heading');
	// Without the mark, the article's list would have read as thoughts.
	const unmarked = reopen(
		`${HEAD}\n${OWN_LIST_THEN_OPEN_FENCE}\n\n## Thoughts\n`,
	);
	expect(unmarked.thoughts).toEqual(['This belongs to the original article']);
});

/** Capture's body codec preserves surrounding Markdown and composes thought strings. */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { captureBody } from './document.js';

const BODY =
	'\r\nText\r\n\r\n## Thoughts\r\n\r\n* same\r\n\r\n*   same\r\n\r\n## Later\r\n\r\nUntouched.\r\n';

test('decode returns positional strings and a no-op keeps the original body', () => {
	const value = expectOk(captureBody.decode(BODY));
	expect(value.thoughts).toEqual(['same', 'same']);
	expect(expectOk(captureBody.encode(value, BODY))).toBe(BODY);
});

test('editing the second duplicate formats the list consistently and preserves surrounding Markdown', () => {
	const value = expectOk(captureBody.decode(BODY));
	const body = expectOk(
		captureBody.encode(
			{
				text: 'Changed',
				thoughts: value.thoughts.map((text, index) =>
					index === 1 ? 'replacement\ncontinued' : text,
				),
			},
			BODY,
		),
	);
	expect(body).toBe(
		'\r\nChanged\r\n\r\n## Thoughts\r\n\r\n- same\r\n- replacement\r\n  continued\r\n\r\n## Later\r\n\r\nUntouched.\r\n',
	);
});

test('a complete value composes deletion, movement, and addition without metadata', () => {
	const body = '\nText\n\n## Thoughts\n\n- first\n- second\n- third\n';
	expect(
		expectOk(
			captureBody.encode(
				{ text: 'Changed', thoughts: ['third changed', 'new'] },
				body,
			),
		),
	).toBe('\nChanged\n\n## Thoughts\n\n- third changed\n- new\n');
});

test('empty thought strings round trip with or without an existing list', () => {
	for (const body of [
		'\nText\n\n## Thoughts\n',
		'\nText\n\n## Thoughts\n\n- existing\n',
	]) {
		const encoded = expectOk(
			captureBody.encode({ text: 'Text', thoughts: [''] }, body),
		);
		expect(expectOk(captureBody.decode(encoded)).thoughts).toEqual(['']);
	}
});

test('whitespace before a thought is dropped, because Markdown reads it as part of the marker', () => {
	for (const body of [
		'\nText\n\n## Thoughts\n',
		'\nText\n\n## Thoughts\n\n- existing\n',
	]) {
		const encoded = expectOk(
			captureBody.encode(
				{ text: 'Text', thoughts: [' one', '  two  ', '\tthree\n  four'] },
				body,
			),
		);
		expect(expectOk(captureBody.decode(encoded)).thoughts).toEqual([
			'one',
			'two  ',
			'three\n  four',
		]);
	}
});

test('ambiguous source and text that would absorb the thoughts are explicit failures', () => {
	expect(
		expectErr(captureBody.decode('\nText\n\n## Thoughts\n\n## Thoughts\n'))
			.code,
	).toBe('duplicate-heading');
	const value = expectOk(captureBody.decode(BODY));
	expect(
		expectErr(captureBody.encode({ ...value, text: 'unclosed\n```' }, BODY))
			.code,
	).toBe('unverified');
});

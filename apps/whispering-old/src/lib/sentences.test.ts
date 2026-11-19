/**
 * Joining messages as sentences.
 *
 * A browser's own message ends with a full stop and Whispering's banner adds
 * a sentence after it; Safari's private window showed "memory).. Recording
 * is off". Every join of a message from elsewhere goes through `sentences`.
 *
 * Key behaviors:
 * - A part that ends a sentence keeps its own punctuation, once.
 * - A part that does not is ended with a full stop.
 * - Empty parts are left out.
 */
import { expect, test } from 'bun:test';
import { sentences } from './sentences.js';

test('a message that ends with a full stop is not given another', () => {
	expect(
		sentences(
			'UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).',
			'Recording is off.',
		),
	).toBe(
		'UnknownError: The operation failed for an unknown transient reason (e.g. out of memory). Recording is off.',
	);
});

test('a message without one is ended with a full stop', () => {
	expect(sentences('Failed to fetch', 'Nothing is sent again')).toBe(
		'Failed to fetch. Nothing is sent again.',
	);
});

test('a question, an exclamation, an ellipsis, or a quoted ending stays as it is', () => {
	expect(sentences('Is it there?', 'No!', 'Wait…', 'It said “stop.”')).toBe(
		'Is it there? No! Wait… It said “stop.”',
	);
});

test('blank parts are left out and the rest are trimmed', () => {
	expect(sentences('  Gone  ', '', '   ')).toBe('Gone.');
});

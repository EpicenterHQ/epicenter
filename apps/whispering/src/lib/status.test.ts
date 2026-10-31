/**
 * The header's status line says where the recordings are kept, in the
 * variant's words, and an answer that could not be kept outranks it.
 */
import { expect, test } from 'bun:test';
import { headerStatus, ON_THIS_BROWSER } from './status.js';

test('the line says where the recordings are kept', () => {
	expect(headerStatus({ unwrittenAnswers: 0 }, ON_THIS_BROWSER)).toMatchObject({
		label: 'On this browser',
		tone: 'neutral',
	});
});

test('an unsaved answer outranks it', () => {
	expect(headerStatus({ unwrittenAnswers: 1 }, ON_THIS_BROWSER)).toMatchObject({
		label: '1 answer not saved yet',
		tone: 'error',
	});
	expect(headerStatus({ unwrittenAnswers: 2 }, ON_THIS_BROWSER).label).toBe(
		'2 answers not saved yet',
	);
});

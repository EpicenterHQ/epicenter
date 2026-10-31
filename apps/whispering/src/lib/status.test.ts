/**
 * The header's status line says where the recordings are kept, this
 * browser, and an answer that could not be kept outranks it.
 */
import { expect, test } from 'bun:test';
import { headerStatus } from './status.js';

test('the line says the recordings are kept on this browser', () => {
	expect(headerStatus({ unwrittenAnswers: 0 })).toMatchObject({
		label: 'On this browser',
		tone: 'neutral',
	});
});

test('an unsaved answer outranks it', () => {
	expect(headerStatus({ unwrittenAnswers: 1 })).toMatchObject({
		label: '1 answer not saved yet',
		tone: 'error',
	});
	expect(headerStatus({ unwrittenAnswers: 2 }).label).toBe(
		'2 answers not saved yet',
	);
});

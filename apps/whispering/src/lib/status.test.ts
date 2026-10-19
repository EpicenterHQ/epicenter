/**
 * The header's status line reports whether what the person did is in the
 * folder on this device. Nothing here speaks of versions or sync: the folder
 * keeps neither.
 */
import { expect, test } from 'bun:test';
import { filesLine } from './status.js';

test('everything saved says so, and names no history', () => {
	const line = filesLine({ saving: false, unwrittenAnswers: 0 });
	expect(line).toMatchObject({ short: 'Saved', tone: 'good' });
	expect(JSON.stringify(line)).not.toMatch(/version|commit|sync|history/i);
});

test('an answer not written outranks a save running, and typing that did not save outranks both', () => {
	expect(filesLine({ saving: true, unwrittenAnswers: 1 }).label).toBe(
		'1 answer not written yet',
	);
	expect(
		filesLine({ saving: true, unsaved: true, unwrittenAnswers: 0 }),
	).toMatchObject({
		short: 'Not saved',
		tone: 'error',
	});
	expect(filesLine({ saving: true, unwrittenAnswers: 0 }).label).toBe(
		'Saving…',
	);
});

test('a save storage refused is reported until a save lands', () => {
	expect(
		filesLine({
			saving: false,
			storageFailure: 'The disk is full.',
			unwrittenAnswers: 0,
		}),
	).toEqual({
		label: 'A save failed',
		detail: 'The disk is full.',
		tone: 'error',
	});
});

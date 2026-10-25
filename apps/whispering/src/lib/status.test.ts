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

test('an answer not written outranks a save running', () => {
	expect(filesLine({ saving: true, unwrittenAnswers: 1 })).toMatchObject({
		label: '1 answer not written yet',
		tone: 'error',
	});
	expect(filesLine({ saving: true, unwrittenAnswers: 0 }).label).toBe(
		'Saving…',
	);
});

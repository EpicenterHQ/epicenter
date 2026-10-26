/**
 * The header's status line reports whether what the person did is in the
 * folder on this device. Nothing here speaks of versions or sync: the folder
 * keeps neither.
 */
import { expect, test } from 'bun:test';
import { headerStatus } from './status.js';

test('an idle folder makes no saved claim while drafts may still be waiting', () => {
	const line = headerStatus({ saving: false, unwrittenAnswers: 0 });
	expect(line).toMatchObject({ label: 'On this device', tone: 'neutral' });
	expect(JSON.stringify(line)).not.toMatch(/version|commit|sync|history/i);
});

test('an answer not written outranks a save running', () => {
	expect(headerStatus({ saving: true, unwrittenAnswers: 1 })).toMatchObject({
		label: '1 answer not written yet',
		tone: 'error',
	});
	expect(headerStatus({ saving: true, unwrittenAnswers: 0 }).label).toBe(
		'Saving…',
	);
});

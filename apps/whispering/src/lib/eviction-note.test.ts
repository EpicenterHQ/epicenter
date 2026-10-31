/**
 * Settings' line about Safari clearing a site's files.
 *
 * Key behaviors:
 * - Safari on the web, keeping files that are not persistent, shows it.
 * - Persistent storage, storage that does not work, an unanswered check,
 *   Chromium, Firefox, and the desktop app (a WebKit view on macOS) hide it.
 * - A browser that cannot answer `persisted()` is treated as not answering.
 */
import { expect, test } from 'bun:test';
import { EVICTION_NOTE, evictionNote, readPersisted } from './eviction-note.js';

const safari = {
	variant: 'local',
	vendor: 'Apple Computer, Inc.',
	storageWorks: true,
	persisted: false,
} as const;

test('Safari on the web, with files that are not persistent, shows the line', () => {
	expect(evictionNote(safari)).toBe(EVICTION_NOTE);
	expect(EVICTION_NOTE).toBe(
		'Safari may clear these recordings if you don’t visit for a while. The desktop app keeps them as files in your Epicenter folder.',
	);
});

test('the line is hidden wherever Safari cannot clear the recordings, or might not', () => {
	for (const hidden of [
		{ ...safari, persisted: true },
		{ ...safari, persisted: undefined },
		{ ...safari, storageWorks: false },
		{ ...safari, vendor: 'Google Inc.' },
		{ ...safari, vendor: '' },
		{ ...safari, variant: 'desktop' as const },
	])
		expect(evictionNote(hidden)).toBeUndefined();
});

test('persisted is what the browser answers, and undefined when it cannot', async () => {
	expect(await readPersisted({ persisted: async () => false })).toBe(false);
	expect(await readPersisted({ persisted: async () => true })).toBe(true);
	expect(
		await readPersisted({
			persisted: async () => {
				throw new DOMException('denied', 'SecurityError');
			},
		}),
	).toBeUndefined();
	expect(await readPersisted(undefined)).toBeUndefined();
});

/** Header status describes whether a folder write is queued or active, and where a repository's files stand with its server. */
import { expect, test } from 'bun:test';
import { saveLine, storageLine, syncLine } from './status-line.js';

test('saveLine shows busy for writes and a neutral device line otherwise', () => {
	expect(saveLine(true)).toEqual({ label: 'Saving…', tone: 'busy' });
	expect(saveLine(false)).toEqual({ label: 'On this device', tone: 'neutral' });
});

test('syncLine says synced only when nothing is sending, waiting or refused, and a refused file wins', () => {
	expect(syncLine({ sending: 0, refused: 0 })).toEqual({ label: 'Synced', tone: 'good' });
	expect(syncLine({ sending: 2, refused: 0 })).toEqual({ label: 'Sending…', detail: '2 files not sent yet', tone: 'busy' });
	expect(syncLine({ sending: 1, refused: 1 })).toEqual({
		label: 'Not sent',
		detail: "1 file is saved on this device and needs a fix; 1 file isn't sent yet",
		tone: 'warning',
	});
	expect(syncLine({ sending: 0, refused: 2 })).toEqual({
		label: 'Not sent',
		detail: '2 files are saved on this device and need a fix',
		tone: 'warning',
	});
});

test('storageLine warns only where this browser holds work that exists nowhere else and its storage is not persistent', () => {
	const local = 'This repository exists only in this browser, and the browser may delete it when space runs low. Sign in to sync.';
	const unsent = 'Unsent changes exist only in this browser, and the browser may delete them when space runs low.';
	for (const persistence of ['denied', 'not-asked'] as const) {
		expect(storageLine({ persistence, local: true, unsent: false })).toEqual({ label: local, tone: 'warning' });
		expect(storageLine({ persistence, local: false, unsent: true })).toEqual({ label: unsent, tone: 'warning' });
		expect(storageLine({ persistence, local: false, unsent: false })).toBeNull();
	}
	for (const persistence of ['granted', 'checking'] as const) expect(storageLine({ persistence, local: true, unsent: true })).toBeNull();
});

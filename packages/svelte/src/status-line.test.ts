/** Header status describes whether a folder write is queued or active, and where a repository's files stand with its server. */
import { expect, test } from 'bun:test';
import { saveLine, syncLine } from './status-line.js';

test('saveLine shows busy for writes and a neutral device line otherwise', () => {
	expect(saveLine(true)).toEqual({ label: 'Saving…', tone: 'busy' });
	expect(saveLine(false)).toEqual({ label: 'On this device', tone: 'neutral' });
});

test('syncLine says synced only when nothing is sending or held, and a held file wins', () => {
	expect(syncLine({ sending: 0, held: 0 })).toEqual({ label: 'Synced', tone: 'good' });
	expect(syncLine({ sending: 2, held: 0 })).toEqual({ label: 'Sending…', detail: '2 files not sent yet', tone: 'busy' });
	expect(syncLine({ sending: 1, held: 1 })).toEqual({
		label: 'Not sent',
		detail: "1 file is saved on this device and waits for a fix; 1 file isn't sent yet",
		tone: 'warning',
	});
	expect(syncLine({ sending: 0, held: 2 })).toEqual({
		label: 'Not sent',
		detail: '2 files are saved on this device and wait for a fix',
		tone: 'warning',
	});
});

/** Header status describes whether a folder write is queued or active. */
import { expect, test } from 'bun:test';
import { saveLine } from './status-line.js';

test('saveLine shows busy for writes and a neutral device line otherwise', () => {
	expect(saveLine(true)).toEqual({ label: 'Saving…', tone: 'busy' });
	expect(saveLine(false)).toEqual({ label: 'On this device', tone: 'neutral' });
});

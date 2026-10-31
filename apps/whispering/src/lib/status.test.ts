/**
 * The header's status line says which view is open: "On this device", or
 * "Synced" and whether the repository can be reached. An answer that could
 * not be kept outranks every other line.
 */
import { expect, test } from 'bun:test';
import { headerStatus } from './status.js';

const synced = {
	view: 'synced',
	unwrittenAnswers: 0,
	auth: 'signed-in',
	problem: undefined,
} as const;

test('on this device, the line names the view, signed in or not', () => {
	for (const auth of ['signed-out', 'signed-in'] as const)
		expect(
			headerStatus({ ...synced, view: 'device', auth, problem: 'x' }),
		).toMatchObject({ label: 'On this device', tone: 'neutral' });
});

test('synced, the line says whether the repository can be reached', () => {
	expect(headerStatus(synced)).toMatchObject({ label: 'Synced', tone: 'good' });
	expect(headerStatus({ ...synced, problem: 'offline' })).toMatchObject({
		label: 'Offline',
		tone: 'warning',
	});
	expect(headerStatus({ ...synced, auth: 'reauth-required' })).toMatchObject({
		label: 'Sign in again',
		tone: 'warning',
	});
});

test('an unsaved answer outranks the rest', () => {
	expect(
		headerStatus({ ...synced, problem: 'offline', unwrittenAnswers: 1 }),
	).toMatchObject({ label: '1 answer not saved yet', tone: 'error' });
});

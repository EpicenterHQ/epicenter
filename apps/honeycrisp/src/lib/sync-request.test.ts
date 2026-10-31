/**
 * What the desktop page says once its shell answered "Sync with Epicenter".
 *
 * Key behaviors:
 * - A request the system took says the computer was asked, never that
 *   Epicenter set the folder up: the person chooses that in Epicenter
 * - A refused request says why, in the shell's words
 */
import { describe, expect, test } from 'bun:test';
import { syncRequestOutcome } from './sync-request.js';

describe('Sync with Epicenter', () => {
	test('says the computer was asked, not that the folder syncs', () => {
		const outcome = syncRequestOutcome(null);
		expect(outcome.tone).toBe('requested');
		expect(outcome.message).toStartWith(
			'Asked your computer to open Epicenter.',
		);
		expect(outcome.message).toContain('If it is installed');
	});

	test('says why a refused request did not reach Epicenter', () => {
		expect(
			syncRequestOutcome({
				name: 'Io',
				path: '',
				operation: 'sync with Epicenter',
				message:
					'The system did not open Epicenter: no application handles epicenter:',
			}),
		).toEqual({
			tone: 'failed',
			message:
				'Could not ask your computer to open Epicenter. The system did not open Epicenter: no application handles epicenter:',
		});
		expect(
			syncRequestOutcome({
				name: 'InvalidPath',
				path: '..',
				reason: 'leaves the folder',
			}).message,
		).toEndWith('leaves the folder');
		expect(
			syncRequestOutcome(
				'plugin:epicenter-folder|sync_with_epicenter not allowed',
			).tone,
		).toBe('failed');
	});
});

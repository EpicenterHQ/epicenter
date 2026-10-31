/**
 * Open in Epicenter Tests
 *
 * What the page says once Todos' desktop shell answers, over stand-in shells.
 *
 * Key behaviors:
 * - A successful opener call says the computer was asked, never that
 *   Epicenter received the request or set the folder up
 * - A request that failed says why
 */
import { describe, expect, test } from 'bun:test';
import { openInEpicenter } from './open-in-epicenter';

function shell(open: () => Promise<void> = async () => {}) {
	return { openInEpicenter: open };
}

describe('Open in Epicenter', () => {
	test('says the computer was asked, not that Epicenter received it', async () => {
		const status = await openInEpicenter(shell());
		expect(status.tone).toBe('requested');
		expect(status.message).toStartWith(
			'Asked your computer to open Epicenter.',
		);
		expect(status.message).toContain('If it is installed');
	});

	test('says why a request that failed did not reach Epicenter', async () => {
		const status = await openInEpicenter(
			shell(() =>
				Promise.reject(
					'The system did not open Epicenter: no application handles epicenter:',
				),
			),
		);
		expect(status).toEqual({
			tone: 'failed',
			message:
				'Could not ask your computer to open Epicenter. The system did not open Epicenter: no application handles epicenter:',
		});
	});
});

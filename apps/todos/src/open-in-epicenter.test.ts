/**
 * Open in Epicenter Tests
 *
 * Which Todos offers the action, and what the page says once the shell
 * answers, over stand-in shells.
 *
 * Key behaviors:
 * - Only standalone Todos, release or development, offers it: a browser has
 *   no shell, and a shell that names another app or refuses to say does not
 * - A successful opener call says the computer was asked, never that
 *   Epicenter received the request or opened the folder
 * - A request that failed says why
 */
import { describe, expect, test } from 'bun:test';
import { offersOpenInEpicenter, openInEpicenter } from './open-in-epicenter';

function shell(
	identifier: () => Promise<string>,
	open: () => Promise<void> = async () => {},
) {
	return { identifier, openInEpicenter: open };
}

describe('Open in Epicenter', () => {
	test('is offered by standalone Todos alone', async () => {
		expect(await offersOpenInEpicenter(undefined)).toBe(false);
		expect(
			await offersOpenInEpicenter(shell(async () => 'so.epicenter.todos')),
		).toBe(true);
		expect(
			await offersOpenInEpicenter(shell(async () => 'so.epicenter.todos.dev')),
		).toBe(true);
		// Todos inside Epicenter runs under Epicenter's identifier, whose
		// bundled windows are not granted the lookup at all.
		expect(await offersOpenInEpicenter(shell(async () => 'so.epicenter'))).toBe(
			false,
		);
		expect(
			await offersOpenInEpicenter(
				shell(() => Promise.reject('core:app|identifier not allowed')),
			),
		).toBe(false);
	});

	test('says the computer was asked, not that Epicenter received it', async () => {
		const status = await openInEpicenter(
			shell(async () => 'so.epicenter.todos'),
		);
		expect(status.tone).toBe('requested');
		expect(status.message).toStartWith(
			'Asked your computer to open Epicenter.',
		);
		expect(status.message).toContain('If it is installed');
	});

	test('says why a request that failed did not reach Epicenter', async () => {
		const status = await openInEpicenter(
			shell(
				async () => 'so.epicenter.todos',
				() =>
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

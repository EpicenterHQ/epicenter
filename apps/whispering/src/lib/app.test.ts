/**
 * Whispering's capabilities (`app.ts`) as the pages read them, under the
 * `test` condition: the folder is in memory and the account signed out.
 * Nothing here mocks a module.
 *
 * Key behaviors:
 * - The folder opens while the account is signed out, and keeps what is
 *   written to it
 * - The models list Epicenter's hosted models first; the web has no global
 *   shortcut
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

const { account, ai, folder, shortcut } = await import('./app.js');

test('the folder opens while the account is signed out, and keeps what is written to it', async () => {
	expect(account.state().status).toBe('signed-out');
	expectOk(
		await folder.recordings.create({
			id: '20261104T090000000',
			title: 'Standup',
			recordedAt: '2026-11-04T09:00:00.000Z',
		}),
	);
	expect(folder.state().status).toBe('open');
	expect(folder.recordings.get({ id: '20261104T090000000' })?.title).toBe(
		'Standup',
	);
});

test('the models list Epicenter’s hosted models first, and the web has no global shortcut', () => {
	expect(ai.endpoints()[0]?.id).toBe('hosted');
	expect(shortcut).toBeNull();
});

/**
 * Sync with Epicenter Tests
 *
 * What the page learns from the shell when it asks Epicenter to sync a
 * folder, over a stand-in Tauri IPC.
 *
 * Key behaviors:
 * - The root's name and the contract URL reach the shell as given
 * - A refusal says why, in the shell's words
 */

import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

let answer: () => unknown = () => null;
const asked: { command: string; body: unknown }[] = [];

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (command: string, body?: unknown) => {
		asked.push({ command, body });
		return answer();
	},
}));

const { syncWithEpicenter, syncedWithEpicenter } = await import('./tauri.js');

afterEach(() => {
	answer = () => null;
	asked.length = 0;
});

test('asks the shell to open the link for the root and contract it names', async () => {
	expectOk(
		await syncWithEpicenter({
			root: 'Data',
			contract: 'https://capture.epicenter.so/contract.json',
		}),
	);
	expect(asked).toEqual([
		{
			command: 'plugin:epicenter-folder|sync_with_epicenter',
			body: {
				root: 'Data',
				contract: 'https://capture.epicenter.so/contract.json',
			},
		},
	]);
});

test('says why the shell refused', async () => {
	answer = () => {
		throw { name: 'NotOpened', message: 'no application handles epicenter:' };
	};
	const error = expectErr(
		await syncWithEpicenter({ root: 'Data', contract: 'https://x.so/c.json' }),
	);
	expect(error.name).toBe('Unavailable');
	expect(error.message).toBe(
		'The system did not open Epicenter: no application handles epicenter:',
	);
	answer = () => {
		throw { name: 'Folder', message: 'The Data folder is not open.' };
	};
	expect(expectErr(await syncedWithEpicenter({ root: 'Data' })).message).toBe(
		'The Data folder is not open.',
	);
});

test('reads whether Epicenter syncs the folder', async () => {
	answer = () => true;
	expect(expectOk(await syncedWithEpicenter({ root: 'Data' }))).toBe(true);
	expect(asked.at(-1)).toEqual({
		command: 'plugin:epicenter-folder|synced_with_epicenter',
		body: { root: 'Data' },
	});
});

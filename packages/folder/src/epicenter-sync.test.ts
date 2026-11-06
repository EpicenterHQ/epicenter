/**
 * Sync with Epicenter Tests
 *
 * What the page learns from the shell when it asks Epicenter to sync a
 * folder, over a stand-in Tauri IPC.
 *
 * Key behaviors:
 * - The contract URL reaches the Data-only shell command
 * - A refusal says why, in the shell's words
 */

import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

// Bun keeps a module mock for the rest of the run, so the stand-in stops
// claiming Tauri once this file is done.
let inTauri = true;
let answer: () => unknown = () => null;
const asked: { command: string; body: unknown }[] = [];

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => inTauri,
	transformCallback: () => 0,
	invoke: async (command: string, body?: unknown) => {
		asked.push({ command, body });
		return answer();
	},
}));

const { syncWithEpicenter, syncedWithEpicenter } = await import('./tauri.js');

afterAll(() => {
	inTauri = false;
});

afterEach(() => {
	answer = () => null;
	asked.length = 0;
});

test('asks the shell to open the link for the root and contract it names', async () => {
	expectOk(
		await syncWithEpicenter({
			contract: 'https://capture.epicenter.so/contract.json',
		}),
	);
	expect(asked).toEqual([
		{
			command: 'plugin:epicenter-folder|sync_with_epicenter',
			body: {
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
		await syncWithEpicenter({ contract: 'https://x.so/c.json' }),
	);
	expect(error.name).toBe('Unavailable');
	expect(error.message).toBe(
		'The system did not open Epicenter: no application handles epicenter:',
	);
	answer = () => {
		throw { name: 'Folder', message: 'The Data folder is not open.' };
	};
	expect(expectErr(await syncedWithEpicenter()).message).toBe(
		'The Data folder is not open.',
	);
});

test('reads whether Epicenter syncs the folder', async () => {
	answer = () => true;
	expect(expectOk(await syncedWithEpicenter())).toBe(true);
	expect(asked.at(-1)).toEqual({
		command: 'plugin:epicenter-folder|synced_with_epicenter',
		body: undefined,
	});
});

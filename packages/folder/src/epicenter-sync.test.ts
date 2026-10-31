/**
 * Sync with Epicenter Tests
 *
 * What the page learns from the shell when it asks Epicenter to sync a
 * folder, over a stand-in Tauri IPC, and the settings note the desktop shell
 * keeps the folder's path in.
 *
 * Key behaviors:
 * - The folder's path and the contract URL reach the shell as given
 * - A refusal says why, in the shell's words
 * - `settings.md` as the shell writes it reads as an `appConfig` note
 */

import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

let answer: () => unknown = () => null;
const asked: { command: string; body: unknown }[] = [];

// `@epicenter/folder/tauri` imports these for a standalone app's roots; nothing here calls them.
mock.module('@tauri-apps/api/app', () => ({ getName: async () => 'Notes' }));
mock.module('@tauri-apps/api/path', () => ({
	appDataDir: async () => '/app-data',
	homeDir: async () => '/home',
	join: async (...parts: string[]) => parts.join('/'),
}));
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
const { appConfig, openDevice } = await import('./node.js');

afterEach(() => {
	answer = () => null;
	asked.length = 0;
});

test('asks the shell to open the link for the folder and contract it names', async () => {
	expectOk(
		await syncWithEpicenter({
			path: '/Users/me/Epicenter/Capture',
			contract: 'https://capture.epicenter.so/contract.json',
		}),
	);
	expect(asked).toEqual([
		{
			command: 'plugin:epicenter-folder|sync_with_epicenter',
			body: {
				path: '/Users/me/Epicenter/Capture',
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
		await syncWithEpicenter({ path: '/a', contract: 'https://x.so/c.json' }),
	);
	expect(error.name).toBe('Unavailable');
	expect(error.message).toBe(
		'The system did not open Epicenter: no application handles epicenter:',
	);
	answer = () => {
		throw { name: 'Folder', path: 'relative' };
	};
	expect(
		expectErr(await syncedWithEpicenter({ path: 'relative' })).message,
	).toBe('relative is not a folder this window can use.');
});

test('reads whether Epicenter syncs the folder', async () => {
	answer = () => true;
	expect(expectOk(await syncedWithEpicenter({ path: '/a' }))).toBe(true);
	expect(asked.at(-1)).toEqual({
		command: 'plugin:epicenter-folder|synced_with_epicenter',
		body: { path: '/a' },
	});
});

/** The text `epicenter-standalone` writes (`with_settings_folder`). */
test('the settings note the shell writes reads as appConfig', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'app-config-'));
	try {
		await writeFile(
			join(directory, 'settings.md'),
			'---\nfolder: "/Users/me/Epicenter/Capture"\ntheme: dark\n---\n',
		);
		const config = unwrap(await openDevice(appConfig, { path: directory }));
		const settings = expectOk(await config.settings.get({}));
		// Other machine settings are kept beside `folder`.
		expect(settings).toMatchObject({
			folder: '/Users/me/Epicenter/Capture',
			theme: 'dark',
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

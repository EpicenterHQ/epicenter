/**
 * The desktop's global shortcut (`shortcut.tauri.svelte.ts`) over two real
 * directories standing in for its roots: the data folder (the contract) and
 * the AppData root (`whisperingSettings`), with a stand-in for the shell's
 * `set_shortcut`.
 *
 * Key behaviors:
 * - The key resolves per note: the default, then the data folder's
 *   `shortcuts.md`, then this computer's, key by key
 * - Once both notes are read, and whenever the key changes, the shell is
 *   asked to hold it, and what it refuses is the problem shown
 * - Saving writes the data folder's note and drops this computer's
 *   override, or, "only on this computer", writes the AppData note
 * - A key the shell refuses is never written, and the resolved one is held
 *   again
 * - A label reads as a Mac menu, or as Windows and Linux spell it
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import { whispering } from '../contract.js';
import { whisperingSettings } from '../settings.tauri.js';

/** Every key the page asked the shell to hold, in order. */
const asked: string[] = [];
/** Keys the shell refuses, as another app holding them would. */
const taken = new Set<string>();
mock.module('@tauri-apps/api/core', () => ({
	// What other importers of the module name; nothing here calls them.
	Channel: class {},
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (command: string, args: { accelerator: string }) => {
		expect(command).toBe('set_shortcut');
		asked.push(args.accelerator);
		if (taken.has(args.accelerator))
			throw `${args.accelerator} is unavailable: already held`;
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: async () => () => {},
}));

const { globalShortcut, labelOf } = await import('./shortcut.tauri.svelte.js');
const { fromClient } = await import('@epicenter/svelte/client');
const { flushSync, mount, unmount } = await import('svelte');
const { default: InitHost } = await import(
	'../../../../../packages/svelte/src/fixtures/InitHost.svelte'
);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	asked.length = 0;
	taken.clear();
});

/** Both roots as temporary directories, `shortcuts.md` written in each where given. */
async function roots({ data, here }: { data?: string; here?: string } = {}) {
	const folder = await mkdtemp(join(tmpdir(), 'whispering-data-'));
	const appDataRoot = await mkdtemp(join(tmpdir(), 'whispering-app-data-'));
	cleanups.push(async () => {
		await rm(folder, { recursive: true, force: true });
		await rm(appDataRoot, { recursive: true, force: true });
	});
	const note = (key: string) => `---\ntoggleRecording: "${key}"\n---\n`;
	if (data) await writeFile(join(folder, 'shortcuts.md'), note(data));
	if (here) await writeFile(join(appDataRoot, 'shortcuts.md'), note(here));
	return {
		device: fromClient(unwrap(await openDevice(whispering, { path: folder }))),
		appData: fromClient(
			unwrap(await openDevice(whisperingSettings, { path: appDataRoot })),
		),
		text: (root: 'data' | 'here') =>
			readFile(
				join(root === 'data' ? folder : appDataRoot, 'shortcuts.md'),
				'utf8',
			).catch(() => null),
	};
}

/** `globalShortcut` made during a component's setup, as the desktop root makes it. */
function setup(made: Parameters<typeof globalShortcut>[0]) {
	const target = document.createElement('div');
	document.body.append(target);
	let shortcut: ReturnType<typeof globalShortcut> | undefined;
	const view = mount(InitHost, {
		target,
		props: {
			make: () => globalShortcut(made),
			expose: (value: unknown) => {
				shortcut = value as ReturnType<typeof globalShortcut>;
			},
		},
	});
	cleanups.push(async () => {
		await unmount(view);
		target.remove();
	});
	flushSync();
	return shortcut as ReturnType<typeof globalShortcut>;
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

test('with no note in either root, the default is held once both are read', async () => {
	const shortcut = setup(await roots());
	await until(() => asked.length > 0);
	expect(asked).toEqual(['CommandOrControl+Shift+;']);
	expect(shortcut.accelerator).toBe('CommandOrControl+Shift+;');
	expect(shortcut.onThisComputer).toBe(false);
});

test('the data folder’s key wins over the default, and this computer’s over both', async () => {
	const synced = setup(await roots({ data: 'Alt+Space' }));
	await until(() => asked.includes('Alt+Space'));
	expect(synced.accelerator).toBe('Alt+Space');
	asked.length = 0;
	const overridden = setup(
		await roots({ data: 'Alt+Space', here: 'CommandOrControl+Shift+K' }),
	);
	await until(() => asked.length > 0);
	expect(asked).toEqual(['CommandOrControl+Shift+K']);
	expect(overridden.onThisComputer).toBe(true);
});

test('what the shell refuses is the problem shown', async () => {
	taken.add('Alt+Space');
	const shortcut = setup(await roots({ data: 'Alt+Space' }));
	await until(() => shortcut.problem !== null);
	expect(shortcut.problem).toBe('Alt+Space is unavailable: already held');
});

test('saving writes the data folder’s note and drops this computer’s override; only here writes the AppData note', async () => {
	const { device, appData, text } = await roots({ here: 'Alt+Space' });
	const shortcut = setup({ device, appData });
	await until(() => shortcut.read && asked.length > 0);

	expect(
		await shortcut.save('Control+Shift+R', { onThisComputer: true }),
	).toBeNull();
	expect(await text('here')).toBe(
		'---\ntoggleRecording: "Control+Shift+R"\n---\n',
	);
	expect(await text('data')).toBeNull();

	expect(await shortcut.save(' Alt+R ', { onThisComputer: false })).toBeNull();
	expect(await text('data')).toBe('---\ntoggleRecording: "Alt+R"\n---\n');
	expect(await text('here')).toBe('---\n---\n');
	await until(() => shortcut.accelerator === 'Alt+R');
	expect(shortcut.onThisComputer).toBe(false);
	expect(asked.at(-1)).toBe('Alt+R');
});

test('a key the shell refuses is never written, and the resolved one is held again', async () => {
	const { device, appData, text } = await roots();
	const shortcut = setup({ device, appData });
	await until(() => shortcut.read && asked.length > 0);
	taken.add('Alt+Space');
	expect(await shortcut.save('Alt+Space', { onThisComputer: false })).toBe(
		'Alt+Space is unavailable: already held',
	);
	expect(await text('data')).toBeNull();
	expect(asked.slice(-2)).toEqual(['Alt+Space', 'CommandOrControl+Shift+;']);
	expect(await shortcut.save('  ', { onThisComputer: false })).toMatch(
		/^Type a shortcut/,
	);
});

test('a label reads as a Mac menu, or as Windows and Linux spell it', () => {
	expect(labelOf('CommandOrControl+Shift+;', true)).toBe('⌘⇧;');
	expect(labelOf('CommandOrControl+Shift+;', false)).toBe('Ctrl+Shift+;');
	expect(labelOf('Alt+Space', true)).toBe('⌥Space');
	expect(labelOf('Control+k', false)).toBe('Ctrl+K');
});

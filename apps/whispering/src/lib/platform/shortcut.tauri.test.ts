/**
 * The desktop's global shortcut (`openShortcut` in `shortcut.tauri.ts`) over the
 * data folder and this computer's `shortcuts.md`, both in memory (a
 * `memory()` place from `@epicenter/folder/memory`, and `localFile` from
 * `@epicenter/local` under the `test` condition), with a stand-in for the
 * shell's `set_shortcut`.
 *
 * Key behaviors:
 * - The key resolves per note: the default, then the data folder's
 *   `shortcuts.md`, then this computer's, key by key
 * - Once both notes are read, and whenever the key changes, the shell is
 *   asked to hold it, and what it refuses is the problem shown
 * - Saving writes the data folder's note and drops this computer's
 *   override, or, "only on this computer", writes this computer's note
 * - A key the shell refuses is never written, and the resolved one is held
 *   again
 * - A label reads as a Mac menu, or as Windows and Linux spell it
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder';
import { memory } from '@epicenter/folder/memory';
import { localFile } from '@epicenter/local';
import { whispering } from '../contract.js';

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

const { acceleratorOf, labelOf, openShortcut } = await import(
	'./shortcut.tauri.js'
);

/** This computer's `shortcuts.md`: memory, kept for the process. */
const here = localFile('shortcuts.md');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	const left = await here.read();
	if (left.data) await here.write(null, left.data.version);
	asked.length = 0;
	taken.clear();
});

const note = (key: string) => `---\ntoggleRecording: "${key}"\n---\n`;

/** The shortcut over a new data folder and this computer's note, `shortcuts.md` written in each where given. */
async function open({ data, mine }: { data?: string; mine?: string } = {}) {
	const folder = openFolder(whispering, memory());
	if (data) await folder.shortcuts.set({}, { toggleRecording: data });
	if (mine) await here.write(note(mine), 'absent');
	const shortcut = openShortcut(folder);
	// Its folder is followed for the page's life; a test's ends with the test.
	cleanups.push(async () => {
		shortcut[Symbol.dispose]();
		folder[Symbol.dispose]();
	});
	return {
		shortcut,
		folder,
		mine: async () => (await here.read()).data?.text ?? null,
	};
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

test('with no note in either place, the default is held once both are read', async () => {
	const { shortcut } = await open();
	await until(() => asked.length > 0);
	expect(asked).toEqual(['CommandOrControl+Shift+;']);
	expect(shortcut.accelerator()).toBe('CommandOrControl+Shift+;');
	expect(shortcut.onThisComputer()).toBe(false);
});

test('the data folder’s key wins over the default, and this computer’s over both', async () => {
	const { shortcut: synced } = await open({ data: 'Alt+Space' });
	await until(() => asked.includes('Alt+Space'));
	expect(synced.accelerator()).toBe('Alt+Space');
	// This computer's note is one for the process: only one shortcut follows it at a time.
	for (const cleanup of cleanups.splice(0)) await cleanup();
	asked.length = 0;
	const { shortcut: overridden } = await open({
		data: 'Alt+Space',
		mine: 'CommandOrControl+Shift+K',
	});
	await until(() => asked.length > 0);
	expect(asked).toEqual(['CommandOrControl+Shift+K']);
	expect(overridden.onThisComputer()).toBe(true);
});

test('what the shell refuses is the problem shown', async () => {
	taken.add('Alt+Space');
	const { shortcut } = await open({ data: 'Alt+Space' });
	await until(() => shortcut.problem() !== null);
	expect(shortcut.problem()).toBe('Alt+Space is unavailable: already held');
});

test('saving writes the data folder’s note and drops this computer’s override; only here writes this computer’s note', async () => {
	const { shortcut, folder, mine } = await open({ mine: 'Alt+Space' });
	await until(() => shortcut.read() && asked.length > 0);

	expect(
		await shortcut.save('Control+Shift+R', { onThisComputer: true }),
	).toBeNull();
	expect(await mine()).toBe(note('Control+Shift+R'));
	expect(folder.shortcuts.get({})).toBeUndefined();

	expect(await shortcut.save(' Alt+R ', { onThisComputer: false })).toBeNull();
	expect(folder.shortcuts.get({})?.toggleRecording).toBe('Alt+R');
	expect(await mine()).toBe('---\n---\n');
	await until(() => shortcut.accelerator() === 'Alt+R');
	expect(shortcut.onThisComputer()).toBe(false);
	expect(asked.at(-1)).toBe('Alt+R');
});

test('a key the shell refuses is never written, and the resolved one is held again', async () => {
	const { shortcut, folder, mine } = await open();
	await until(() => shortcut.read() && asked.length > 0);
	taken.add('Alt+Space');
	expect(await shortcut.save('Alt+Space', { onThisComputer: false })).toBe(
		'Alt+Space is unavailable: already held',
	);
	expect(folder.shortcuts.get({})).toBeUndefined();
	expect(await mine()).toBeNull();
	expect(asked.slice(-2)).toEqual(['Alt+Space', 'CommandOrControl+Shift+;']);
	expect(await shortcut.save('  ', { onThisComputer: false })).toMatch(
		/^Type a shortcut/,
	);
});

test('a key press spells the accelerator the shell takes, by the key’s place, with the platform’s command key', () => {
	const press = (code: string, keys: Partial<KeyboardEvent> = {}) => ({
		code,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...keys,
	});
	expect(
		acceleratorOf(press('Semicolon', { metaKey: true, shiftKey: true }), true),
	).toBe('CommandOrControl+Shift+;');
	expect(
		acceleratorOf(press('Semicolon', { ctrlKey: true, shiftKey: true }), false),
	).toBe('CommandOrControl+Shift+;');
	expect(acceleratorOf(press('KeyK', { ctrlKey: true }), true)).toBe(
		'Control+K',
	);
	expect(acceleratorOf(press('KeyK', { metaKey: true }), false)).toBe(
		'Super+K',
	);
	expect(acceleratorOf(press('Digit5', { altKey: true }), true)).toBe('Alt+5');
	expect(acceleratorOf(press('Space', { altKey: true }), true)).toBe(
		'Alt+Space',
	);
	expect(acceleratorOf(press('F9'), true)).toBe('F9');
	// Only modifiers so far, or a bare key: nothing to set yet.
	expect(acceleratorOf(press('ShiftLeft', { shiftKey: true }), true)).toBe(
		undefined,
	);
	expect(acceleratorOf(press('MetaRight', { metaKey: true }), true)).toBe(
		undefined,
	);
	expect(acceleratorOf(press('KeyA'), true)).toBe(undefined);
	expect(acceleratorOf(press('KeyA', { shiftKey: true }), true)).toBe(
		undefined,
	);
	expect(acceleratorOf(press('F2', { shiftKey: true }), false)).toBe(
		'Shift+F2',
	);
	// Every one reads back as a label.
	expect(labelOf('CommandOrControl+Shift+;', true)).toBe('⌘⇧;');
});

test('a label reads as a Mac menu, or as Windows and Linux spell it', () => {
	expect(labelOf('CommandOrControl+Shift+;', true)).toBe('⌘⇧;');
	expect(labelOf('CommandOrControl+Shift+;', false)).toBe('Ctrl+Shift+;');
	expect(labelOf('Alt+Space', true)).toBe('⌥Space');
	expect(labelOf('Control+k', false)).toBe('Ctrl+K');
});

/**
 * The global shortcut in a Tauri window (`openShortcut` in `shortcut.ts`)
 * over `settings.md` in memory, with a stand-in for the shell's
 * `set_shortcut`.
 *
 * Key behaviors:
 * - A browser has none: `openShortcut` answers null and asks the shell
 *   nothing
 * - The key is `settings.md`'s, else the default
 * - Once the settings were first read, and whenever the key changes, the
 *   shell is asked to hold it, and what it refuses is the problem shown
 * - Saving writes `settings.md`; a key the shell refuses is never written,
 *   and the saved one is held again
 * - A label reads as a Mac menu, or as Windows and Linux spell it
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { encode } from './files/files.js';
import { memoryFiles } from './files/memory.js';

/** Every key the page asked the shell to hold, in order. */
const asked: string[] = [];
/** Keys the shell refuses, as another app holding them would. */
const taken = new Set<string>();
let inTauri = true;
mock.module('@tauri-apps/api/core', () => ({
	// What other importers of the module name; nothing here calls them.
	Channel: class {},
	isTauri: () => inTauri,
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

const { acceleratorOf, labelOf, openShortcut } = await import('./shortcut.js');
const { openPage } = await import('./services.test-support.js');

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	asked.length = 0;
	taken.clear();
});

/** The shortcut over `settings.md` in memory, holding its key once the settings were read. */
async function open(shortcut?: string) {
	const files = memoryFiles(
		shortcut === undefined
			? {}
			: { 'settings.md': encode(`---\nshortcut: "${shortcut}"\n---\n`) },
	);
	// The page reads `settings.md` with the folder, as the app's layout does.
	const page = await openPage(files);
	cleanups.push(page.close);
	const { settings } = page.query;
	const opened = openShortcut(settings);
	if (opened === null) throw new Error('a Tauri window has a shortcut');
	cleanups.push(() => opened[Symbol.dispose]());
	opened.holdNow();
	return { shortcut: opened, settings, files };
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

test('with no settings.md, the default is held once the settings were read', async () => {
	const { shortcut } = await open();
	await until(() => asked.length > 0);
	expect(asked).toEqual(['CommandOrControl+Shift+;']);
	expect(shortcut.accelerator()).toBe('CommandOrControl+Shift+;');
});

test('settings.md’s key is held instead of the default', async () => {
	const { shortcut } = await open('Alt+Space');
	await until(() => asked.length > 0);
	expect(asked).toEqual(['Alt+Space']);
	expect(shortcut.accelerator()).toBe('Alt+Space');
});

test('what the shell refuses is the problem shown', async () => {
	taken.add('Alt+Space');
	const { shortcut } = await open('Alt+Space');
	await until(() => shortcut.problem() !== null);
	expect(shortcut.problem()).toBe('Alt+Space is unavailable: already held');
});

test('saving writes settings.md once the shell holds the key, and asks it once', async () => {
	const { shortcut, settings } = await open();
	await until(() => asked.length > 0);

	expect(await shortcut.save(' Alt+R ')).toBeNull();
	expect(settings.shortcut()).toBe('Alt+R');
	expect(shortcut.accelerator()).toBe('Alt+R');
	expect(asked).toEqual(['CommandOrControl+Shift+;', 'Alt+R']);
	expect(shortcut.problem()).toBeNull();
});

test('a key the shell refuses is never written, and the saved one is held again', async () => {
	const { shortcut, files } = await open();
	await until(() => asked.length > 0);
	taken.add('Alt+Space');
	expect(await shortcut.save('Alt+Space')).toBe(
		'Alt+Space is unavailable: already held',
	);
	expect((await files.read('settings.md')).data).toBeNull();
	expect(asked.slice(-2)).toEqual(['Alt+Space', 'CommandOrControl+Shift+;']);
	expect(await shortcut.save('  ')).toMatch(/^Type a shortcut/);
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

test('a browser has no global shortcut, and asks the shell nothing', async () => {
	inTauri = false;
	try {
		const page = await openPage(memoryFiles());
		cleanups.push(page.close);
		expect(openShortcut(page.query.settings)).toBeNull();
		expect(asked).toEqual([]);
	} finally {
		inTauri = true;
	}
});

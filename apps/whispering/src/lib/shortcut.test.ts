import { expect, test } from 'bun:test';
import { sameShortcut, shortcutLabel, shortcutOf } from './shortcut';

const press = (
	code: string,
	held: Partial<
		Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>
	> = {},
) => ({
	code,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...held,
});

test('a key with modifiers is a shortcut, modifiers first', () => {
	expect(shortcutOf(press('KeyD', { metaKey: true, shiftKey: true }))).toBe(
		'Shift+Command+KeyD',
	);
	expect(shortcutOf(press('Space', { altKey: true }))).toBe('Alt+Space');
});

test('modifiers alone, and a plain key, are not a shortcut yet', () => {
	expect(shortcutOf(press('ShiftLeft', { shiftKey: true }))).toBeUndefined();
	expect(shortcutOf(press('MetaRight', { metaKey: true }))).toBeUndefined();
	expect(shortcutOf(press('KeyD'))).toBeUndefined();
});

test('a function key needs no modifier', () => {
	expect(shortcutOf(press('F5'))).toBe('F5');
});

test('a Mac reads symbols, and a word stands apart', () => {
	expect(shortcutLabel('CommandOrControl+Shift+Semicolon', true)).toBe('⌘⇧;');
	expect(shortcutLabel('Alt+Space', true)).toBe('⌥ Space');
	expect(shortcutLabel('Shift+Command+KeyD', true)).toBe('⇧⌘D');
});

test('elsewhere the keys are named and joined', () => {
	expect(shortcutLabel('CommandOrControl+Shift+Semicolon', false)).toBe(
		'Ctrl+Shift+;',
	);
	expect(shortcutLabel('Alt+Digit1', false)).toBe('Alt+1');
});

test('no shortcut reads as nothing', () => {
	expect(shortcutLabel('', true)).toBe('');
});

test('keys that would be lost to typing are not a shortcut', () => {
	// A capital A, a Shift+Space, and Option+E, which types an accent on a Mac.
	expect(shortcutOf(press('KeyA', { shiftKey: true }))).toBeUndefined();
	expect(shortcutOf(press('Space', { shiftKey: true }))).toBeUndefined();
	expect(shortcutOf(press('KeyE', { altKey: true }))).toBeUndefined();
	expect(shortcutOf(press('KeyE', { altKey: true, ctrlKey: true }))).toBe(
		'Control+Alt+KeyE',
	);
});

test('the same keys are the same shortcut however they are written', () => {
	const written = 'CommandOrControl+Shift+Semicolon';
	expect(sameShortcut(written, 'Shift+Command+Semicolon', true)).toBe(true);
	expect(sameShortcut(written, 'Shift+Command+Semicolon', false)).toBe(false);
	expect(sameShortcut('Alt+Space', 'Alt+Shift+Space', true)).toBe(false);
});

import { expect, test } from 'bun:test';
import { shortcutLabel, shortcutOf } from './shortcut';

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

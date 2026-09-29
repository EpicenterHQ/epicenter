/** Key binding serialization, capture vocabulary, and realized-reach behavior. */
import { expect, test } from 'bun:test';
import {
	createModifierLatch,
	domCodeToKey,
	eventKeyModifier,
	eventModifiers,
	isRegistrableChord,
	keyBindingToAccelerator,
	realizedReach,
} from './key-binding';

test('a chord maps to a global-hotkey accelerator', () => {
	// meta -> Super, space -> Space: the default macOS toggle. Modifiers emit in
	// the shared fixed order (shift before meta), which the parser accepts in any
	// order anyway.
	expect(
		keyBindingToAccelerator({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBe('Shift+Super+Space');
});

test('modifiers serialize in a fixed order regardless of input order', () => {
	expect(
		keyBindingToAccelerator({ modifiers: ['shift', 'ctrl'], keys: ['dot'] }),
	).toBe('Control+Shift+Period');
});

test('letter and digit keys map to Code tokens', () => {
	expect(keyBindingToAccelerator({ modifiers: ['ctrl'], keys: ['keyD'] })).toBe(
		'Control+KeyD',
	);
	expect(keyBindingToAccelerator({ modifiers: ['alt'], keys: ['num1'] })).toBe(
		'Alt+Digit1',
	);
});

test('an Fn binding has no accelerator', () => {
	// Fn has no accelerator spelling, so it is not a registrable chord.
	expect(
		keyBindingToAccelerator({ modifiers: ['fn'], keys: ['space'] }),
	).toBeNull();
});

test('a modifier-only hold has no accelerator', () => {
	expect(keyBindingToAccelerator({ modifiers: ['meta'], keys: [] })).toBeNull();
});

test('a bare key with no modifier is refused', () => {
	expect(keyBindingToAccelerator({ modifiers: [], keys: ['keyA'] })).toBeNull();
});

test('isRegistrableChord names the registrable-chord boundary', () => {
	// A chord (one key plus a non-Fn modifier) is the only registrable global
	// shape; Fn holds, modifier-only holds, and bare keys are not.
	expect(
		isRegistrableChord({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBe(true);
	expect(isRegistrableChord({ modifiers: ['fn'], keys: ['space'] })).toBe(
		false,
	);
	expect(isRegistrableChord({ modifiers: ['meta'], keys: [] })).toBe(false);
	expect(isRegistrableChord({ modifiers: [], keys: ['keyA'] })).toBe(false);
});

test('domCodeToKey maps physical codes to our Key space', () => {
	expect(domCodeToKey('KeyD')).toBe('keyD');
	expect(domCodeToKey('Digit1')).toBe('num1');
	expect(domCodeToKey('Space')).toBe('space');
	expect(domCodeToKey('Enter')).toBe('return');
	expect(domCodeToKey('Period')).toBe('dot');
	expect(domCodeToKey('BracketLeft')).toBe('leftBracket');
	expect(domCodeToKey('F5')).toBe('f5');
});

test('domCodeToKey rejects modifier codes and anything off the chord alphabet', () => {
	// Modifiers are read from the event's flags, not its code.
	expect(domCodeToKey('MetaLeft')).toBeNull();
	expect(domCodeToKey('ShiftRight')).toBeNull();
	expect(domCodeToKey('ControlLeft')).toBeNull();
	// Outside the alphabet keyBindingToAccelerator can spell.
	expect(domCodeToKey('Numpad1')).toBeNull();
	expect(domCodeToKey('Lang1')).toBeNull();
});

test('WebKitGTK Super enters the global meta modifier lifecycle', () => {
	const superEvent = {
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		key: 'Super',
	};
	const physicalKeyEvent = { ...superEvent, key: 'd' };

	expect(eventModifiers(superEvent)).toEqual([]);
	expect(eventKeyModifier(superEvent)).toBe('meta');
	const latch = createModifierLatch();
	expect(latch.keydown(superEvent)).toEqual(['meta']);
	expect(latch.keydown(physicalKeyEvent)).toEqual(['meta']);
	expect(latch.keyup(superEvent)).toEqual([]);
});

test('Meta and OS use the same modifier-key fallback as Super', () => {
	const event = {
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		key: 'Meta',
	};
	expect(eventKeyModifier(event)).toBe('meta');
	expect(eventKeyModifier({ ...event, key: 'OS' })).toBe('meta');
});

test('domCodeToKey is the inverse of acceleratorKey for every chord key', () => {
	// Every key a chord can carry round-trips: Key -> accelerator code -> Key. This
	// is what guarantees a webview-captured code always lands on a bindable Key.
	const keys = [
		'keyA',
		'keyZ',
		'num0',
		'num9',
		'f1',
		'f12',
		'space',
		'return',
		'comma',
		'slash',
		'leftBracket',
		'semiColon',
	] as const;
	for (const key of keys) {
		const code = keyBindingToAccelerator({ modifiers: ['ctrl'], keys: [key] })
			?.split('+')
			.at(-1);
		expect(code).toBeDefined();
		expect(domCodeToKey(code as string)).toBe(key);
	}
});

// The worked table from ADR-0052: realizedReach = min(command, key, platform).
test('realizedReach: a global command on a bare key on web is focused', () => {
	expect(
		realizedReach('global', { modifiers: [], keys: ['space'] }, 'focused'),
	).toBe('focused');
});

test('realizedReach: a global command on a chord on desktop is global', () => {
	expect(
		realizedReach(
			'global',
			{ modifiers: ['meta', 'shift'], keys: ['space'] },
			'global',
		),
	).toBe('global');
});

test('realizedReach: a global command on a bare key on desktop is focused', () => {
	// The key shape, not the platform, is the binding floor here.
	expect(
		realizedReach('global', { modifiers: [], keys: ['space'] }, 'global'),
	).toBe('focused');
});

test('realizedReach: a focused command on a chord on desktop stays focused', () => {
	// The command's nature is the floor: a capable chord cannot escape it.
	expect(
		realizedReach(
			'focused',
			{ modifiers: ['meta'], keys: ['comma'] },
			'global',
		),
	).toBe('focused');
});

test('realizedReach: a refused Fn hold never reaches global', () => {
	// A hold is not a registrable chord, so its key capability caps at focused
	// regardless of the platform ceiling.
	expect(
		realizedReach('global', { modifiers: ['fn'], keys: [] }, 'global'),
	).toBe('focused');
});

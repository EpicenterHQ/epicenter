/**
 * Pure rules for a shortcut's keys: writing them from a key press, as the
 * desktop app's shortcut parser reads them, and showing them to a person.
 *
 * ```txt
 * a key press           →  'Command+Shift+KeyD'  →  '⌘⇧D'  (or 'Win+Shift+D')
 * settings.json default →  'CommandOrControl+Shift+Semicolon'  →  '⌘⇧;'
 * ```
 */

/** The parts of a `KeyboardEvent` a shortcut is read from. */
type Press = Pick<
	KeyboardEvent,
	'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

/** Codes that are a modifier going down on its own, which is no shortcut yet. */
const MODIFIER = /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/;
/** A function key works as a shortcut with no modifier; any other key would be lost to typing. */
const FUNCTION_KEY = /^F\d{1,2}$/;

/** Keys that type a character: with Shift or Option they still type one (`A`, `é`). */
const TYPES =
	/^(Key[A-Z]|Digit\d|Numpad.+|Semicolon|Quote|Comma|Period|Slash|Backslash|Backquote|BracketLeft|BracketRight|Minus|Equal)$/;

/**
 * The shortcut `press` makes, or undefined while it is not one: only
 * modifiers are down, or the keys would be lost to typing in every app. A
 * global shortcut takes its keys from whatever app is in front, so a key
 * that types needs Control or Command, and any other key but a function
 * key needs Control, Command or Option. Shift alone is never enough.
 */
export function shortcutOf(press: Press): string | undefined {
	if (!press.code || MODIFIER.test(press.code)) return undefined;
	const strong = press.ctrlKey || press.metaKey;
	const enough = TYPES.test(press.code)
		? strong
		: strong || press.altKey || FUNCTION_KEY.test(press.code);
	if (!enough) return undefined;
	const modifiers = [
		press.ctrlKey && 'Control',
		press.altKey && 'Alt',
		press.shiftKey && 'Shift',
		press.metaKey && 'Command',
	].filter((modifier) => modifier !== false);
	return [...modifiers, press.code].join('+');
}

/**
 * Whether `a` and `b` are the same keys here, however each is written:
 * `CommandOrControl` is Command on a Mac and Control elsewhere, and the
 * order of modifiers does not matter.
 */
export function sameShortcut(a: string, b: string, mac: boolean): boolean {
	const keys = (shortcut: string) =>
		shortcut
			.split('+')
			.map((part) =>
				part === 'CommandOrControl' ? (mac ? 'Command' : 'Control') : part,
			)
			.sort()
			.join('+');
	return keys(a) === keys(b);
}

const MAC: Record<string, string> = {
	CommandOrControl: '⌘',
	Command: '⌘',
	Control: '⌃',
	Alt: '⌥',
	Shift: '⇧',
};
const OTHER: Record<string, string> = {
	CommandOrControl: 'Ctrl',
	Command: 'Win',
	Control: 'Ctrl',
};
const KEYS: Record<string, string> = {
	Semicolon: ';',
	Quote: "'",
	Comma: ',',
	Period: '.',
	Slash: '/',
	Backslash: '\\',
	Backquote: '`',
	BracketLeft: '[',
	BracketRight: ']',
	Minus: '-',
	Equal: '=',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Enter: '↩',
	Escape: 'Esc',
};

/** `keys` as a person reads them: `⌘⇧;` on a Mac, `Ctrl+Shift+;` elsewhere. Empty for no shortcut. */
export function shortcutLabel(keys: string, mac: boolean): string {
	if (!keys) return '';
	const parts = keys.split('+').map((part) => {
		const named = (mac ? MAC : OTHER)[part] ?? KEYS[part];
		if (named) return named;
		return part.replace(/^(Key|Digit)(?=.$)/, '');
	});
	// Mac symbols read as one cluster; a word such as Space stands apart.
	if (!mac) return parts.join('+');
	return parts.reduce(
		(label, part) => label + (part.length > 1 && label ? ` ${part}` : part),
		'',
	);
}

/** Whether this is a Mac, which writes shortcuts as symbols. */
export const isMac = () =>
	typeof navigator !== 'undefined' &&
	/Mac|iPhone|iPad/.test(navigator.platform);

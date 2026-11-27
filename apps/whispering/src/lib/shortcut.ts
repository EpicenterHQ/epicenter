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

/**
 * The shortcut `press` makes, or undefined while it is not one yet: only
 * modifiers are down, or a plain key with no modifier.
 */
export function shortcutOf(press: Press): string | undefined {
	if (!press.code || MODIFIER.test(press.code)) return undefined;
	const modifiers = [
		press.ctrlKey && 'Control',
		press.altKey && 'Alt',
		press.shiftKey && 'Shift',
		press.metaKey && 'Command',
	].filter((modifier) => modifier !== false);
	if (modifiers.length === 0 && !FUNCTION_KEY.test(press.code))
		return undefined;
	return [...modifiers, press.code].join('+');
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

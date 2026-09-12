/**
 * The shared `KeyBinding` core: define, parse, serialize, label, and match the
 * structured physical binding both shortcut reaches speak. No Tauri dependency
 * and no DOM side effects; the only DOM contact is reading `KeyboardEvent` fields
 * (`.code`, the modifier flags, and modifier key names) in
 * {@link domCodeToKey}, {@link eventModifiers}, and {@link eventKeyModifier},
 * which form the capture side of the same physical-key model.
 */

/**
 * A physical key in position space (`keyD` is the D-position key regardless of
 * layout). A stable enum so the persisted binding format never drifts; keys
 * outside this set are not bindable.
 */
export type Key =
	| 'keyA'
	| 'keyB'
	| 'keyC'
	| 'keyD'
	| 'keyE'
	| 'keyF'
	| 'keyG'
	| 'keyH'
	| 'keyI'
	| 'keyJ'
	| 'keyK'
	| 'keyL'
	| 'keyM'
	| 'keyN'
	| 'keyO'
	| 'keyP'
	| 'keyQ'
	| 'keyR'
	| 'keyS'
	| 'keyT'
	| 'keyU'
	| 'keyV'
	| 'keyW'
	| 'keyX'
	| 'keyY'
	| 'keyZ'
	| 'num0'
	| 'num1'
	| 'num2'
	| 'num3'
	| 'num4'
	| 'num5'
	| 'num6'
	| 'num7'
	| 'num8'
	| 'num9'
	| 'f1'
	| 'f2'
	| 'f3'
	| 'f4'
	| 'f5'
	| 'f6'
	| 'f7'
	| 'f8'
	| 'f9'
	| 'f10'
	| 'f11'
	| 'f12'
	| 'f13'
	| 'f14'
	| 'f15'
	| 'f16'
	| 'f17'
	| 'f18'
	| 'f19'
	| 'f20'
	| 'f21'
	| 'f22'
	| 'f23'
	| 'f24'
	| 'space'
	| 'return'
	| 'tab'
	| 'escape'
	| 'backspace'
	| 'delete'
	| 'insert'
	| 'upArrow'
	| 'downArrow'
	| 'leftArrow'
	| 'rightArrow'
	| 'home'
	| 'end'
	| 'pageUp'
	| 'pageDown'
	| 'minus'
	| 'equal'
	| 'leftBracket'
	| 'rightBracket'
	| 'semiColon'
	| 'quote'
	| 'backQuote'
	| 'backSlash'
	| 'comma'
	| 'dot'
	| 'slash';

/**
 * A logical modifier. Left and right collapse (ControlLeft and ControlRight both
 * become `ctrl`). `fn` has no plugin accelerator spelling, so a binding carrying
 * it is not a registrable global chord.
 */
export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta' | 'fn';

/**
 * A shortcut binding. A registrable global chord is exactly one key plus at
 * least one non-Fn modifier; focused shortcuts may also use bare keys.
 */
export type KeyBinding = {
	modifiers: Modifier[];
	keys: Key[];
};

/**
 * How far a shortcut fires, ordered `focused < global`. The one reach scale,
 * shared by a command's intrinsic ceiling, a key's capability, the platform, and
 * the realized minimum of the three. There is no separate "system" word: a
 * binding whose realized reach is `global` is the one that lives in the
 * per-device store. See ADR-0052.
 */
export type Reach = 'focused' | 'global';

/**
 * A binding for display and deduplication. Accepts both `KeyBinding` and the
 * structurally validated device-config shape (`keys: string[]`).
 */
export type BindingLike = {
	modifiers: readonly Modifier[];
	keys: readonly string[];
};

const MODIFIER_LABELS_APPLE: Record<Modifier, string> = {
	ctrl: '⌃',
	alt: '⌥',
	shift: '⇧',
	meta: '⌘',
	fn: 'fn',
};

const MODIFIER_LABELS_OTHER: Record<Modifier, string> = {
	ctrl: 'Ctrl',
	alt: 'Alt',
	shift: 'Shift',
	meta: 'Super',
	fn: 'Fn',
};

// Fixed display order so the same binding always renders the same way.
const MODIFIER_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'meta', 'fn'];

const KEY_LABELS: Record<string, string> = {
	space: 'Space',
	return: 'Enter',
	tab: 'Tab',
	escape: 'Esc',
	backspace: '⌫',
	delete: 'Del',
	insert: 'Ins',
	upArrow: '↑',
	downArrow: '↓',
	leftArrow: '←',
	rightArrow: '→',
	home: 'Home',
	end: 'End',
	pageUp: 'PgUp',
	pageDown: 'PgDn',
	minus: '-',
	equal: '=',
	leftBracket: '[',
	rightBracket: ']',
	semiColon: ';',
	quote: "'",
	backQuote: '`',
	backSlash: '\\',
	comma: ',',
	dot: '.',
	slash: '/',
};

function keyLabel(key: string): string {
	const named = KEY_LABELS[key];
	if (named) return named;
	if (key.startsWith('key')) return key.slice(3); // keyD -> D
	if (key.startsWith('num')) return key.slice(3); // num1 -> 1
	if (/^f\d+$/.test(key)) return key.toUpperCase(); // f1 -> F1
	return key;
}

/**
 * Render a binding as a compact label: `⌘⇧D` on macOS, `Ctrl+Shift+D`
 * elsewhere. Modifiers come first in a fixed order, then keys. An empty binding
 * renders as the empty string (callers show a placeholder).
 */
export function keyBindingToLabel(
	binding: BindingLike,
	isApple: boolean,
): string {
	const labels = isApple ? MODIFIER_LABELS_APPLE : MODIFIER_LABELS_OTHER;
	const separator = isApple ? '' : '+';
	const modifiers = MODIFIER_ORDER.filter((modifier) =>
		binding.modifiers.includes(modifier),
	).map((modifier) => labels[modifier]);
	const keys = binding.keys.map(keyLabel);
	return [...modifiers, ...keys].join(separator);
}

/**
 * Accelerator modifier tokens for `tauri-plugin-global-shortcut`. `meta` becomes
 * `Super`, which the global-hotkey parser maps to Command on macOS and the
 * Super/Windows key elsewhere. `fn` has no accelerator spelling (Carbon's
 * `RegisterEventHotKey` cannot bind it), so a binding that carries Fn is not a
 * registrable chord and {@link keyBindingToAccelerator} returns `null` for it.
 */
const ACCELERATOR_MODIFIERS: Record<Modifier, string | null> = {
	ctrl: 'Control',
	alt: 'Alt',
	shift: 'Shift',
	meta: 'Super',
	fn: null,
};

/** `Key` -> a global-hotkey `Code` token (the parser is case-insensitive). */
const ACCELERATOR_KEYS: Record<string, string> = {
	space: 'Space',
	return: 'Enter',
	tab: 'Tab',
	escape: 'Escape',
	backspace: 'Backspace',
	delete: 'Delete',
	insert: 'Insert',
	upArrow: 'ArrowUp',
	downArrow: 'ArrowDown',
	leftArrow: 'ArrowLeft',
	rightArrow: 'ArrowRight',
	home: 'Home',
	end: 'End',
	pageUp: 'PageUp',
	pageDown: 'PageDown',
	minus: 'Minus',
	equal: 'Equal',
	leftBracket: 'BracketLeft',
	rightBracket: 'BracketRight',
	semiColon: 'Semicolon',
	quote: 'Quote',
	backQuote: 'Backquote',
	backSlash: 'Backslash',
	comma: 'Comma',
	dot: 'Period',
	slash: 'Slash',
};

function acceleratorKey(key: string): string | null {
	const named = ACCELERATOR_KEYS[key];
	if (named) return named;
	if (/^key[A-Z]$/.test(key)) return `Key${key.slice(3)}`; // keyD -> KeyD
	if (/^num[0-9]$/.test(key)) return `Digit${key.slice(3)}`; // num1 -> Digit1
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase(); // f1 -> F1
	return null;
}

/**
 * Render a binding as a `tauri-plugin-global-shortcut` accelerator string (for
 * example `Control+Shift+Space`), or `null` when the plugin cannot register it.
 * A binding has no accelerator when it carries Fn (no accelerator spelling) or is
 * not exactly one key plus at least one modifier. Fn and modifier-only holds are
 * refused as a product surface (ADR-0117), so a binding with no accelerator is
 * simply not a valid global shortcut. Modifiers are emitted in a fixed order so
 * the same binding always produces the same accelerator.
 */
export function keyBindingToAccelerator(binding: BindingLike): string | null {
	const [key, ...rest] = binding.keys;
	if (!key || rest.length > 0) return null; // accelerators carry exactly one key
	if (binding.modifiers.length === 0) return null; // a bare key is not a gesture
	const modifiers: string[] = [];
	for (const modifier of MODIFIER_ORDER) {
		if (!binding.modifiers.includes(modifier)) continue;
		const token = ACCELERATOR_MODIFIERS[modifier];
		if (!token) return null; // fn has no accelerator: not a registrable chord
		modifiers.push(token);
	}
	const keyToken = acceleratorKey(key);
	if (!keyToken) return null;
	return [...modifiers, keyToken].join('+');
}

/**
 * Whether a binding is a registrable global chord: exactly one key plus at least
 * one non-Fn modifier, which `tauri-plugin-global-shortcut` can register with no
 * Accessibility grant. An Fn hold, a modifier-only hold, and a bare key are not
 * registrable global shortcuts.
 */
export function isRegistrableChord(binding: BindingLike): boolean {
	return keyBindingToAccelerator(binding) !== null;
}

/**
 * How far a key can fire, by its physical shape alone (the second term of the
 * reach formula, ADR-0052). A registrable chord (a non-Fn modifier plus a key)
 * fires globally with no permission. Anything else (a bare key, or a refused Fn /
 * modifier-only hold) reaches at most in-app: a global bare key would swallow
 * that key in every app, and holds are not valid global shortcuts. No shortcut
 * reach needs an Accessibility grant (ADR-0117). Callers pass a non-empty binding.
 */
function keyCapability(binding: BindingLike): Reach {
	return isRegistrableChord(binding) ? 'global' : 'focused';
}

/** `focused` is more restrictive than `global`; the smaller reach wins a min(). */
const REACH_RANK: Record<Reach, number> = { focused: 0, global: 1 };

function minReach(a: Reach, b: Reach): Reach {
	return REACH_RANK[b] < REACH_RANK[a] ? b : a;
}

/**
 * The reach a binding actually achieves for a command on a platform: the minimum
 * of the command's intrinsic ceiling, the key's capability, and what the
 * platform allows (web caps at `focused`, desktop reaches `global`). The most
 * restrictive wins, so reach only ever clamps down, never up. This is the one
 * place the reach formula lives, fed `command.reach` and a `platformReach` so it
 * stays free of catalog and platform imports. See ADR-0052.
 */
export function realizedReach(
	commandReach: Reach,
	binding: BindingLike,
	platformReach: Reach,
): Reach {
	return minReach(
		minReach(commandReach, keyCapability(binding)),
		platformReach,
	);
}

/**
 * Inverse of {@link ACCELERATOR_KEYS}: a W3C `KeyboardEvent.code` token back to
 * our `Key`. Built from the same source so the two directions can never drift.
 */
const KEY_BY_ACCELERATOR_CODE: Record<string, string> = Object.fromEntries(
	Object.entries(ACCELERATOR_KEYS).map(([key, code]) => [code, key]),
);

/**
 * Map a physical `KeyboardEvent.code` (for example `KeyD`, `Digit1`, `Space`)
 * to our `Key`, or `null` when the code is not a bindable key (a modifier code
 * like `MetaLeft`, or anything outside the chord alphabet). Reading `.code` not
 * `.key` keeps capture in physical-key space, sidestepping the macOS
 * Option-character problem the `.key`-based local recorder has to normalize. The
 * accepted set is exactly the one {@link keyBindingToAccelerator} can spell, so a
 * chord captured here always routes to the plugin. The inverse of
 * {@link acceleratorKey}.
 */
export function domCodeToKey(code: string): Key | null {
	const named = KEY_BY_ACCELERATOR_CODE[code];
	if (named) return named as Key;
	if (/^Key[A-Z]$/.test(code)) return `key${code.slice(3)}` as Key; // KeyD -> keyD
	if (/^Digit[0-9]$/.test(code)) return `num${code.slice(5)}` as Key; // Digit1 -> num1
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase() as Key; // F1 -> f1
	return null;
}

type ModifierEvent = {
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
	readonly metaKey: boolean;
	readonly key: string;
};

/** Read the modifiers the browser reports as currently held. */
export function eventModifiers(e: ModifierEvent): Modifier[] {
	const modifiers: Modifier[] = [];
	if (e.ctrlKey) modifiers.push('ctrl');
	if (e.altKey) modifiers.push('alt');
	if (e.shiftKey) modifiers.push('shift');
	if (e.metaKey) modifiers.push('meta');
	return modifiers;
}

/**
 * Map a modifier keydown or keyup to our modifier space. WebKitGTK exposes
 * Linux Super as `Super` without setting `metaKey`; `OS` is its older browser
 * spelling. Fn has no reliable browser event and remains unsupported.
 */
export function eventKeyModifier(e: ModifierEvent): Modifier | null {
	switch (e.key) {
		case 'Control':
			return 'ctrl';
		case 'Alt':
			return 'alt';
		case 'Shift':
			return 'shift';
		case 'Meta':
		case 'OS':
		case 'Super':
			return 'meta';
		default:
			return null;
	}
}

/**
 * Carry a modifier whose browser flag is missing from its keydown through the
 * rest of that physical gesture. Keyup removes the fallback before matching,
 * so the released modifier cannot strand a hold active.
 */
export function createModifierLatch() {
	const fallbackModifiers = new Set<Modifier>();
	const held = (e: ModifierEvent): Modifier[] => [
		...new Set([...eventModifiers(e), ...fallbackModifiers]),
	];

	return {
		keydown(e: ModifierEvent): Modifier[] {
			const modifier = eventKeyModifier(e);
			if (modifier !== null && !eventModifiers(e).includes(modifier)) {
				fallbackModifiers.add(modifier);
			}
			return held(e);
		},
		keyup(e: ModifierEvent): Modifier[] {
			const modifier = eventKeyModifier(e);
			if (modifier !== null) fallbackModifiers.delete(modifier);
			return held(e);
		},
		reset(): void {
			fallbackModifiers.clear();
		},
	};
}

/** A binding with no modifiers and no keys can never fire; treat it as unset. */
export function isEmptyBinding(binding: BindingLike): boolean {
	return binding.modifiers.length === 0 && binding.keys.length === 0;
}

/** Whether every modifier and key of `subset` is also present in `superset`. */
function isContainedBy(subset: BindingLike, superset: BindingLike): boolean {
	return (
		subset.modifiers.every((m) => superset.modifiers.includes(m)) &&
		subset.keys.every((k) => superset.keys.includes(k))
	);
}

/**
 * Whether two bindings are the same gesture: identical modifier and key sets,
 * order-independent. The browser matcher arms a shortcut when the live held set
 * equals its stored binding, so this is the in-app match test.
 */
export function bindingsEqual(a: BindingLike, b: BindingLike): boolean {
	return isContainedBy(a, b) && isContainedBy(b, a);
}

/**
 * The global shortcut (`src-tauri/src/shortcut.rs`): which key, where it is
 * set, and the shell's hold on it. Only a Tauri window has one: a page
 * cannot hold a key while another app has focus, so `openShortcut` answers
 * null in a browser (ADR-0780, ADR-0781), and the app shows its settings
 * and hears its presses only where it is (`{#if shortcut}`). The shell
 * holds the key while Whispering runs and sends each press; the page
 * decides what a press does (`onPress`).
 *
 * The key is `shortcut` in `settings.md` (ADR-0894), which travels with
 * the folder; two computers sharing a folder share one shortcut. Rust never
 * reads the note: once it is read, and whenever the key changes, the page
 * asks the shell to hold it (`set_shortcut`).
 *
 * `openShortcut` makes a capability, once, in `src/lib/app.ts`, read
 * through `reactive`: reads answer at once, and `subscribe` hears them
 * change.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Settings } from './folder-query.js';

/**
 * The global shortcut: the key `settings.md` names and the shell's hold on
 * it. Reads answer at once; `subscribe` hears them change.
 */
export type GlobalShortcut = {
	/** The key, in the global-shortcut plugin's spelling. */
	accelerator(): string;
	/** The key as a person reads it. */
	label(): string;
	/** Why the shell does not hold the key, or null. */
	problem(): string | null;
	subscribe(listener: () => void): () => void;
	/** Hear each press of the shortcut, from any app; returns the unsubscribe. */
	onPress(listener: () => void): () => void;
	/** Make `typed` the shortcut; why it was not saved, or null. */
	save(typed: string): Promise<string | null>;
	[Symbol.dispose](): void;
};

const isMac = navigator.userAgent.includes('Mac');

/** Each modifier as a Mac menu shows it, and as Windows and Linux spell it. */
const MODIFIERS: Record<string, { mac: string; other: string }> = {
	COMMANDORCONTROL: { mac: '⌘', other: 'Ctrl' },
	COMMANDORCTRL: { mac: '⌘', other: 'Ctrl' },
	CMDORCTRL: { mac: '⌘', other: 'Ctrl' },
	CMDORCONTROL: { mac: '⌘', other: 'Ctrl' },
	COMMAND: { mac: '⌘', other: 'Super' },
	CMD: { mac: '⌘', other: 'Super' },
	SUPER: { mac: '⌘', other: 'Super' },
	SHIFT: { mac: '⇧', other: 'Shift' },
	ALT: { mac: '⌥', other: 'Alt' },
	OPTION: { mac: '⌥', other: 'Alt' },
	CONTROL: { mac: '⌃', other: 'Ctrl' },
	CTRL: { mac: '⌃', other: 'Ctrl' },
};

/** `accelerator` (`CommandOrControl+Shift+;`) as a person reads it: `⌘⇧;` on a Mac, `Ctrl+Shift+;` elsewhere. */
export function labelOf(accelerator: string, mac = isMac): string {
	const parts = accelerator.split('+').map((part) => {
		const modifier = MODIFIERS[part.trim().toUpperCase()];
		if (modifier !== undefined) return mac ? modifier.mac : modifier.other;
		return part.trim().length === 1 ? part.trim().toUpperCase() : part.trim();
	});
	return parts.join(mac ? '' : '+');
}

/** Keys whose code names a character the accelerator spells as that character. */
const CHARACTERS: Record<string, string> = {
	Backquote: '`',
	Backslash: '\\',
	BracketLeft: '[',
	BracketRight: ']',
	Comma: ',',
	Equal: '=',
	Minus: '-',
	Period: '.',
	Quote: "'",
	Semicolon: ';',
	Slash: '/',
};

/**
 * The accelerator a key press spells (`CommandOrControl+Shift+;`), named by
 * the key's place on the keyboard (`event.code`), so the layout and Shift do
 * not change it, in the names the shell's parser takes. Undefined while only
 * modifiers are down, and for a key with no modifier but Shift unless it is
 * a function key: a global shortcut on a letter that types would take it
 * from every app.
 * The platform's command key (⌘ on a Mac, Ctrl elsewhere) is
 * `CommandOrControl`, so a shortcut set on one computer means the same on
 * the other.
 */
export function acceleratorOf(
	event: Pick<
		KeyboardEvent,
		'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
	>,
	mac = isMac,
): string | undefined {
	const { code } = event;
	if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(code) || code === '')
		return undefined;
	const key =
		CHARACTERS[code] ??
		/^Key([A-Z])$/.exec(code)?.[1] ??
		/^Digit(\d)$/.exec(code)?.[1] ??
		code;
	const command = mac ? event.metaKey : event.ctrlKey;
	const other = mac ? event.ctrlKey : event.metaKey;
	const modifiers = [
		command && 'CommandOrControl',
		other && (mac ? 'Control' : 'Super'),
		event.altKey && 'Alt',
		event.shiftKey && 'Shift',
	].filter((modifier): modifier is string => modifier !== false);
	// Shift alone only types a capital: it needs another modifier too.
	const held = modifiers.filter((modifier) => modifier !== 'Shift');
	if (held.length === 0 && !/^F\d{1,2}$/.test(key)) return undefined;
	return [...modifiers, key].join('+');
}

/** Ask the shell to hold `accelerator`: null once it does, else why not. */
function hold(accelerator: string): Promise<string | null> {
	return invoke('set_shortcut', { accelerator }).then(
		() => null,
		(cause: unknown) => extractErrorMessage(cause),
	);
}

/**
 * The global shortcut over `settings`, followed from now on for the page's
 * life, or null outside a Tauri window. Whenever the key changes, the shell
 * is asked to hold it; `holdNow` asks once the settings were first read.
 */
export function openShortcut(
	settings: Pick<Settings, 'shortcut' | 'setShortcut' | 'subscribe'>,
): (GlobalShortcut & { holdNow(): void }) | null {
	if (!isTauri()) return null;
	/** The last key the shell was asked to hold, and its answer once it came. */
	let asked: string | undefined;
	let held: { accelerator: string; problem: string | null } | undefined;
	let started = false;
	const listeners = new Set<() => void>();

	/** Ask the shell to hold the key when it changed. */
	function holdKey() {
		if (!started) return;
		const key = settings.shortcut();
		if (key === asked) return;
		asked = key;
		void hold(key).then((problem) => {
			if (asked !== key) return;
			held = { accelerator: key, problem };
			tell();
		});
	}

	function tell() {
		for (const listener of [...listeners]) listener();
	}

	// Followed for the page's life, as the shell holds the key for it.
	const stop = settings.subscribe(() => {
		holdKey();
		tell();
	});

	return {
		/** Start holding the key, once `settings.md` was first read. */
		holdNow() {
			started = true;
			holdKey();
		},
		accelerator: () => settings.shortcut(),
		label: () => labelOf(settings.shortcut()),
		problem: () =>
			held?.accelerator === settings.shortcut() ? held.problem : null,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		onPress,
		/**
		 * Make `typed` the shortcut in `settings.md`. The shell must hold it
		 * first, so a key that does not parse or that another app holds is
		 * never written. Answers why it was not saved, or null.
		 */
		async save(typed: string): Promise<string | null> {
			const key = typed.trim();
			if (key === '')
				return 'Type a shortcut, such as CommandOrControl+Shift+;.';
			const refused = await hold(key);
			if (refused !== null) {
				void hold(settings.shortcut());
				return refused;
			}
			// Held now, so the change `settings.md` reports asks the shell nothing more.
			asked = key;
			held = { accelerator: key, problem: null };
			const saved = await settings.setShortcut(key);
			if (saved.error !== null) {
				asked = undefined;
				holdKey();
				return saved.error.message;
			}
			return null;
		},
		/** Stop following `settings.md`; the shell keeps the key it holds. */
		[Symbol.dispose]: stop,
	};
}

/** Hear each press of the global shortcut, the shell's event code loaded with the first. Answers the unsubscribe. */
function onPress(listener: () => void): () => void {
	let stop: (() => void) | undefined;
	let stopped = false;
	void import('@tauri-apps/api/event')
		.then(({ listen }) => listen('whispering://toggle-recording', listener))
		.then((unlisten) => {
			if (stopped) unlisten();
			else stop = unlisten;
		});
	return () => {
		stopped = true;
		stop?.();
	};
}

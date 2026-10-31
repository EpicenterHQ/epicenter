/**
 * The global shortcut in the desktop window (`src-tauri/src/shortcut.rs`):
 * which key, where it is set, and the shell's hold on it. The shell holds
 * the key while Whispering runs and sends each press; the page decides what
 * a press does (`onShortcut`).
 *
 * The key is `toggleRecording` in `shortcuts.md`, resolved with a shallow
 * spread: the default, then the data folder's note (synced with the files),
 * then the AppData root's (this computer only). Rust never reads the note
 * (decision 89): once both notes are read, and whenever the resolved key
 * changes, the page asks the shell to hold it (`set_shortcut`).
 */
import type { ReactiveClient, ReactiveNotes } from '@epicenter/svelte/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createContext } from 'svelte';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Whispering } from '../contract.js';
import {
	keysOf,
	SHORTCUT_DEFAULTS,
	type WhisperingSettings,
} from '../settings.tauri.js';

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
 * The global shortcut over the window's two roots, each the client the
 * desktop root wrapped once. Call while a component initializes: it holds
 * the resolved key for that component's life.
 */
export function globalShortcut({
	appData,
	device,
}: {
	appData: ReactiveClient<WhisperingSettings>;
	device: ReactiveClient<Whispering>;
}) {
	const here = $derived(appData.shortcuts.get({}));
	const shortcuts = $derived({
		...SHORTCUT_DEFAULTS,
		...keysOf(device.shortcuts.get({})),
		...keysOf(here),
	});
	/** The key alone, so a note read again with the same key asks the shell nothing. */
	const accelerator = $derived(shortcuts.toggleRecording);
	const read = $derived(
		!appData.shortcuts.loading && !device.shortcuts.loading,
	);
	/** The shell's answer for the last key asked for. */
	let held = $state<{ accelerator: string; problem: string | null }>();

	$effect(() => {
		if (!read) return;
		const asked = accelerator;
		void hold(asked).then((problem) => {
			if (asked === accelerator) held = { accelerator: asked, problem };
		});
	});

	/** Set `toggleRecording` in `notes` to `key`, making the note when there is none. */
	async function write(
		notes: ReactiveNotes<Whispering['collections']['shortcuts']>,
		key: string,
	) {
		const written =
			notes.get({}) === undefined
				? await notes.create({ toggleRecording: key })
				: await notes.update({}, { toggleRecording: key });
		return written.error === null ? null : written.error.message;
	}

	return {
		/** True once both roots' `shortcuts.md` were read (or found absent). */
		get read() {
			return read;
		},
		/** The resolved key, in the global-shortcut plugin's spelling. */
		get accelerator() {
			return accelerator;
		},
		/** The resolved key as a person reads it. */
		get label() {
			return labelOf(accelerator);
		},
		/** Whether this computer's `shortcuts.md` sets the key, overriding the data folder's. */
		get onThisComputer() {
			return here?.toggleRecording !== undefined;
		},
		/** Why the shell does not hold the resolved key, or null while it does (or has not answered). */
		get problem() {
			return held?.accelerator === accelerator ? held.problem : null;
		},
		/**
		 * Make `typed` the shortcut: in the data folder's `shortcuts.md`
		 * (synced with the files, so this computer's override is removed), or,
		 * `onThisComputer`, in the AppData root's. The shell must hold it
		 * first, so a key that does not parse or that another app holds is
		 * never written. Answers why it was not saved, or null.
		 */
		async save(
			typed: string,
			{ onThisComputer }: { onThisComputer: boolean },
		): Promise<string | null> {
			const key = typed.trim();
			if (key === '')
				return 'Type a shortcut, such as CommandOrControl+Shift+;.';
			const refused = await hold(key);
			if (refused !== null) {
				void hold(accelerator);
				return refused;
			}
			const unsaved = await write(
				onThisComputer ? appData.shortcuts : device.shortcuts,
				key,
			);
			if (
				unsaved === null &&
				!onThisComputer &&
				here?.toggleRecording !== undefined
			) {
				const cleared = await appData.shortcuts.update(
					{},
					{ toggleRecording: undefined },
				);
				if (cleared.error !== null) return cleared.error.message;
			}
			if (unsaved !== null) void hold(accelerator);
			return unsaved;
		},
	};
}

export type GlobalShortcut = ReturnType<typeof globalShortcut>;

/** The desktop root's global shortcut, for the header and Settings. */
export const [getGlobalShortcut, setGlobalShortcut] =
	createContext<GlobalShortcut>();

/** Hear each press of the global shortcut. Answers the unsubscribe. */
export function onShortcut(listener: () => void): () => void {
	let stop: (() => void) | undefined;
	let stopped = false;
	void listen('whispering://toggle-recording', listener).then((unlisten) => {
		if (stopped) unlisten();
		else stop = unlisten;
	});
	return () => {
		stopped = true;
		stop?.();
	};
}

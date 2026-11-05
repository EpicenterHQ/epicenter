/**
 * The global shortcut in the desktop window (`src-tauri/src/shortcut.rs`):
 * which key, where it is set, and the shell's hold on it. The shell holds
 * the key while Whispering runs and sends each press; the page decides what
 * a press does (`onShortcut`).
 *
 * The key is `toggleRecording` in `shortcuts.md`, resolved with a shallow
 * spread: the default, then the data folder's note (the contract's
 * `shortcuts`, which travels with the files), then this computer's
 * (`localFile('shortcuts.md')` from `@epicenter/local`: the app's place for
 * this computer's state, which the build picks and app code never opens).
 * Rust never reads the note (decision 89): once both notes are read, and
 * whenever the resolved key changes, the page asks the shell to hold it
 * (`set_shortcut`).
 *
 * `openShortcut(folder)` is a capability, made once beside the folder in
 * `src/lib/app.ts` and read through `reactive`: reads answer at once, and
 * `subscribe` hears them change.
 */
import {
	type NoteOf,
	noteText,
	readNoteText,
} from '@epicenter/definition/contract';
import type { Folder } from '@epicenter/folder/core';
import { localFile } from '@epicenter/local';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { extractErrorMessage } from 'wellcrafted/error';
import { type Whispering, whispering } from '../contract.js';
import type { GlobalShortcut } from './types.js';

type Shortcuts = Whispering['collections']['shortcuts'];
const SHORTCUTS = whispering.collections.shortcuts;

/** `shortcuts.md` when neither note holds a key. */
const SHORTCUT_DEFAULTS = { toggleRecording: 'CommandOrControl+Shift+;' };

/** The keys a `shortcuts.md` note sets; none for no note. */
const keysOf = (note: { toggleRecording?: string } | null | undefined) =>
	note?.toggleRecording === undefined
		? {}
		: { toggleRecording: note.toggleRecording };

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


/** This computer's `shortcuts.md` as last read: the key it sets, if any, and its body. */
type Here = { readonly toggleRecording?: string; readonly body: string };

/**
 * The global shortcut over `folder`, the data folder, and this computer's
 * `shortcuts.md`, followed from now on for the page's life. Once both notes
 * are read, and whenever the resolved key changes, the shell is asked to
 * hold it.
 */
export function openShortcut(
	folder: Pick<Folder<Whispering>, 'shortcuts'>,
): GlobalShortcut {
	const file = localFile('shortcuts.md');
	const notes = folder.shortcuts;
	/** This computer's note: undefined until read, null when there is none. */
	let here: Here | null | undefined;
	/** Why this computer's note could not be read, if it could not. */
	let unreadable: string | null = null;
	/** The newest read of it, so an older answer never replaces a newer one. */
	let reads = 0;
	/** The last key the shell was asked to hold, and its answer once it came. */
	let asked: string | undefined;
	let held: { accelerator: string; problem: string | null } | undefined;
	const listeners = new Set<() => void>();

	const read = () => here !== undefined && !notes.loading();
	const accelerator = () =>
		({
			...SHORTCUT_DEFAULTS,
			...keysOf(notes.get({})),
			...keysOf(here),
		}).toggleRecording;

	/** Ask the shell to hold the resolved key when it changed. */
	function holdResolved() {
		if (!read()) return;
		const key = accelerator();
		if (key === asked) return;
		asked = key;
		void hold(key).then((problem) => {
			if (asked !== key) return;
			held = { accelerator: key, problem };
			changed();
		});
	}

	function changed() {
		holdResolved();
		for (const listener of [...listeners]) listener();
	}

	/** Read this computer's note: its keys and body, or why it does not read. */
	async function readHere(): Promise<
		{ note: Here | null; version: string } | { problem: string }
	> {
		const answered = await file.read();
		if (answered.error !== null) return { problem: answered.error.message };
		if (answered.data === null) return { note: null, version: 'absent' };
		const note = readNoteText(SHORTCUTS, answered.data.text);
		if (note.error !== null)
			return {
				problem: `This computer's shortcuts.md does not read: ${note.error.message}`,
			};
		return {
			note: { ...keysOf(note.data.fields), body: note.data.body },
			version: answered.data.version,
		};
	}

	async function follow() {
		const turn = ++reads;
		const answered = await readHere();
		if (turn !== reads) return;
		unreadable = 'problem' in answered ? answered.problem : null;
		here = 'problem' in answered ? null : answered.note;
		changed();
	}

	/**
	 * Set `toggleRecording` in this computer's note to `key`, or drop it for
	 * undefined, keeping the note's body, over the version just read.
	 */
	async function writeHere(key: string | undefined) {
		const current = await readHere();
		if ('problem' in current) return current.problem;
		const text = noteText(SHORTCUTS, {
			toggleRecording: key,
			body: current.note?.body ?? '',
		} as NoteOf<Shortcuts>);
		if (text.error !== null) return text.error.message;
		const written = await file.write(text.data, current.version);
		if (written.error !== null) return written.error.message;
		if (written.data === 'stale')
			return "This computer's shortcuts.md changed while it was saved. Save again.";
		await follow();
		return null;
	}

	// Followed for the page's life, as the shell holds the key for it.
	const stops = [notes.subscribe(changed), file.subscribe(() => void follow())];
	void follow();

	return {
		/** True once both `shortcuts.md` notes were read (or found absent). */
		read,
		/** The resolved key, in the global-shortcut plugin's spelling. */
		accelerator,
		/** The resolved key as a person reads it. */
		label: () => labelOf(accelerator()),
		/** Whether this computer's `shortcuts.md` sets the key, overriding the data folder's. */
		onThisComputer: () => here?.toggleRecording !== undefined,
		/**
		 * Why the shell does not hold the resolved key, or why this computer's
		 * note does not read; null while neither is so (or the shell has not
		 * answered).
		 */
		problem: () =>
			(held?.accelerator === accelerator() ? held.problem : null) ??
			unreadable,
		/** Call `listener` when a read may answer differently; returns the unsubscribe. */
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		/**
		 * Make `typed` the shortcut: in the data folder's `shortcuts.md`
		 * (synced with the files, so this computer's override is removed), or,
		 * `onThisComputer`, in this computer's. The shell must hold it first,
		 * so a key that does not parse or that another app holds is never
		 * written. The data folder's note is written with `set`, which never
		 * fails (ADR-0775); this computer's can be refused. Answers why it was
		 * not saved, or null.
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
				void hold(accelerator());
				return refused;
			}
			if (onThisComputer) {
				const unsaved = await writeHere(key);
				if (unsaved !== null) void hold(accelerator());
				return unsaved;
			}
			await notes.set({}, { toggleRecording: key });
			if (here?.toggleRecording !== undefined) return writeHere(undefined);
			return null;
		},
		/** Stop following both notes; the shell keeps the key it holds. */
		[Symbol.dispose]() {
			for (const stop of stops.splice(0)) stop();
			reads++;
		},
	};
}

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

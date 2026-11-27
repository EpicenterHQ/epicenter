/**
 * What a screen may know about dictation, apart from how it happens.
 *
 * Screens (Home, the sidebar, the recording strip, the pill) read this and
 * nothing else about a take. `dictation.svelte.ts` is the real one: it
 * records, transcribes, and delivers. The preview page hands the same
 * screens a made-up one, so every state can be seen without a microphone,
 * and a feature that is not built yet can be designed first.
 *
 * ```txt
 *  shortcut / hold / voice / button
 *            │
 *            ▼
 *   dictation.svelte.ts  ── records, transcribes, cleans up, delivers
 *            │
 *            ▼  DictationView (read methods + a few actions)
 *            │
 *   Home · strip · pill · sidebar status
 * ```
 *
 * Readers call the methods inside a template or `$derived`; each answers the
 * current value and Svelte tracks it.
 */
import { createContext } from 'svelte';

/** What started a take. */
export type Trigger =
	/** The Record button in the window. */
	| 'button'
	/** The start-and-stop shortcut, from any app. */
	| 'shortcut'
	/** The hold-to-talk shortcut: the take lasts while the key is down. */
	| 'hold'
	/** Hands-free heard speech. */
	| 'voice';

/** The take under way, if any. */
export type Take =
	| { kind: 'idle' }
	| { kind: 'starting' }
	| { kind: 'recording'; startedAt: number; trigger: Trigger }
	| { kind: 'stopping' };

/** Hands-free: the microphone stays open between takes and a take starts on speech. */
export type HandsFree =
	/** Not offered here, and why: a browser tab has no hands-free. */
	| { kind: 'unavailable'; why: string }
	| { kind: 'off' }
	| { kind: 'listening' };

/** Where finished text went. */
export type Destination = 'clipboard' | 'cursor';

/**
 * What became of the latest take after it stopped. The pill and Home show
 * it; a failure stays until the next take, so it can be acted on.
 */
export type Outcome =
	| { kind: 'none' }
	| { kind: 'transcribing'; id: string }
	/** `at` is when it landed, so the pill can step aside a moment later. */
	| { kind: 'delivered'; id: string; to: Destination; at: number }
	/** Paste at the cursor could not land; the text is on the clipboard instead. */
	| { kind: 'copiedInstead'; id: string; why: string }
	/**
	 * No text came out. The recording is kept. `label` is a few words that
	 * fit the pill ("Needs a key"); `why` is the sentence Home shows; `fix`
	 * says where to repair the cause.
	 */
	| { kind: 'failed'; id: string; label: string; why: string; fix?: Fix };

/** Where a person goes to fix something: a link in the window. */
export type Fix = { label: string; href: string };

/**
 * One thing dictation needs before it works end to end. Home lists the
 * unmet ones and the sidebar counts them.
 */
export type Need = {
	id: 'microphone' | 'server' | 'model' | 'accessibility' | 'shortcut';
	met: boolean;
	/** What is wrong and what still works, as the person reads it. */
	problem: string;
	fix: Fix;
};

/** The shortcuts that record from any app, as a person reads them: `⌘⇧;`. */
export type Keys = {
	/** Starts a take, and stops it; empty where no shortcut does, as in a browser tab. */
	toggle: string;
	/** Records while held; undefined while there is none. */
	hold?: string;
};

export type DictationView = {
	/** The take under way. */
	take(): Take;
	keys(): Keys;
	/** The microphone's level, 0 to 1, while recording or listening. */
	level(): number;
	/** Whether the microphone has sent only silence for the last few seconds of this take. */
	silent(): boolean;
	handsFree(): HandsFree;
	outcome(): Outcome;
	/** What dictation still needs; empty when everything is set. */
	needs(): Need[];
	/** Whether the recording `id` is with the transcription server now. */
	isTranscribing(id: string): boolean;
	/** Whether the recording `id`'s text is with the cleanup model now. */
	isCleaning(id: string): boolean;

	/** Start a take from the window, or stop the one under way. */
	toggle(): void;
	/** Stop the take under way and throw it away: nothing is kept or transcribed. */
	cancel(): void;
	/** Clear the latest take's outcome, once the person has seen it. */
	dismiss(): void;
	/** Bring Whispering's window forward, at `href` (an address in the app, such as `/settings/microphone`). */
	show(href: string): void;
	/** Turn hands-free on or off; does nothing while it is unavailable. */
	setHandsFree(on: boolean): void;
	/** Transcribe the recording `id` again, then clean up and deliver it. */
	transcribe(id: string): void;
	/** Drop any transcription of `id` under way; call before deleting it. */
	forget(id: string): void;
};

/** The view the screens under a layout read; the root layout sets the real one. */
export const [getDictation, setDictation] = createContext<DictationView>();

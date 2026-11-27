/**
 * The floating pill's window and the main window, talking.
 *
 * Dictation runs in the main window. The pill is its own small window that
 * floats over every app and never takes focus, so it cannot read dictation
 * directly: the main window sends it what to show, and it sends back what
 * the person pressed.
 *
 * ```txt
 *  main window                         pill window
 *  dictation ── publish(PillState) ──▶ onState ──▶ Pill.svelte
 *            ◀── onAction ── send(PillAction) ◀── Stop, Cancel, click
 *                                      setShown ──▶ Rust shows or hides it
 * ```
 *
 * A browser tab has no floating window, so there every call does nothing.
 */
import type { HandsFree, Keys, Outcome, Take } from '../../dictation-view';

/** What the pill shows, as the main window last sent it. */
export type PillState = {
	take: Take;
	outcome: Outcome;
	level: number;
	silent: boolean;
	handsFree: HandsFree;
	keys: Keys;
	/** Whether the outcome's recording is with the cleanup model now. */
	cleaning: boolean;
};

/** What the person pressed on the pill. */
export type PillAction =
	| { kind: 'toggle' }
	| { kind: 'cancel' }
	| { kind: 'dismiss' }
	| { kind: 'setHandsFree'; on: boolean }
	/** Clicked the pill: open Whispering, at the recording `id` when given. */
	| { kind: 'show'; id?: string };

export type Pill = {
	/** From the main window: send the pill what dictation shows now. */
	publish(state: PillState): void;
	/**
	 * In the main window: hear each press on the pill until the returned
	 * function is called. A `show` brings the main window forward first.
	 */
	onAction(handle: (action: PillAction) => void): () => void;
	/** In the pill window: hear each state the main window sends, until the returned function is called. */
	onState(handle: (state: PillState) => void): () => void;
	/** From the pill window: tell the main window what was pressed. */
	send(action: PillAction): void;
	/** From the pill window: show its window, placed on the screen with the pointer, or hide it. */
	setShown(shown: boolean): void;
};

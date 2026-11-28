/**
 * The global shortcuts: keys that reach Whispering from any app. Only the
 * desktop app has them (`shortcuts.rs`); a browser tab hears no key that is
 * pressed in another app, and says so through `available`.
 *
 * Keys are written as Rust's shortcut parser reads them: modifiers first,
 * then one key by its `KeyboardEvent.code`, joined by `+`
 * (`CommandOrControl+Shift+Semicolon`). `shortcut.ts` writes and reads them.
 */

/** What a shortcut does. */
export type ShortcutName =
	/** Starts a take, and stops it. */
	| 'toggle'
	/** Records while the keys are down. */
	| 'hold'
	/** Turns hands-free on, and off. */
	| 'handsFree'
	/** Throws away the take under way. Held only while one records. */
	| 'cancel';

export type Shortcuts = {
	/** Whether this place has global shortcuts at all. */
	available: boolean;
	/**
	 * Hold exactly these keys; an empty string holds nothing for that name.
	 * Answers, by name, why each one that could not be held was not.
	 */
	set(
		keys: Record<ShortcutName, string>,
	): Promise<Partial<Record<ShortcutName, string>>>;
	/**
	 * Hear each shortcut go down (`down`) and come up, until the returned
	 * function is called.
	 */
	onPress(handle: (name: ShortcutName, down: boolean) => void): () => void;
};

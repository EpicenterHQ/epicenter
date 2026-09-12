import { on } from 'svelte/events';
import type { Brand } from 'wellcrafted/brand';
import type { ShortcutEventState } from '$lib/commands';
import {
	bindingsEqual,
	createModifierLatch,
	domCodeToKey,
	type Key,
	type KeyBinding,
} from '$lib/utils/key-binding';

export type CommandId = string & Brand<'CommandId'>;

/**
 * Registered bindings by command id. The manager only matches physical keys and
 * tracks press/release edges; it does not own which edges a command cares about
 * (the `on` filter) or what the command does (the callback). Both live in the
 * command layer, reached through the `onTrigger` sink passed to `listen`.
 */
const shortcuts = new Map<CommandId, KeyBinding>();

/**
 * Type representing the local shortcut manager instance.
 * Provides methods to:
 * - Listen for keyboard events and trigger registered shortcuts
 * - Register new keyboard shortcuts with specific key combinations
 * - Unregister individual shortcuts or all shortcuts at once
 *
 * The manager handles the complexity of tracking pressed keys, matching
 * key combinations, and managing shortcut lifecycles.
 */

export const LocalShortcutManagerLive = {
	/**
	 * Sets up keyboard event listeners to detect and handle shortcut key combinations.
	 *
	 * - Tracks currently pressed keys in real-time
	 * - Matches key combinations against registered shortcuts
	 * - Handles both keydown and keyup events for flexible trigger options
	 * - Provides special handling for modifier keys to prevent stuck keys
	 * - Automatically cleans up state when window loses focus or visibility
	 *
	 * @param onTrigger - sink for matched edges; the command layer applies the
	 *   `on` filter and runs the callback. Called with `'Pressed'` when a combo
	 *   becomes fully held and `'Released'` when it stops being held.
	 * @returns Cleanup function that removes all event listeners when called
	 */
	listen(onTrigger: (id: CommandId, state: ShortcutEventState) => void) {
		/**
		 * Physical (non-modifier) keys currently held, by our `Key` space (from
		 * `e.code` via {@link domCodeToKey}). Modifier codes map to `null` and never
		 * land here. Modifier flags are read live, with a keydown-to-keyup fallback
		 * latch for browsers that expose Linux Super without setting `metaKey`.
		 * Combined into a `KeyBinding` and matched by set-equality.
		 */
		const pressedKeys = new Set<Key>();
		const modifierLatch = createModifierLatch();
		/**
		 * Set tracking which shortcuts have already been triggered and are currently active.
		 * This prevents key repeat spam when holding down keys - without this, holding
		 * spacebar would trigger the shortcut many times per second!
		 *
		 * When a shortcut is triggered:
		 * 1. Its ID is added to this set, marking it as "already fired"
		 * 2. Future keydown events with the same key combo are ignored
		 * 3. The ID is only removed when all keys are released or focus is lost
		 *
		 * This ensures each key combination fires exactly once per physical press,
		 * regardless of how long the user holds the keys down.
		 */
		const activeShortcuts = new Set<CommandId>();

		/** The gesture currently held: resolved modifiers plus the pressed keys. */
		const heldBinding = (modifiers: KeyBinding['modifiers']): KeyBinding => ({
			modifiers,
			keys: [...pressedKeys],
		});

		/**
		 * Handle keydown events - adds keys to pressed state and triggers 'Pressed' shortcuts.
		 * Fires repeatedly while a key is held down (due to OS key repeat), but activeShortcuts
		 * ensures callbacks only fire once per physical key press.
		 */
		const keydown = on(window, 'keydown', (e) => {
			// Skip shortcut processing if user is typing in an input field
			if (isTypingInInput()) return;

			// Skip keydowns that belong to an in-progress IME composition (CJK, accent
			// dead keys): the mid-composition `.code` is not the user's intended key,
			// so matching on it would misfire.
			if (e.isComposing) return;

			// Physical key from `e.code` (layout-stable, no Option-character quirk).
			// Modifier codes and keys off the bindable alphabet map to null and are
			// not tracked here; the modifier latch resolves the held modifier set.
			const key = domCodeToKey(e.code);
			if (key) pressedKeys.add(key);

			const held = heldBinding(modifierLatch.keydown(e));

			// Check all registered shortcuts for an exact set match.
			for (const [id, binding] of shortcuts.entries()) {
				if (!bindingsEqual(binding, held)) continue;

				// Always prevent default for matching shortcuts
				e.preventDefault();

				// Arm on the first full match and emit 'Pressed'. activeShortcuts is
				// the anti-spam latch: while a combo stays held, OS key repeat fires
				// keydown many times a second, but it emits 'Pressed' exactly once.
				// Arm regardless of which edges the command wants; the dispatcher
				// drops a 'Pressed' the command did not subscribe to, and arming is
				// what lets a release-only command still emit 'Released' on keyup.
				if (!activeShortcuts.has(id)) {
					activeShortcuts.add(id);
					onTrigger(id, 'Pressed');
				}
			}
		});

		/**
		 * Handle keyup events - removes keys from pressed state and triggers 'Released' shortcuts.
		 * Also responsible for clearing activeShortcuts to allow shortcuts to fire again
		 * on the next key press.
		 */
		const keyup = on(window, 'keyup', (e) => {
			// Skip shortcut processing if user is typing in an input field
			if (isTypingInInput()) return;

			// Drop the released key and its modifier fallback before recomputing the
			// held gesture, so keyup can never re-add the key it just released.
			const key = domCodeToKey(e.code);
			if (key) pressedKeys.delete(key);
			const held = heldBinding(modifierLatch.keyup(e));

			// Any armed shortcut that no longer matches has been released. Iterating
			// activeShortcuts (not all shortcuts) means only what actually fired can
			// fire a 'Released'; deleting the current element mid-iteration is safe
			// for a Set.
			for (const id of activeShortcuts) {
				const binding = shortcuts.get(id);
				if (binding && bindingsEqual(binding, held)) continue;
				e.preventDefault();
				onTrigger(id, 'Released');
				activeShortcuts.delete(id);
			}
		});

		/**
		 * Focus left the window (app switch, click outside) or the tab was hidden,
		 * possibly while a shortcut was still held. The matching keyup will never
		 * arrive, so release every armed shortcut here instead of silently dropping
		 * it: emit `'Released'` for each, which the dispatcher ignores for commands
		 * that did not subscribe to that edge but runs as the stop edge for a hold
		 * like push-to-talk, which would otherwise stay stuck on (recording with no
		 * keyup to ever end it). Then clear the held state.
		 */
		const releaseAllHeld = () => {
			for (const id of activeShortcuts) onTrigger(id, 'Released');
			activeShortcuts.clear();
			pressedKeys.clear();
			modifierLatch.reset();
		};

		/**
		 * Handle window blur events (switching applications, clicking outside browser).
		 */
		const blur = on(window, 'blur', releaseAllHeld);

		/**
		 * Handle tab visibility changes (switching browser tabs). This catches cases
		 * where the window does not lose focus but the tab is hidden.
		 */
		const visibilityChange = on(document, 'visibilitychange', () => {
			if (document.visibilityState === 'hidden') releaseAllHeld();
		});

		/** Cleanup function that removes all event listeners */
		return () => {
			keydown();
			keyup();
			blur();
			visibilityChange();
		};
	},
	/**
	 * Register (or replace) a command's binding. In-memory `Map` set, so it cannot
	 * fail: synchronous and `void`, unlike the desktop tier's genuinely fallible
	 * IPC registration.
	 */
	register(id: CommandId, binding: KeyBinding): void {
		shortcuts.set(id, binding);
	},

	/**
	 * Unregister a local shortcut by ID. Idempotent: safe even if the shortcut was
	 * never registered.
	 */
	unregister(id: CommandId): void {
		shortcuts.delete(id);
	},
};

/**
 * Checks if the currently focused element should capture keyboard input.
 * Returns true if the user is typing in an input field, textarea, or other editable element.
 * This prevents keyboard shortcuts from interfering with text input.
 */
function isTypingInInput(): boolean {
	const activeElement = document.activeElement;
	if (!activeElement) return false;

	// Check if it's an input element (but not buttons, checkboxes, etc.)
	if (activeElement.tagName === 'INPUT') {
		const inputType = (activeElement as HTMLInputElement).type;
		const textInputTypes = [
			'text',
			'password',
			'email',
			'url',
			'tel',
			'search',
			'number',
			'date',
			'time',
			'datetime-local',
			'month',
			'week',
		];
		return textInputTypes.includes(inputType);
	}

	// Check if it's a textarea
	if (activeElement.tagName === 'TEXTAREA') return true;

	// Check if it's a contenteditable element
	if (activeElement.getAttribute('contenteditable') === 'true') return true;

	// Check if it has role="textbox"
	if (activeElement.getAttribute('role') === 'textbox') return true;

	return false;
}

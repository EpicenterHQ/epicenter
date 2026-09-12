import { on } from 'svelte/events';
import {
	domCodeToKey,
	eventKeyModifier,
	eventModifiers,
	type Key,
	type KeyBinding,
	type Modifier,
} from '$lib/utils/key-binding';

const CAPTURE_WINDOW_MS = 300; // Time to wait for additional keys in a combination.

/**
 * The shared physical chord recorder: captures a gesture straight from the
 * webview's `keydown` stream in physical-key space (modifier flags plus a
 * physical `.code`), producing a `KeyBinding`. It can only see what the browser
 * exposes, so Fn and modifier-only holds are invisible here; that is fine, since
 * they are refused as global shortcuts anyway (ADR-0117). The global recorder
 * accepts a chord; the in-app recorder accepts whatever it yields.
 *
 * The completion model: each new key extends a 300ms window, and the gesture
 * commits when every key releases (immediate) or the window expires (the safety
 * net for the macOS quirk where a key's `keyup` is swallowed while a modifier is
 * still held). `onCapture` receives each captured `KeyBinding`; the recorder then
 * resets and keeps listening, so the owner can refuse a binding and let the user
 * try again without re-opening. The owner calls `stop()` once a capture is
 * accepted. Escape is left to bubble; the session owner cancels.
 *
 * `onProgress` fires on every keydown with the combo accumulated so
 * far, before the gesture completes. The recorder owns capture; the owner owns
 * meaning, so the owner reads this partial to preview the reach a binding would
 * earn ("hold a modifier and it reaches everywhere") live, as the user holds.
 */
export function createChordRecorder({
	onCapture,
	onProgress,
}: {
	onCapture: (binding: KeyBinding) => void;
	onProgress: (binding: KeyBinding) => void;
}) {
	// Internal control-flow guard only (the owner tracks its own session state), so
	// a plain bool, not reactive.
	let isListening = false;
	// Accumulated across the capture window: the modifiers ever held (a combo built
	// up over several presses) and the last physical key seen.
	let capturedModifiers: Modifier[] = [];
	let capturedKey: Key | null = null;
	// Every physical code currently down (modifiers included), so "all released"
	// can fire an immediate commit; the window covers any keyup the OS swallows.
	const heldCodes = new Set<string>();
	let detach: (() => void) | undefined;

	function reset() {
		capturedModifiers = [];
		capturedKey = null;
		heldCodes.clear();
	}

	function commit() {
		if (!isListening) return;
		completeAfterWindow.cancel();
		const binding: KeyBinding = {
			modifiers: capturedModifiers,
			keys: capturedKey ? [capturedKey] : [],
		};
		// Stay listening: the owner decides whether to accept (and stop us) or
		// refuse a capture; reset so the next attempt starts clean either way.
		reset();
		// The webview recorder yields only bare keys and chords. A capture with no
		// non-modifier key (a lone modifier pressed, or every non-modifier released
		// past the window leaving only modifiers held) is a modifier-only hold,
		// which is refused (ADR-0117), so it never commits here: a stored
		// modifier-only binding would fire on every press of that modifier in-app.
		if (binding.keys.length > 0) onCapture(binding);
	}

	// Quiet for CAPTURE_WINDOW_MS after the last key change = the gesture is done,
	// but only once it contains a non-modifier key. A person may hold a modifier
	// for as long as they need before adding the key; committing an incomplete
	// modifier-only partial here would reset it and capture the later key alone.
	const completeAfterWindow = debounce(() => {
		if (capturedKey) commit();
	}, CAPTURE_WINDOW_MS);

	function onKeydown(e: KeyboardEvent) {
		if (e.repeat) return; // auto-repeat is not a new key
		if (e.key === 'Escape') return; // let it bubble; the session owner cancels
		// Ignore keydowns mid-IME-composition (CJK, accent dead keys): the `.code` is
		// not the user's intended key.
		if (e.isComposing) return;
		// Keep the gesture from triggering anything in the webview while recording.
		e.preventDefault();

		heldCodes.add(e.code);
		// Union the modifiers (a combo built up over several presses), and take the
		// latest physical key. A modifier-only keydown just extends the window so
		// the user has time to add the key before it times out.
		const modifiers = eventModifiers(e);
		const currentModifier = eventKeyModifier(e);
		if (currentModifier !== null && !modifiers.includes(currentModifier)) {
			modifiers.push(currentModifier);
		}
		for (const modifier of modifiers) {
			if (!capturedModifiers.includes(modifier)) {
				capturedModifiers.push(modifier);
			}
		}
		const key = domCodeToKey(e.code);
		if (key) capturedKey = key;

		onProgress({
			modifiers: [...capturedModifiers],
			keys: capturedKey ? [capturedKey] : [],
		});
		completeAfterWindow();
	}

	function onKeyup(e: KeyboardEvent) {
		heldCodes.delete(e.code);
		if (heldCodes.size === 0) commit();
	}

	function start() {
		if (isListening) return;
		isListening = true;
		reset();
		const offKeydown = on(window, 'keydown', onKeydown);
		const offKeyup = on(window, 'keyup', onKeyup);
		// Losing focus mid-capture would strand held keys; drop them so a stale
		// modifier cannot wedge into the next gesture.
		const offBlur = on(window, 'blur', reset);
		detach = () => {
			offKeydown();
			offKeyup();
			offBlur();
		};
	}

	function stop() {
		if (!isListening) return;
		isListening = false;
		completeAfterWindow.cancel();
		reset();
		detach?.();
		detach = undefined;
	}

	return { start, stop };
}

/** Trailing-edge debounce with a cancel for teardown; last call's args win. */
function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	function debounced(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			fn();
		}, ms);
	}
	debounced.cancel = (): void => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};
	return debounced;
}

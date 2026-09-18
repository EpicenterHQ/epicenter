/**
 * Owns the `AbortController` for the in-flight Polish pass, so the pill's "ship
 * raw" control can cancel it without threading the controller through component
 * props or the lifecycle. See ADR-0099.
 *
 * The pill's *display* during Polish is a projection of the dictation lifecycle
 * (the `polishing` outcome, see `dictation-lifecycle`), the same as every other
 * phase. This module is only the cancellation seam: the pipeline calls `begin()`
 * to get a signal and `end()` when the pass settles; the overlay's "ship raw"
 * action calls `shipRaw()`. Lives outside the pipeline because two owners touch
 * it: the pipeline (imperative) and the overlay action handler (reactive).
 */
let controller: AbortController | null = null;
let ownsFeedback: (() => boolean) | undefined;

export const polishHud = {
	/**
	 * Start a Polish pass and return a fresh `AbortSignal` to hand to `runPolish`.
	 * Call only when an AI call is actually about to happen (`polishWillRun`).
	 */
	begin(isCurrent: () => boolean): AbortSignal {
		controller = new AbortController();
		ownsFeedback = isCurrent;
		return controller.signal;
	},

	/**
	 * Cancel the in-flight pass and ship the raw transcript. Aborting makes the
	 * provider request reject; `runPolish` treats a user abort as a clean success
	 * and returns the raw input.
	 */
	shipRaw(): void {
		if (ownsFeedback?.()) controller?.abort();
	},

	/** Drop only this pass's controller; a newer pass may already own the HUD. */
	end(signal: AbortSignal): void {
		if (controller?.signal !== signal) return;
		controller = null;
		ownsFeedback = undefined;
	},
};

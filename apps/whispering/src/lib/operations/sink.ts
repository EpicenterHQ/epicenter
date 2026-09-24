/**
 * The Sink seam: where a capture's text can land, expressed as one interface
 * with a handful of implementations. Each sink wraps exactly the delivery
 * behavior `delivery.ts` already had, so this is a refactor of existing
 * behavior, not new behavior. Settings never leak in here: `deliverResult`
 * resolves the settings once and hands each sink everything it needs at
 * construction, so a sink is reusable outside a settings-backed caller too.
 */
import { clipboard } from '@epicenter/app/clipboard';
import { services } from '$lib/services';
import type { DeliveryReach } from './delivery-reach';

type SinkKind = 'cursor' | 'clipboard' | 'ledger';

/** A pluggable delivery destination, resolved once per capture. */
export interface Sink {
	kind: SinkKind;
	deliver(text: string): Promise<DeliveryReach>;
}

/**
 * Copies to the clipboard. The clipboard IS the configured output here, so a
 * clean copy always reaches `output`. Best-effort, like today: a clipboard
 * write effectively never fails.
 */
export const clipboardSink: Sink = {
	kind: 'clipboard',
	async deliver(text) {
		await clipboard.writeText(text);
		return 'output';
	},
};

/**
 * No external side effect: the recordings row the pipeline already writes IS
 * the destination, so delivery here just means the text reached history.
 * Encodes today's "nothing configured, text reaches history" branch.
 */
export const ledgerSink: Sink = {
	kind: 'ledger',
	async deliver() {
		return 'output';
	},
};

/**
 * Writes at the cursor via a synthetic paste, with the clipboard as staging
 * and fallback.
 *
 * `keepOnClipboard` tells `write_text` what the clipboard should hold
 * afterward (it owns the staging delivery used to pre-copy): when clipboard
 * output is on it leaves the text there; when off it borrows and restores the
 * user's clipboard (full-fidelity on macOS, see `write_text`'s docstring in
 * src-tauri). `write_text` decides from the Accessibility grant whether it can
 * paste and reports where the text landed: `pasted` at the cursor (clean), or
 * `leftOnClipboard` when it could not paste.
 */
export function createCursorSink({
	keepOnClipboard,
	pressEnter,
}: {
	keepOnClipboard: boolean;
	pressEnter: boolean;
}): Sink {
	return {
		kind: 'cursor',
		async deliver(text) {
			const { data: writeOutcome, error: writeError } =
				await services.text.writeToCursor(text, keepOnClipboard);

			if (writeError) {
				// The write failed outright (rare). Ensure the text is at least on
				// the clipboard, and report the reduced reach.
				await clipboard.writeText(text);
				return 'clipboard';
			}

			if (writeOutcome === 'pasted' && pressEnter) {
				// The Enter keystroke is a nicety on top of a successful write; a
				// failure here does not change the delivery outcome.
				await services.text.simulateEnterKeystroke();
			}

			// A clean `pasted` reached the configured output; a `leftOnClipboard`
			// fallback is a reduced (but recoverable) reach (see DeliveryReach and
			// ADR-0039/0040).
			return writeOutcome === 'pasted' ? 'output' : 'clipboard';
		},
	};
}

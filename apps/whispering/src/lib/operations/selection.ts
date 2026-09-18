import { type ClipboardError, clipboard } from '@epicenter/app/clipboard';
import type { Result } from 'wellcrafted/result';
import type { TextError } from '#platform/text';
import { services } from '$lib/services';

/**
 * How long to wait after the synthetic copy before reading the clipboard. The OS
 * writes the selection to the clipboard asynchronously once the foreground app
 * handles the keystroke, so reading immediately can return the prior clipboard.
 * Mirrors the paste delay in the Rust `write_text` command; tune if a slow app
 * loses selections.
 */
const COPY_SETTLE_MS = 100;

/**
 * Capture the active selection in the foreground app, preserving the user's
 * clipboard. Saves the current clipboard, simulates the copy shortcut
 * (Cmd/Ctrl+C), reads the freshly copied selection, then restores the original
 * clipboard.
 *
 * Lossy by construction: the synthetic copy depends on the foreground app
 * honoring the shortcut and on OS accessibility permissions, so a null or empty
 * result means "nothing was captured," not an error. Desktop only; the browser
 * text service returns NotSupported for `simulateCopyKeystroke`.
 */
export async function captureSelection(): Promise<
	Result<string | null, TextError | ClipboardError>
> {
	const saved = await clipboard.readText();
	if (saved.error) return saved;
	const originalClipboard = saved.data;

	const copied = await services.text.simulateCopyKeystroke();
	if (copied.error) return copied;

	await new Promise((resolve) => setTimeout(resolve, COPY_SETTLE_MS));

	const selection = await clipboard.readText();

	// Restore the user's clipboard regardless of how the read went. An empty
	// original is left as-is: an extra clipboard entry is a smaller surprise than
	// guessing how to clear it.
	if (originalClipboard !== null) {
		await clipboard.writeText(originalClipboard);
	}

	return selection;
}

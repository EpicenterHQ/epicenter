import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';

export const ClipboardError = defineErrors({
	ClipboardRead: ({ cause }: { cause: unknown }) => ({
		message: `Failed to read from clipboard: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ClipboardWrite: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write to clipboard: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ClipboardError = InferErrors<typeof ClipboardError>;

/** The system clipboard's text. It captures no App, library, or account. */
export type Clipboard = {
	/** The clipboard's text, or `null` when it holds no text. */
	readText(): Promise<Result<string | null, ClipboardError>>;
	/** Replace the clipboard's contents with `text`. */
	writeText(text: string): Promise<Result<void, ClipboardError>>;
};

/** What a platform supplies: throwing calls with the platform's own empty value. */
export type ClipboardSource = {
	readText(): Promise<string | null | undefined>;
	writeText(text: string): Promise<void>;
};

/** Normalize one platform source: empty text reads as `null`; throws become errors. */
export function createClipboard(source: ClipboardSource): Clipboard {
	return {
		readText: () =>
			tryAsync({
				try: async () => (await source.readText()) || null,
				catch: (cause) => ClipboardError.ClipboardRead({ cause }),
			}),
		writeText: (text) =>
			tryAsync({
				try: () => source.writeText(text),
				catch: (cause) => ClipboardError.ClipboardWrite({ cause }),
			}),
	};
}

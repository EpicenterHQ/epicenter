import { createClipboard } from './contract.js';

/** The page's Clipboard API. Reads need document focus and a user grant. */
export const clipboard = createClipboard({
	readText: () => navigator.clipboard.readText(),
	writeText: (text) => navigator.clipboard.writeText(text),
});

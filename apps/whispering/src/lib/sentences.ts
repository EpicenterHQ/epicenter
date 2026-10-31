/**
 * Messages joined into one text, each read as a sentence. A message from
 * elsewhere (a browser's, the shell's, an endpoint's) may or may not end
 * with its own full stop; this ends each part once, so a join never reads
 * "memory).. Recording is off".
 */

/** A part that already ends a sentence: `.`, `!`, `?`, or `…`, perhaps inside a closing quote or bracket. */
const ENDED = /[.!?…]["'”’)\]]*$/;

/** `parts`, trimmed, each ended with a full stop unless it ends a sentence already, joined by spaces. Empty parts are left out. */
export function sentences(...parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.map((part) => (ENDED.test(part) ? part : `${part}.`))
		.join(' ');
}

/**
 * `@epicenter/definition/note`: the note codec and its house style.
 *
 * A note is a Markdown file: YAML front matter between `---` fences, then a
 * body. Every Epicenter tool that writes a note (an app, the server, the merge
 * driver) writes it in one house style (decision 29): the contract's keys
 * first in its order, any other keys after them sorted, block YAML, and the
 * body byte for byte. `formatNote` applies it to a text.
 */
import { Ok, type Result } from 'wellcrafted/result';
import {
	type CanonicalRefusal,
	formatRowSource,
	parseRowSource,
} from './canonical.js';
import { frameRowText } from './frame.js';

export {
	type CanonicalDocument,
	type CanonicalRefusal,
	formatRowSource,
	parseRowSource,
	sameValue,
} from './canonical.js';
export { frameRowText, joinRowText, type RowTextFrame } from './frame.js';

/**
 * `text` in house style: the keys `declaredKeys` names first in that order,
 * every other key after them sorted, block YAML, the body untouched.
 * Comments and quoting in the front matter are normalized away. Refused when
 * the front matter does not parse to exact JSON values; the text is then left
 * for a person to repair, never rewritten lossily. A text with no front
 * matter gains none: it is returned as its body, a byte-order mark dropped.
 *
 * @example
 * ```ts
 * formatNote('---\ntags: [a]\ntitle: Hi\n---\nBody\n', ['title']);
 * // Ok('---\ntitle: Hi\ntags:\n  - a\n---\nBody\n')
 * ```
 */
export function formatNote(
	text: string,
	declaredKeys: readonly string[],
): Result<string, CanonicalRefusal> {
	const parsed = parseRowSource(text);
	if (parsed.error !== null) return parsed;
	if (frameRowText(text).kind === 'missing')
		return Ok(parsed.data.document.body);
	const formatted = formatRowSource(parsed.data.document, declaredKeys);
	if (formatted.error !== null) return formatted;
	return Ok(formatted.data.text);
}

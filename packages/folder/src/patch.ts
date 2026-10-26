/**
 * How a patch changes a row's text: read the frontmatter and body, set what
 * the patch names over them, and write the result in the canonical form
 * (ADR-0519): declared keys in declared order, then other keys in code unit
 * order, block YAML every common reader reads alike.
 *
 * Text without a frontmatter fence is all body, so a patch of fields gives it
 * one. A field set to `undefined` is removed. A patch that changes no value
 * answers `unchanged`, so a hand-edited file is not reformatted for nothing;
 * any other patch normalizes the whole frontmatter, comments included.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type CanonicalRefusal,
	formatRowSource,
	parseRowSource,
	sameValue,
} from './shared/content/canonical.js';

export type RowPatch = {
	readonly fields?: Readonly<Record<string, unknown>>;
	readonly body?: string;
};

/** The patched text, `unchanged` when no value changes, or why the text cannot take a patch. */
export function applyPatch(
	text: string | null,
	patch: RowPatch,
	declaredKeys: readonly string[],
): Result<string | 'unchanged', CanonicalRefusal> {
	let fields: Readonly<Record<string, unknown>> = {};
	let body = '';
	if (text !== null) {
		const parsed = parseRowSource(text);
		if (parsed.error !== null) return Err(parsed.error);
		({ fields, body } = parsed.data.document);
	}
	const next = {
		fields: { ...fields, ...patch.fields },
		body: patch.body ?? body,
	};
	for (const key of Object.keys(next.fields))
		if (next.fields[key] === undefined) delete next.fields[key];
	if (text !== null && next.body === body && sameValue(next.fields, fields))
		return Ok('unchanged');
	const formatted = formatRowSource(next, declaredKeys);
	if (formatted.error !== null) return Err(formatted.error);
	return Ok(formatted.data.text);
}

/** The keys a table's schema declares, in declared order. */
export function declaredKeysOf(schema: unknown): readonly string[] {
	const properties =
		typeof schema === 'object' && schema !== null && 'properties' in schema
			? schema.properties
			: undefined;
	return typeof properties === 'object' && properties !== null
		? Object.keys(properties)
		: [];
}

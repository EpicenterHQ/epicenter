/** Pure saved-view transforms over a declaration's source text. */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type SavedView, savedViewProblem } from './declaration-schema.js';
import { parseJsonObject } from './json-object.js';

/** One named view assignment in the current declaration source. */
export type SavedViewChange = {
	key: string;
	value: SavedView | undefined;
};

/**
 * Compose a named view into the current source. This function performs no I/O;
 * its caller replaces and saves the same file editor that supplied the source.
 * Unrelated JSON entries, including unsupported views, remain opaque.
 */
export function changeSavedView(
	text: string,
	{ key, value }: SavedViewChange,
): Result<string, { reason: string }> {
	if (typeof key !== 'string' || key === '')
		return Err({ reason: 'A saved view needs a name' });
	if (value !== undefined) {
		const problem = savedViewProblem(value);
		if (problem !== undefined) return Err({ reason: problem });
	}
	const parsed = parseJsonObject(text);
	if (parsed.error !== null) return parsed;
	const current = parsed.data;
	if (Object.hasOwn(current, 'views') && !isObject(current.views))
		return Err({
			reason: "The 'views' section is not an object; repair it in Files",
		});
	const views = (current.views ?? {}) as Record<string, unknown>;
	if (value === undefined && !Object.hasOwn(views, key)) return Ok(text);
	const next = { ...views, [key]: value };
	if (value === undefined) delete next[key];
	return Ok(`${JSON.stringify({ ...current, views: next }, null, 2)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

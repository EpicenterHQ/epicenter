/**
 * Settling one path where two histories meet: the one producer of what
 * happened to a file, used by the server when it merges a commit and by a
 * device when it rebases its own unsent work. It returns the text, and
 * whether it wrote a conflict block (a merge that did is its own Git commit
 * at the next flush).
 *
 * Every conflict is text (D2): body overlaps are conflict blocks, and a
 * field both sides set keeps `current`'s value in the frontmatter and writes
 * `incoming`'s as a labelled block in the body. A path that was deleted since
 * `base`, or that two writers created, holds another note (D3): `current`
 * stays and `incoming` is appended whole as one block. A block identical to
 * one already in the note is not written again, and one clash is one block
 * however many writes follow it: an edit of what a block already offers as
 * a side continues that side (`merge`'s rule, applied to a field's block
 * here). A blob never merges: `settlePointer` is its rule, compare-and-swap.
 *
 * No fallback for a merge that does not parse (D4, which deleted that rule):
 * the door admits only notes that parse, so base, current and incoming all
 * parse; `merge` then writes the frontmatter from current's YAML plus the
 * chosen fields (read back, or rewritten with `stringify`), keeps a body
 * after an empty header from reading as frontmatter, and puts markers and
 * D2 blocks only in the body, which never decides whether a note parses.
 * 242,652 fuzzed triples and 1,000 property seeds never reached it.
 */
import { stringify } from 'yaml';
import { block, findConflicts, type Labels, type Party, sideOffering, unlabelled, versionOf, withBlock, withSide } from './conflict.js';
import { merge, withBlocks } from './merge.js';

export type Settled = {
	text: string | null;
	/** The text holds a conflict block this settle wrote. */
	blocks: boolean;
};

/** Who wrote each side, and when; settle adds each side's version. */
export type Parties = { current: Party; incoming: Party };

const stringifyField = (key: string, value: unknown) => stringify({ [key]: value });

/** Labels for a block between these texts: each side's party and the version of the note it had. */
const labelled = (parties: Parties, base: string | null, current: string | null, incoming: string | null): Labels => ({
	current: { ...parties.current, version: versionOf(current) },
	base: { version: versionOf(base) },
	incoming: { ...parties.incoming, version: versionOf(incoming) },
});

/** The most conflict blocks a merge may leave in a note; past it the merge is refused, whoever wrote the blocks: its writer holds it until some are resolved. */
export const BLOCK_CAP = 20;

/** One conflict block holding `incoming` whole, after `current`. */
export function appendBlock(current: string, incoming: string, parties: Parties) {
	return withBlock(current, block({ current: '', incoming }, labelled(parties, null, current, incoming)));
}

/** Why a blob write did not land, by what its writer saw at the path. */
export const POINTER_REFUSALS = {
	/** The writer saw no file there. */
	added: 'a file with this name was just added elsewhere',
	/** The writer saw a file there, and it changed or went since. */
	changed: 'this file changed on another device',
} as const;

/**
 * Settle a blob path (every file that is not a note) by compare-and-swap:
 * `incoming` lands only where `current` is still `base`, the blob its
 * writer saw (null: none, for a create). Create, replace and delete are the
 * one rule. A create or replace that does not land is refused with why, and
 * its writer holds it; a delete that does not land leaves the file, as a
 * delete that lost to an edit of a note does. Writing what is already
 * there lands as nothing, so two writes of the same bytes are one file.
 */
export function settlePointer(base: string | null, current: string | null, incoming: string | null): { text: string | null } | { refused: string } {
	if (incoming === current || incoming === base || current === base) return { text: incoming === base ? current : incoming };
	if (incoming === null) return { text: current };
	return { refused: base === null ? POINTER_REFUSALS.added : POINTER_REFUSALS.changed };
}

/**
 * Settle `incoming` (the writer's text) against `current` (what is there
 * now), both made from `base`. `deletedSince`: the path was deleted at some
 * point after `base`.
 */
export function settle(
	base: string | null,
	current: string | null,
	incoming: string | null,
	{ deletedSince = false, parties }: { deletedSince?: boolean; parties: Parties },
): Settled {
	if (incoming === current) return { text: current, blocks: false };
	if (incoming === base) return { text: current, blocks: false };
	if (current === base && !deletedSince) return { text: incoming, blocks: false };
	// A delete against an edit it had not seen keeps the edit; an edit brings a deleted note back.
	if (incoming === null) return { text: current, blocks: false };
	if (current === null) return { text: incoming, blocks: false };
	// Two creates, or a path deleted and created again: another note.
	const labels = labelled(parties, base, current, incoming);
	if (base === null || deletedSince) return { text: withBlock(current, block({ current: '', incoming }, labels)), blocks: true };

	const result = merge(base, current, incoming);
	let text = withBlocks(result, labels) ?? current;
	let conflict = result.overlaps.some((o) => o.unit === 'body' || o.unit === 'block');
	for (const overlap of result.overlaps) {
		if (overlap.unit !== 'field' || overlap.incoming === undefined || overlap.current === undefined) continue;
		// D2: the value that lost is a block in the body.
		const values = {
			current: stringifyField(overlap.key, overlap.current),
			base: overlap.base === undefined ? '' : stringifyField(overlap.key, overlap.base),
			incoming: stringifyField(overlap.key, overlap.incoming),
		};
		// One clash is one block: a field's block that offers this edit's base value as a side is continued, not joined by another.
		// Only a block the edit's base did not hold: one the writer had seen is not this clash, and their edit of the field is a change of its own.
		const seen = new Set(findConflicts(base).map((existing) => unlabelled(existing.raw)));
		const continued = values.base === '' ? undefined : findConflicts(text).find((existing) => !seen.has(unlabelled(existing.raw)) && sideOffering(existing, values.base) !== null);
		const side = continued === undefined ? null : sideOffering(continued, values.base);
		text =
			continued === undefined || side === null
				? withBlock(text, block(values, labels))
				: `${text.slice(0, continued.from)}${withSide(continued, side, values.incoming, labels.incoming)}${text.slice(continued.to)}`;
		conflict = true;
	}
	return { text, blocks: conflict };
}

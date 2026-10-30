/**
 * Settling one path where two histories meet: the one producer of what
 * happened to a file, used by the server when it merges a commit and by a
 * device when it rebases its own unsent work. It returns the text, and
 * whether it wrote a conflict block (a merge that did is its own Git commit
 * at the next flush).
 *
 * Every conflict is text: body overlaps are conflict blocks. A header key
 * both sides set takes the later write's value, `incoming`'s (the write
 * arriving now) over `current`'s (`main`'s), with no block: the value that
 * lost stays in history. A path that was deleted since `base`, or that two
 * writers created, holds another note (D3): `current` stays and `incoming`
 * is appended whole as one block. A block identical to one already in the
 * note is not written again, and one clash is one block however many
 * writes follow it (`merge`'s `continuedBlock`). A blob never merges:
 * `settlePointer` is its rule, compare-and-swap.
 *
 * A merge never breaks a note: `merge` writes the header from the merged
 * values, printed in house style and read back, keeps a body after no
 * header from reading as one, and puts markers only in the body (a seeded
 * property in `merge.test.ts`). A side whose top block does not parse has
 * no header, and that block is its body's.
 */
import { block, type Labels, type Party, versionOf, withBlock } from './conflict.js';
import { merge, withBlocks } from './merge.js';

export type Settled = {
	text: string | null;
	/** The text holds a conflict block this settle wrote. */
	blocks: boolean;
};

/** Who wrote each side, and when; settle adds each side's version. */
export type Parties = { current: Party; incoming: Party };

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

/**
 * Settle a blob path (every file that is not a note) by compare-and-swap:
 * `incoming` lands only where `current` is still `base`, the blob its
 * writer saw (null: none, for a create). Create, replace and delete are the
 * one rule. A create or replace that does not land is `lost`: the server
 * puts it beside the other at a sibling (`conflictSibling`), so both are
 * kept; a delete that does not land leaves the file, as a delete that lost
 * to an edit of a note does. Writing what is already there lands as
 * nothing, so two writes of the same bytes are one file.
 */
export function settlePointer(base: string | null, current: string | null, incoming: string | null): { text: string | null } | { lost: true } {
	if (incoming === current || incoming === base || current === base) return { text: incoming === base ? current : incoming };
	if (incoming === null) return { text: current };
	return { lost: true };
}

const utf8 = new TextEncoder();
/** A sibling's own suffix, so a sibling of a sibling is named from the original stem. */
const SIBLING_SUFFIX = / \(conflict [0-9a-f]{7,64}\)$/;

/**
 * RULE: where a losing blob write lands: `<stem> (conflict <hash>)<ext>`
 * beside `path`, from the original stem (a sibling's own suffix dropped)
 * and the first `chars` characters of the losing bytes' hash. The stem is
 * shortened, by whole characters, until the name fits 255 bytes and the
 * path `maxPath` bytes.
 */
export function conflictSibling(path: string, oid: string, chars = 7, maxPath = Number.POSITIVE_INFINITY) {
	const slash = path.lastIndexOf('/');
	const folder = path.slice(0, slash + 1);
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot) : '';
	const suffix = ` (conflict ${oid.slice(0, chars)})${ext}`;
	let stem = [...(dot > 0 ? name.slice(0, dot) : name).replace(SIBLING_SUFFIX, '')];
	const fits = () => utf8.encode(stem.join('') + suffix).length <= 255 && utf8.encode(folder + stem.join('') + suffix).length <= maxPath;
	while (stem.length > 0 && !fits()) stem = stem.slice(0, -1);
	return `${folder}${stem.join('')}${suffix}`;
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
	return { text: withBlocks(result, labels) ?? current, blocks: result.overlaps.some((o) => o.unit === 'body' || o.unit === 'block') };
}

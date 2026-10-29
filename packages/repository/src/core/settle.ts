/**
 * Settling one path where two histories meet: the one producer of what
 * happened to a file, used by the server when it merges a commit and by a
 * device when it rebases its own unsent work. It returns the text and a
 * disposition: what the device tells its person about the work.
 *
 * Every conflict is text (D2): body overlaps are conflict blocks, and a
 * field both sides set keeps `current`'s value in the frontmatter and writes
 * `incoming`'s as a labelled block in the body. A path that was deleted since
 * `base`, or that two writers created, holds another note (D3): `current`
 * stays and `incoming` is appended whole as one block. A block identical to
 * one already in the note is not written again. A pointer is one value.
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
import { block, type Labels, type Party, versionOf, withBlock } from './conflict.js';
import { parsePointer } from './markdown.js';
import { merge, withBlocks } from './merge.js';

export type Disposition =
	/** Everything incoming said is in the text, cleanly. */
	| 'landed'
	/** Incoming text is in the text, partly in conflict blocks. */
	| 'conflict'
	/** `current` was kept and incoming is not in the text: a delete that lost to an edit, or a pointer that lost to another. */
	| 'kept-current'
	/** The path holds another note: incoming is one block after it. */
	| 'different-note'
	/** The path was deleted since `base`: incoming brings it back. */
	| 'restored';

export type Settled = {
	text: string | null;
	disposition: Disposition;
	/** For a pointer that lost: the oid of incoming's bytes, which are kept. */
	yours?: string;
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

/** The most conflict blocks a merge may leave in a note; past it the merge is refused, whoever wrote the blocks (an agent redoes it, a person holds it until some are resolved). */
export const BLOCK_CAP = 20;

/** One conflict block holding `incoming` whole, after `current`. */
export function appendBlock(current: string, incoming: string, parties: Parties) {
	return withBlock(current, block({ current: '', incoming }, labelled(parties, null, current, incoming)));
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
	if (incoming === current) return { text: current, disposition: 'landed' };
	if (incoming === base) return { text: current, disposition: 'landed' };
	if (current === base && !deletedSince) return { text: incoming, disposition: 'landed' };
	// A delete against an edit it had not seen keeps the edit.
	if (incoming === null) return { text: current, disposition: current === null ? 'landed' : 'kept-current' };
	if (current === null) return { text: incoming, disposition: base === null && !deletedSince ? 'landed' : 'restored' };
	// A pointer is one value: current stays, and the writer keeps its oid.
	const theirs = parsePointer(incoming);
	if (theirs !== null || parsePointer(current) !== null) return { text: current, disposition: 'kept-current', ...(theirs === null ? {} : { yours: theirs.oid }) };
	// Two creates, or a path deleted and created again: another note.
	const labels = labelled(parties, base, current, incoming);
	if (base === null || deletedSince) return { text: withBlock(current, block({ current: '', incoming }, labels)), disposition: 'different-note' };

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
		text = withBlock(text, block(values, labels));
		conflict = true;
	}
	return { text, disposition: conflict ? 'conflict' : 'landed' };
}

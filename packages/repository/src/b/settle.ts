/**
 * Settling one path where two histories meet: the one producer of what
 * happened to a file, used by the server when it merges a commit and by a
 * device when it rebases its own unsent work. It returns the text and a
 * disposition, which becomes the notice the writer sees.
 *
 * Every conflict is text (D2): body overlaps are conflict blocks, and a
 * field both sides set keeps `current`'s value in the frontmatter and writes
 * `incoming`'s as a labelled block in the body. A path that was deleted since
 * `base`, or that two writers created, holds another note (D3): `current`
 * stays and `incoming` is appended whole as one block. A pointer is one
 * value. So a merged note always parses when its inputs do (D4).
 */
import { stringify } from 'yaml';
import { parsePointer, parses } from '../markdown.js';
import { merge, withMarkers } from '../merge.js';
import { block, isNote } from './door.js';

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

export type Labels = { current: string; incoming: string };

const stringifyField = (key: string, value: unknown) => stringify({ [key]: value });
const eol = (text: string) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** One conflict block holding `incoming` whole, after `current`. */
export function appendBlock(current: string, incoming: string, labels: Labels) {
	return `${eol(current)}${block({ current: '', incoming }, labels)}`;
}

/**
 * Settle `incoming` (the writer's text) against `current` (what is there
 * now), both made from `base`. `deletedSince`: the path was deleted at some
 * point after `base`. `mustParse`: a shared note, which must parse.
 */
export function settle(
	path: string,
	base: string | null,
	current: string | null,
	incoming: string | null,
	{ deletedSince = false, labels, mustParse = true }: { deletedSince?: boolean; labels: Labels; mustParse?: boolean },
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
	if (base === null || deletedSince) return { text: appendBlock(current, incoming, labels), disposition: 'different-note' };

	const result = merge(base, current, incoming);
	let text = withMarkers(result, labels) ?? current;
	let conflict = result.overlaps.some((o) => o.unit === 'body' || o.unit === 'block');
	for (const overlap of result.overlaps) {
		if (overlap.unit !== 'field' || overlap.incoming === undefined || overlap.current === undefined) continue;
		// D2: the value that lost is a block in the body.
		const values = {
			current: stringifyField(overlap.key, overlap.current),
			base: overlap.base === undefined ? '' : stringifyField(overlap.key, overlap.base),
			incoming: stringifyField(overlap.key, overlap.incoming),
		};
		text = `${eol(text)}${block(values, labels)}`;
		conflict = true;
	}
	// A merge that cannot keep incoming as a note that parses keeps it whole, as a block.
	if (mustParse && isNote(path) && !parses(text)) return { text: appendBlock(current, incoming, labels), disposition: 'different-note' };
	return { text, disposition: conflict ? 'conflict' : 'landed' };
}

/**
 * Settling one note where two histories meet: what the desktop merge driver
 * writes when `epicenter sync` merges. It returns the text, and whether it
 * wrote a conflict block. The server never merges (ADR-0773).
 *
 * Every conflict is text: overlaps are conflict blocks. A header key
 * both sides set takes the later write's value, `incoming`'s (the write
 * arriving now) over `current`'s (`main`'s), with no block: the value that
 * lost stays in history. A path two writers created holds another note
 * (D3): `current` stays and `incoming` is appended whole as one block. A
 * note deleted and created again since `base` merges by its content, as
 * an edit of the note `base` was: nothing tells the two apart, a visible
 * and repairable result the owner accepted. A block identical to one already in the
 * note is not written again, and one clash is one block however many
 * writes follow it (`merge`'s `continuedBlock`). A blob never merges:
 * `settlePointer` is its rule, the later write winning.
 *
 * A merge never breaks a key: the header merges key by key, each key's
 * block whole, and a body after no header is kept from reading as one (a
 * seeded property in `settle.properties.test.ts`). Only typed text breaks a key, and a
 * broken key costs only that key.
 */

import { parseRowSource } from '../note/canonical.js';
import { formatNote } from '../note/index.js';
import {
	block,
	type Labels,
	type Party,
	versionOf,
	withBlock,
} from './conflict.js';
import { merge, withBlocks } from './merge.js';

export type Settled = {
	text: string | null;
	/** The text holds a conflict block this settle wrote. */
	blocks: boolean;
};

/** Who wrote each side, and when; settle adds each side's version. */
export type Parties = { current: Party; incoming: Party };

/** Labels for a block between these texts: each side's party and the version of the note it had. */
const labelled = (
	parties: Parties,
	base: string | null,
	current: string | null,
	incoming: string | null,
): Labels => ({
	current: { ...parties.current, version: versionOf(current) },
	base: { version: versionOf(base) },
	incoming: { ...parties.incoming, version: versionOf(incoming) },
});

/**
 * Settle a blob path (every file that is not a note), which never merges:
 * the later write wins (ADR-0771), `incoming` (the write arriving now) over
 * `current`, and the version that lost stays in history, as a losing field
 * value does. An edit beats a delete, as for a note (decision 15): a delete
 * of a file changed since its writer read it (`base`) leaves the file, and
 * a replace of a file deleted since brings it back at its path. Writing
 * what is already there lands as nothing, so two writes of the same bytes
 * are one file.
 */
export function settlePointer(
	base: string | null,
	current: string | null,
	incoming: string | null,
): string | null {
	if (incoming === base) return current;
	if (incoming === null && current !== base) return current;
	return incoming;
}

/**
 * Settle `incoming` (the writer's text) against `current` (what is there
 * now), both made from `base`.
 *
 * Whatever settle writes is in house style (decision 29): `keys`, the
 * contract's field order, first, then any other key sorted. Without `keys`
 * a note keeps the key order the merge gave it, and only its values are
 * formatted. A note whose header
 * does not parse is left as merged, for a person to repair. Where nothing
 * is written (`current` stands), `current` is returned as it was.
 */
export function settle(
	base: string | null,
	current: string | null,
	incoming: string | null,
	{ parties, keys }: { parties: Parties; keys?: readonly string[] },
): Settled {
	if (incoming === current) return { text: current, blocks: false };
	if (incoming === base) return { text: current, blocks: false };
	if (current === base) return written(incoming, false, keys);
	// A delete against an edit it had not seen keeps the edit; an edit brings a deleted note back.
	if (incoming === null) return { text: current, blocks: false };
	if (current === null) return written(incoming, false, keys);
	// Two creates of one note (a resend after a lost reply, decision 68):
	// equal in house style, in one key order, so current stands.
	if (base === null) {
		const parsed = parseRowSource(current);
		const order = keys ?? (parsed.error === null ? parsed.data.keyOrder : []);
		if (
			written(current, false, order).text ===
			written(incoming, false, order).text
		)
			return { text: current, blocks: false };
	}
	// Two creates: another note.
	const labels = labelled(parties, base, current, incoming);
	if (base === null)
		return written(
			withBlock(current, block({ current: '', incoming }, labels)),
			true,
			keys,
		);

	const result = merge(base, current, incoming);
	return written(
		withBlocks(result, labels) ?? current,
		result.overlaps.some((o) => o.unit === 'body' || o.unit === 'block'),
		keys,
	);
}

/** A text settle writes, in house style where its header parses. */
function written(
	text: string | null,
	blocks: boolean,
	keys: readonly string[] | undefined,
): Settled {
	if (text === null) return { text, blocks };
	const parsed = parseRowSource(text);
	if (parsed.error !== null) return { text, blocks };
	const formatted = formatNote(text, keys ?? parsed.data.keyOrder);
	return { text: formatted.error === null ? formatted.data : text, blocks };
}

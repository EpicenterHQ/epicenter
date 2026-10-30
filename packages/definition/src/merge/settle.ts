/**
 * Settling one path where two histories meet: the one producer of what
 * happened to a file, used by the server when a web write lands on a moved
 * `main` and by the desktop merge driver when `epicenter sync` merges. It
 * returns the text, and whether it wrote a conflict block.
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
 * `settlePointer` is its rule, compare-and-swap.
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
 * Settle a blob path (every file that is not a note) by compare-and-swap:
 * `incoming` lands only where `current` is still `base`, the blob its
 * writer saw (null: none, for a create). Create, replace and delete are the
 * one rule. An edit beats a delete, as for a note (decision 15): a delete
 * that does not land leaves the file, and a replace of a file that was
 * deleted since brings it back at its path. Any other create or replace
 * that does not land is `lost`: the server puts it beside the other at a
 * sibling (`conflictSibling`), so both are kept. Writing what is already
 * there lands as nothing, so two writes of the same bytes are one file.
 */
export function settlePointer(
	base: string | null,
	current: string | null,
	incoming: string | null,
): { text: string | null } | { lost: true } {
	if (incoming === current || incoming === base || current === base)
		return { text: incoming === base ? current : incoming };
	if (incoming === null) return { text: current };
	if (current === null) return { text: incoming };
	return { lost: true };
}

const utf8 = new TextEncoder();
/** A sibling's own suffix, so a sibling of a sibling is named from the original stem. */
const SIBLING_SUFFIX = / \(conflict [0-9a-f]{7,64}\)$/;

/**
 * RULE: where a losing blob write lands (decision 44, the same on the server
 * and in desktop sync): `<stem> (conflict <hash7>)<ext>` beside `path`, from
 * the original stem (a sibling's own suffix dropped) and the first `chars`
 * characters of `oid`, the losing bytes' LFS oid (the sha256 its pointer
 * names), so every writer names one losing write alike. The stem is
 * shortened, by whole characters, until the name fits 255 bytes and the
 * path `maxPath` bytes.
 */
export function conflictSibling(
	path: string,
	oid: string,
	chars = 7,
	maxPath = Number.POSITIVE_INFINITY,
) {
	const slash = path.lastIndexOf('/');
	const folder = path.slice(0, slash + 1);
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot) : '';
	const suffix = ` (conflict ${oid.slice(0, chars)})${ext}`;
	let stem = [
		...(dot > 0 ? name.slice(0, dot) : name).replace(SIBLING_SUFFIX, ''),
	];
	const fits = () =>
		utf8.encode(stem.join('') + suffix).length <= 255 &&
		utf8.encode(folder + stem.join('') + suffix).length <= maxPath;
	while (stem.length > 0 && !fits()) stem = stem.slice(0, -1);
	return `${folder}${stem.join('')}${suffix}`;
}

/**
 * Settle `incoming` (the writer's text) against `current` (what is there
 * now), both made from `base`.
 *
 * Whatever settle writes is in house style (decision 29): `keys`, the
 * contract's field order, first, then any other key sorted. Without `keys`
 * (the server, which holds no contract) a note keeps the key order the
 * merge gave it, and only its values are formatted. A note whose header
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
		if (written(current, false, order).text === written(incoming, false, order).text)
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

/**
 * The overlap policy: the one place that turns what a merge or a path check
 * found into a decision. Each batch names its policy, by whether its writer
 * waits for the answer.
 *
 * - `'mark'`: a person's write has already been shown as done, so it always
 *   lands. Body overlaps become conflict blocks, the current field value is
 *   kept, an edit beats a delete it had not seen (of a file or of a key), two
 *   creates are joined, and a change whose path no longer holds its note is
 *   relocated or dropped.
 * - `'refuse'`: a `git push` or a `send` waits for its verdict and can read
 *   again and retry, so any overlap refuses the whole batch and nothing
 *   changes.
 *
 * The policy is a convention between callers, not a permission: a caller
 * that sends `'mark'` can leave conflict blocks in anyone's notes.
 */
import type { Overlap, SettledOverlap } from './protocol.js';

export type Policy = 'mark' | 'refuse';

export type Decision =
	| { kind: 'land'; overlaps: SettledOverlap[] }
	| { kind: 'refuse'; reason: string; overlaps: Overlap[] };

export function settle(overlaps: Overlap[], policy: Policy): Decision {
	if (overlaps.length === 0) return { kind: 'land', overlaps: [] };
	if (policy === 'refuse') {
		// A refusal relocates nothing.
		const refused = overlaps.map((o) => (o.unit === 'path' ? { ...o, relocatedTo: null } : o));
		return { kind: 'refuse', reason: describe(overlaps[0] as Overlap), overlaps: refused };
	}
	return { kind: 'land', overlaps: overlaps.map((o) => ({ ...o, settled: settledAs(o) })) };
}

function settledAs(overlap: Overlap): SettledOverlap['settled'] {
	switch (overlap.unit) {
		case 'body':
		case 'block':
			return 'marked';
		case 'field':
			// A key one side deleted keeps the other side's change.
			return overlap.current === undefined || overlap.incoming === undefined ? 'edit-kept' : 'current-kept';
		case 'file':
			return overlap.clash === 'created' ? 'joined' : 'edit-kept';
		case 'path':
			return overlap.relocatedTo === null ? 'dropped' : 'relocated';
	}
}

/** One line for a refusal's reason. */
export function describe(overlap: Overlap): string {
	switch (overlap.unit) {
		case 'body':
		case 'block':
			return 'the change overlaps changes since its base';
		case 'field':
			return `the field '${overlap.key}' changed on both sides`;
		case 'file':
			return overlap.clash === 'created' ? 'both sides created the file' : 'a delete and an edit of the same file';
		case 'path':
			if (overlap.clash === 'reused') return 'the file was deleted and its path reused';
			return overlap.clash === 'taken' ? 'the destination is taken' : 'the file to move is gone';
	}
}

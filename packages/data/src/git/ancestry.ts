import { type GitObject, readCommit } from './objects.js';

/** Missing parents stay unknown. A verified path through any parent proves inclusion. */
export function includesCommit({
	tip,
	target,
	stop,
	objects,
}: {
	tip: string | null;
	target: string;
	/** A commit known to precede target, so its older parents cannot include it. */
	stop?: string | null;
	objects: ReadonlyMap<string, GitObject>;
}): 'included' | 'excluded' | 'unknown' {
	const pending = tip === null ? [] : [tip];
	const visited = new Set<string>();
	let missing = false;
	while (pending.length > 0) {
		const oid = pending.pop()!;
		if (oid === target) return 'included';
		if (oid === stop || visited.has(oid)) continue;
		visited.add(oid);
		const object = objects.get(oid);
		if (object === undefined) {
			missing = true;
			continue;
		}
		if (object.type !== 'commit')
			throw new Error(`Expected commit ${oid}, found ${object.type}`);
		pending.push(...readCommit(object.bytes).parents);
	}
	return missing ? 'unknown' : 'excluded';
}

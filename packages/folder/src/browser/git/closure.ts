import { type GitObject, readCommit, readTree } from '../../git/raw-objects.js';

/** Complete raw file snapshots, deliberately stopping at commit parents. */
export async function snapshotObjects(
	commits: readonly string[],
	read: (oid: string) => Promise<GitObject>,
	trees: readonly string[] = [],
): Promise<Map<string, GitObject>> {
	const objects = new Map<string, GitObject>();
	const pending = [
		...commits.map((oid) => ({ oid, type: 'commit' as GitObject['type'] })),
		...trees.map((oid) => ({ oid, type: 'tree' as GitObject['type'] })),
	];
	while (pending.length > 0) {
		const { oid, type } = pending.pop()!;
		const cached = objects.get(oid);
		const object = cached ?? (await read(oid));
		if (object.type !== type)
			throw new Error(`Expected ${type} object ${oid}, found ${object.type}`);
		if (cached !== undefined) continue;
		objects.set(oid, object);
		if (type === 'commit')
			pending.push({ oid: readCommit(object.bytes).tree, type: 'tree' });
		if (type === 'tree') {
			for (const entry of readTree(object.bytes)) {
				if (entry.mode === '160000') continue;
				pending.push({
					oid: entry.oid,
					type:
						entry.mode === '40000' || entry.mode === '040000' ? 'tree' : 'blob',
				});
			}
		}
	}
	return objects;
}

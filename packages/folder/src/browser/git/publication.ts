/** Select Git source without removing ignored files from the local folder. */

import type { GitObject } from '../../git/raw-objects.js';
import { gitignoreMatcher } from '../../git/scope.js';
import { changeSnapshot, emptyTree, readSnapshot } from './snapshot.js';

/** Rule files are regular files; Git does not follow a symlinked .gitignore. */
export function isIgnoreFile(path: string, mode: string) {
	return (
		(path === '.gitignore' || path.endsWith('/.gitignore')) &&
		(mode === '100644' || mode === '100755')
	);
}

/** Tracked paths survive ignore rules; only untracked, ignored leaves are omitted. */
export async function selectSource({
	workingTree,
	trackedTree,
	read,
}: {
	workingTree: string;
	trackedTree: string | null;
	read: (oid: string) => Promise<GitObject>;
}) {
	if (workingTree === (trackedTree ?? emptyTree))
		return {
			tree: workingTree,
			objects: new Map<string, GitObject>(),
			excluded: [] as string[],
		};
	const current = await readSnapshot(workingTree, read);
	const tracked = await readSnapshot(trackedTree, read);
	const rules = new Map<string, Uint8Array>();
	for (const [path, entry] of current.files)
		if (isIgnoreFile(path, entry.mode)) {
			const object = await read(entry.oid);
			if (object.type !== 'blob')
				throw new Error(`Expected ignore blob ${entry.oid}`);
			rules.set(path, object.bytes);
		}
	const ignored = gitignoreMatcher(rules);
	const excluded = [...current.files.keys()].filter(
		(path) => !tracked.files.has(path) && ignored(path),
	);
	if (excluded.length === 0)
		return {
			tree: workingTree,
			objects: new Map<string, GitObject>(),
			excluded,
		};
	return {
		...(await changeSnapshot({
			root: workingTree,
			edits: new Map(excluded.map((path) => [path, null])),
			read,
		})),
		excluded,
	};
}

/**
 * Automatic commit subjects derived from captured trees (ADR-0469).
 *
 * The subject counts changed leaf paths between the parent tree and the exact
 * candidate tree. It does not infer renames, group a row with its attachment,
 * read Markdown, or name the app action that requested the commit.
 */

export type PathChange = {
	readonly path: string;
	readonly kind: 'add' | 'modify' | 'delete';
};

const SUBJECT_LIMIT = 72;

/** Escape control characters and backslashes so a path cannot forge message structure. */
export function escapePath(path: string): string {
	let escaped = '';
	for (const character of path) {
		const code = character.codePointAt(0)!;
		if (character === '\\') escaped += '\\\\';
		else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0))
			escaped += `\\x${code.toString(16).padStart(2, '0')}`;
		else if (code === 0x2028 || code === 0x2029)
			escaped += `\\u${code.toString(16)}`;
		else escaped += character;
	}
	return escaped;
}

/** The subject for a nonempty change set, or `undefined` when nothing changed. */
export function commitSubject(
	changes: readonly PathChange[],
): string | undefined {
	if (changes.length === 0) return undefined;
	if (changes.length > 1) return `Update ${changes.length} files`;
	const [change] = changes as [PathChange];
	const verb =
		change.kind === 'add'
			? 'Add'
			: change.kind === 'delete'
				? 'Delete'
				: 'Update';
	const subject = `${verb} ${escapePath(change.path)}`;
	return subject.length <= SUBJECT_LIMIT ? subject : 'Update 1 file';
}

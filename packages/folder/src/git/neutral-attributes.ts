/**
 * The attributes every repository Epicenter creates or clones checks out
 * with: none that change bytes.
 *
 * Epicenter commits each file's bytes as they are on disk, because it hashes
 * from standard input with no path (`native-backend.ts`). Git's own checkout
 * still applies attributes: a smudge filter, `text` and `eol` conversion,
 * `$Id$` expansion under `ident`, and re-encoding under
 * `working-tree-encoding`. A file checked out that way differs from its blob,
 * and the next Save version would commit the difference. Git reads
 * `$GIT_DIR/info/attributes` before every committed `.gitattributes` and
 * before `core.attributesFile`, a state found there is final, and within the
 * file a later line wins. So one last line unsetting each attribute for
 * every path makes every checkout, archive, and `git add` in the repository
 * take the blob's bytes as they are, whatever lines above it say. The file
 * sits in Git's common directory, so linked worktrees read it too.
 */
import type { DirectoryPrimitives } from '../directory-primitives.js';

/** The last line of `$GIT_DIR/info/attributes` in a repository Epicenter made. */
export const NEUTRAL_ATTRIBUTES =
	'* -filter -text -eol -ident -working-tree-encoding -export-ignore -export-subst';

/**
 * Make `NEUTRAL_ATTRIBUTES` the last line of `info/attributes` in `gitdir`,
 * the repository's Git directory (or, with linked worktrees, its common
 * directory). Lines a person wrote there stay, above it. The new file is
 * written beside it and renamed over it, so a link at that path is replaced,
 * never followed. Nothing is written when the line is already last. Run it
 * before the first checkout: before `git init`, which keeps the file, or
 * after `git clone --no-checkout`.
 */
export async function neutralizeAttributes(
	files: DirectoryPrimitives,
	gitdir: string,
): Promise<void> {
	const info = `${gitdir}/info`;
	const path = `${info}/attributes`;
	await files.mkdir(info);
	const lines =
		(await files.lstat(path))?.kind === 'file'
			? new TextDecoder().decode(await files.readFile(path)).split('\n')
			: [];
	if (lines.at(-1) === '') lines.pop();
	if (lines.at(-1) === NEUTRAL_ATTRIBUTES) return;
	const kept = lines.filter((line) => line.trimEnd() !== NEUTRAL_ATTRIBUTES);
	const staged = `${path}.${crypto.randomUUID()}`;
	await files.writeFile(
		staged,
		new TextEncoder().encode(`${[...kept, NEUTRAL_ATTRIBUTES].join('\n')}\n`),
		{ createNew: true },
	);
	try {
		await files.rename(staged, path, 'any');
	} catch (cause) {
		await files.remove(staged).catch(() => {});
		throw cause;
	}
}

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
 * before `core.attributesFile`, and a state found there is final, so one
 * line unsetting each attribute for every path makes every checkout, archive,
 * and `git add` in the repository take the blob's bytes as they are. The
 * file sits in Git's common directory, so linked worktrees read it too.
 */
import type { DirectoryPrimitives } from '../directory-primitives.js';

/** The whole of `$GIT_DIR/info/attributes` in a repository Epicenter made. */
export const NEUTRAL_ATTRIBUTES =
	'* -filter -text -eol -ident -working-tree-encoding -export-ignore -export-subst\n';

/**
 * Write `NEUTRAL_ATTRIBUTES` as `info/attributes` in `gitdir`, the
 * repository's Git directory (or, for a repository with linked worktrees,
 * its common directory), replacing what was there. Run it after `git init`
 * or `git clone --no-checkout` and before the first checkout.
 */
export async function neutralizeAttributes(
	files: DirectoryPrimitives,
	gitdir: string,
): Promise<void> {
	await files.mkdir(`${gitdir}/info`);
	await files.writeFile(
		`${gitdir}/info/attributes`,
		new TextEncoder().encode(NEUTRAL_ATTRIBUTES),
	);
}

/**
 * The bound reader: a handle over a mirror it is not allowed to change.
 *
 * A reader has no `write` and no rebuild. That is not a mode of the writer with
 * the dangerous parts switched off; it is a different capability. A reader must
 * survive being pointed at a mirror an older declaration wrote, must not fail
 * with SQLITE_BUSY because it wanted to stamp a bookkeeping row, and must never
 * drop a table a concurrent sync is filling. So it opens nothing, creates
 * nothing, and stamps nothing.
 *
 * In exchange it gets the one thing the writer cannot have: `stale`. A writer is
 * never stale, because by the time it exists it has already matched or rebuilt.
 * A reader can be, and reporting that is a state, not an error.
 *
 * The caller is expected to hand over a database opened read-only, so the
 * refusal is enforced by SQLite as well as by this surface.
 */

import type { SqliteDatabase } from '@epicenter/sqlite';
import type { Mirror } from './declaration.ts';
import {
	createReads,
	DECLARATION_KEY,
	type MirrorReads,
	readMeta,
} from './reads.ts';

export type MirrorReader = MirrorReads & {
	/**
	 * Whether the mirror on disk was written by a different declaration. True
	 * also means "never written": there is nothing here yet either way, and both
	 * are fixed by letting a writer run.
	 */
	readonly stale: boolean;
	/**
	 * The declaration the mirror was actually written with, or null if none.
	 * Kept verbatim so a diagnostic can diff it against `mirror.canonical` and
	 * name the column that changed, rather than reporting that two values
	 * differ.
	 */
	readonly storedDeclaration: string | null;
};

export function openMirrorReader(
	mirror: Mirror,
	{ database }: { database: SqliteDatabase },
): MirrorReader {
	const storedDeclaration = readMeta(database, DECLARATION_KEY);
	return {
		...createReads(database),
		stale: storedDeclaration !== mirror.canonical,
		storedDeclaration,
	};
}

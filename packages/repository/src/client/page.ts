/**
 * What a page asks of its replica, wherever the replica runs (a browser's
 * worker, or the same process in Bun): an ordered snapshot of the notes it
 * keeps in memory, then every change to them in revision order, one-note
 * reads and SQL for the rest, and changes over what the replica shows.
 *
 * A collection kept in memory gets whole rows in its snapshot and in every
 * delta: its exact text, its fields as the replica parsed them, and its
 * state. A collection that is not gets only its changed paths, so a large
 * catch-up of notes the page does not keep never crosses to it.
 */
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { fold } from '../core/door.js';
import { matchTemplate, type Template } from '../core/templates.js';
import type { Change, Changed, ChangeError, FileStatus, Replica } from './replica.js';

/** One of an app's collections, as the replica serves it: its view, its template, and whether the page keeps it in memory. */
export type Collection = { name: string; view: string; template: Template; memory: boolean };

/** One note as the page reads it: its exact text, its fields as JSON (null when its frontmatter does not parse), and its state. */
export type Row = { path: string; text: string; fields: string | null; state: FileStatus };

/** A file as the plain file API lists it: its path, and where it stands with the server. */
export type FileEntry = { path: string; state: FileStatus };

/** Every note of the collections kept in memory, as of `revision`. */
export type Snapshot = { revision: number; rows: Row[] };

/**
 * What one stored change did: the paths whose text or state changed, and
 * for those in a collection kept in memory, the row now (null: no note).
 */
export type Delta = {
	revision: number;
	paths: string[];
	rows: Record<string, Row | null>;
	/** The page's token for the change that made this, when the page made it: the rows already hold it, so the page stops showing it as pending. */
	token?: number;
};

/** What a page's save can come back as instead of stored. */
export const SaveError = defineErrors({
	/** The device's storage is full: nothing of the save was stored. */
	QuotaExceeded: () => ({ message: 'This device has no room left, so the save was not stored' }),
	/** Storage failed for another reason: nothing of the save was stored. */
	Failed: ({ reason }: { reason: string }) => ({ message: `The save was not stored: ${reason}`, reason }),
	/** The replica closed (another tab took it, the page hid, or its worker stopped) before the save reached it. */
	Closed: () => ({ message: 'The replica is not open in this tab' }),
});
export type SaveError = InferErrors<typeof SaveError>;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Serve a page from `replica`, for an app's collections. `failed` says what
 * a save that storage refused (it threw, and the transaction rolled back)
 * comes back as: a host that can tell a full disk says so.
 */
export function servePage(
	replica: Replica,
	collections: Collection[],
	{ failed = (cause) => SaveError.Failed({ reason: extractErrorMessage(cause) }) }: { failed?: (cause: unknown) => ReturnType<(typeof SaveError)[keyof typeof SaveError]> } = {},
) {
	const kept = collections.filter((collection) => collection.memory);
	/** The token of the change being applied now: the replica tells its watchers inside the transaction's save. */
	let making: number | undefined;
	const isKept = (path: string) => kept.some((collection) => matchTemplate(collection.template, path) !== null);

	/** One path's row, or null when the replica shows no file there. `unsent` names the paths with work, whose state is read; any other is synced. */
	function rowOf(path: string, text: string | null, fields: string | null, unsent?: Set<string>): Row | null {
		if (text === null) return null;
		const state: FileStatus = unsent === undefined || unsent.has(path) ? replica.state(path) : { status: 'synced' };
		return { path, text, fields, state };
	}
	/** The row at exactly `path`, as a change to it is heard. */
	function rowAt(path: string): Row | null {
		const [found] = replica.query<{ text: string | null; fields: string | null }>('SELECT text, fields FROM "epicenter/files" WHERE path = ?', [path]);
		return found === undefined ? null : rowOf(path, found.text, found.fields);
	}
	/** One note found by any spelling of its path (paths equal after NFC and case folding are one path), under the spelling this device has. */
	function read(path: string): Row | null {
		const [found] = replica.query<{ path: string; text: string | null; fields: string | null }>(
			'SELECT path, text, fields FROM "epicenter/files" WHERE fold = ? AND text IS NOT NULL ORDER BY rowid LIMIT 1',
			[fold(path)],
		);
		return found === undefined ? null : rowOf(found.path, found.text, found.fields);
	}

	/** The paths with work, whose state is read; every other path is synced. */
	const withWork = () => new Set([...replica.unsent(), ...replica.held().map((held) => held.path)]);

	return {
		/** Every note of the collections kept in memory, as of one revision. */
		snapshot(): Snapshot {
			const unsent = withWork();
			const rows: Row[] = [];
			for (const collection of kept)
				for (const found of replica.query<{ path: string; text: string; fields: string | null }>(
					`SELECT f.path, f.text, f.fields FROM "epicenter/files" f WHERE f.path IN (SELECT path FROM ${quote(collection.name)}) ORDER BY f.path`,
				)) {
					const row = rowOf(found.path, found.text, found.fields, unsent);
					if (row !== null) rows.push(row);
				}
			return { revision: replica.revision(), rows };
		},
		/** Every file this device shows, in any collection or none, ordered by path, with its state. */
		files(): FileEntry[] {
			const unsent = withWork();
			return replica.paths().map((path) => ({ path, state: unsent.has(path) ? replica.state(path) : { status: 'synced' } }));
		},
		/** Every file not yet synced (sending, or held with why), deletes included, ordered by path: indexed, so a count of them costs what they number, not the repository. */
		waiting(): FileEntry[] {
			return [...withWork()].sort().map((path) => ({ path, state: replica.state(path) }));
		},
		/** One note, for a collection not kept in memory. */
		read,
		query: replica.query,
		/** Apply changes over what the replica shows now: stored, or not at all, and said so before anything is acknowledged. */
		change(changes: Change[], token?: number, message?: string): Result<Changed, ChangeError | SaveError> {
			making = token;
			try {
				return replica.change(changes, message === undefined ? {} : { message });
			} catch (cause) {
				return failed(cause);
			} finally {
				making = undefined;
			}
		},
		/** Be told each change once it is stored, in revision order; returns the function that stops it. */
		watch(listener: (delta: Delta) => void) {
			return replica.watch((paths, revision) => {
				const rows: Record<string, Row | null> = {};
				for (const path of paths) if (isKept(path)) rows[path] = rowAt(path);
				listener(making === undefined ? { revision, paths, rows } : { revision, paths, rows, token: making });
			});
		},
	};
}
export type PageServer = ReturnType<typeof servePage>;

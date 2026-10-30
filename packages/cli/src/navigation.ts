/** Machine-local pins and successful openings in one SQLite database. */

import { Database } from 'bun:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { holdingFileLock } from '@epicenter/folder/bun';
import { resolveAppPaths } from './app-paths.js';
import { EXIT, writeJson, writeOut } from './output.js';

export const FILE = 'navigation.sqlite';
export type Navigation = { pins: string[]; recent: string[] };
export type List = 'pins' | 'recent';
const PINS_TABLE =
	'CREATE TABLE pins(path TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID';
const RECENT_TABLE =
	'CREATE TABLE recent(path TEXT NOT NULL PRIMARY KEY, sequence INTEGER NOT NULL) STRICT';
const APPLICATION_ID = 0x45504e56; // EPNV
const USER_VERSION = 1;

function unchanged(path: string, reason: string): Error {
	return new Error(
		`${path} was left unchanged because ${reason}. Repair it to change pinned and recent folders again.`,
	);
}

function databaseError(path: string, cause: unknown): Error {
	if (
		cause instanceof Error &&
		cause.message.startsWith(`${path} was left unchanged`)
	)
		return cause;
	const code = String((cause as { code?: unknown })?.code);
	if (/^SQLITE_(BUSY|LOCKED)/.test(code))
		return new Error(
			`${path} is busy because another navigation writer has it open. Try again.`,
		);
	return unchanged(
		path,
		cause instanceof Error ? cause.message : String(cause),
	);
}

async function exists(path: string): Promise<boolean> {
	const kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (kind === undefined) return false;
	if (!kind.isFile()) throw unchanged(path, 'it is not a regular file');
	return true;
}

function schema(db: Database, path: string): 'empty' | 'ready' {
	const mode = db.query('PRAGMA journal_mode').get() as {
		journal_mode: string;
	};
	if (mode.journal_mode.toLowerCase() !== 'delete')
		throw unchanged(
			path,
			`journal mode ${mode.journal_mode} is unsupported; navigation requires DELETE mode`,
		);
	const { application_id } = db.query('PRAGMA application_id').get() as {
		application_id: number;
	};
	const { user_version } = db.query('PRAGMA user_version').get() as {
		user_version: number;
	};
	const objects = db
		.query(
			"SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as Array<{ name: string; sql: string | null }>;
	if (application_id === 0 && user_version === 0 && objects.length === 0)
		return 'empty';
	if (
		application_id === APPLICATION_ID &&
		user_version === USER_VERSION &&
		objects.length === 2 &&
		objects[0]?.name === 'pins' &&
		objects[0]?.sql === PINS_TABLE &&
		objects[1]?.name === 'recent' &&
		objects[1]?.sql === RECENT_TABLE
	)
		return 'ready';
	throw unchanged(
		path,
		`unknown navigation schema (application_id=${application_id}, user_version=${user_version})`,
	);
}

function initialize(db: Database) {
	db.exec(
		`${PINS_TABLE}; ${RECENT_TABLE}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${USER_VERSION};`,
	);
}

function paths(db: Database, list: List): string[] {
	const sql =
		list === 'pins'
			? 'SELECT path FROM pins ORDER BY path'
			: 'SELECT path FROM recent ORDER BY sequence DESC';
	return (db.query(sql).all() as Array<{ path: string }>).map(
		(row) => row.path,
	);
}

function open(path: string, create: boolean): Database {
	try {
		try {
			if (!lstatSync(path).isFile())
				throw unchanged(path, 'it is not a regular file');
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
			if (!create) throw cause;
		}
		const db = new Database(
			path,
			create ? { create: true, readwrite: true } : { readwrite: true },
		);
		db.exec('PRAGMA busy_timeout = 10000');
		return db;
	} catch (cause) {
		throw databaseError(path, cause);
	}
}

/** Read both lists from one snapshot. An absent database creates nothing. */
export async function readNavigation(dataDir: string): Promise<Navigation> {
	const path = join(dataDir, FILE);
	if (!(await exists(path))) return { pins: [], recent: [] };
	const db = open(path, false);
	try {
		return db
			.transaction(() => {
				if (schema(db, path) === 'empty') return { pins: [], recent: [] };
				return { pins: paths(db, 'pins'), recent: paths(db, 'recent') };
			})
			.deferred();
	} catch (cause) {
		throw databaseError(path, cause);
	} finally {
		db.close();
	}
}

/** One synchronous IMMEDIATE turn; the callback only issues domain SQL. */
function mutate<T>(
	dataDir: string,
	create: boolean,
	change: (db: Database) => T,
): T | undefined {
	const path = join(dataDir, FILE);
	const db = open(path, create);
	try {
		return db
			.transaction(() => {
				const state = schema(db, path);
				if (state === 'empty' && !create) return undefined;
				if (state === 'empty') initialize(db);
				return change(db);
			})
			.immediate();
	} catch (cause) {
		throw databaseError(path, cause);
	} finally {
		db.close();
	}
}

function canonical(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Insert a pin once, comparing saved aliases inside the write transaction. */
export async function pinNavigation(
	dataDir: string,
	path: string,
): Promise<boolean> {
	const existing = await exists(join(dataDir, FILE));
	if (!existing) await mkdir(dataDir, { recursive: true });
	return mutate(dataDir, true, (db) => {
		if (
			paths(db, 'pins').some(
				(entry) => entry === path || canonical(entry) === path,
			)
		)
			return false;
		db.query('INSERT INTO pins(path) VALUES (?1)').run(path);
		return true;
	}) as boolean;
}

/** Remove every matching spelling from exactly one fact table. */
export async function removeNavigation(
	dataDir: string,
	list: List,
	supplied: string,
): Promise<boolean> {
	if (!(await exists(join(dataDir, FILE)))) return false;
	const resolved = resolve(supplied);
	return (
		mutate(dataDir, false, (db) => {
			const identity = canonical(resolved);
			let changed = false;
			const sql =
				list === 'pins'
					? 'DELETE FROM pins WHERE path = ?1'
					: 'DELETE FROM recent WHERE path = ?1';
			for (const entry of paths(db, list)) {
				if (
					entry === supplied ||
					entry === resolved ||
					(identity !== undefined && canonical(entry) === identity)
				) {
					db.query(sql).run(entry);
					changed = true;
				}
			}
			return changed;
		}) ?? false
	);
}
/** Remove obsolete metadata under the same lock an old writer used. */
export async function discardBookmarks(dataDir: string): Promise<void> {
	const path = join(dataDir, 'bookmarks.json');
	const before = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (before === undefined) return;
	await holdingFileLock(
		join(dataDir, '.bookmarks.json.epicenter-save-lock'),
		{
			waitMs: 10_000,
			held: `${path} could not be removed while another writer held its save lock.`,
		},
		async () => {
			const kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT') return undefined;
				throw cause;
			});
			if (kind === undefined) return;
			if (kind.isDirectory())
				throw new Error(`${path} is a directory; remove it manually.`);
			await rm(path);
		},
	);
}

/** Folder navigation changes never alter authored files or launch defaults. */
export async function foldersCommand(
	action: 'pin' | 'unpin' | 'list' | 'remove-recent',
	input: string | undefined,
	json: boolean,
) {
	const { dataDir } = resolveAppPaths();
	await discardBookmarks(dataDir);
	if (action === 'list') {
		const saved = await readNavigation(dataDir);
		const inspect = async (entries: string[]) =>
			Promise.all(
				entries.map(async (path) => {
					let problem: string | null = null;
					try {
						if (!isAbsolute(path))
							throw new Error('This is not an absolute folder path.');
						if (!(await lstat(path)).isDirectory())
							throw new Error('This path is a link or not a folder.');
					} catch (cause) {
						problem = cause instanceof Error ? cause.message : String(cause);
					}
					return { path, problem };
				}),
			);
		const pins = await inspect(saved.pins);
		const recent = await inspect(saved.recent);
		if (json) writeJson({ pins, recent });
		else
			for (const [group, entries] of [
				['pinned', pins],
				['recent', recent],
			] as const)
				for (const { path, problem } of entries)
					writeOut(
						`${group}\t${path}${problem === null ? '' : `\t${problem}`}`,
					);
		return EXIT.ok;
	}
	const supplied = input as string;
	let path = resolve(supplied);
	if (action === 'pin') {
		if (!(await lstat(path)).isDirectory())
			throw new Error(`${path} is a link or not a folder.`);
		path = await realpath(path);
	}
	const changed =
		action === 'pin'
			? await pinNavigation(dataDir, path)
			: await removeNavigation(
					dataDir,
					action === 'unpin' ? 'pins' : 'recent',
					supplied,
				);
	if (json) writeJson({ path, changed });
	else
		writeOut(
			action === 'pin'
				? `Pinned ${path}`
				: action === 'unpin'
					? `Unpinned ${path}`
					: `Removed ${path} from Recent`,
		);
	return EXIT.ok;
}

/**
 * Prototype B, "plan": four verbs, each with one job.
 *
 *   runtime.locate(ref)                -> where the store lives (runtime owns it)
 *   inspect(decl, location, authority) -> what state it is in (writes nothing)
 *   openReader(...)                    -> a handle with no destructive methods
 *   acquireWriteLease(location)        -> the only route to a controller
 *
 * The claim under test is not that this is more ergonomic. It is that "open"
 * in the current shape is three unrelated authorities wearing one word: name a
 * path, judge validity, destroy data. ADR-0192 clause B has to *say* "a
 * read-only connection never migrates, never drops, and never writes" only
 * because one function can do all three. Split the verbs and the sentence
 * becomes a type.
 */

import type { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync, rmSync, statSync } from 'node:fs';
import type { UpstreamRecord } from '../authority.ts';
import type { MaterializationDeclaration } from '../declaration.ts';
import {
	applyIndexes,
	createDeclaredTables,
	dropTables,
	ingest,
	type MirrorRow,
	openConnection,
	readTable,
} from '../store.ts';
import type {
	Manifest,
	MaterializationState,
	RebuildPlan,
} from './manifest.ts';
import { buildManifest, comparePlan } from './manifest.ts';
import type { StoreLocation } from './runtime.ts';

const MANIFEST_TABLE = '_manifest';
const STATE_TABLE = '_state';
export const RESERVED_TABLES = [MANIFEST_TABLE, STATE_TABLE] as const;

/* -------------------------------------------------------------- inspection */

/**
 * Total and non-destructive. Opens read-only when a file exists, reads the
 * manifest, compares, and closes. Nothing here can drop, stamp, or migrate,
 * because nothing here can write.
 */
export function inspect(
	declaration: MaterializationDeclaration,
	location: StoreLocation,
	authority: string,
): MaterializationState {
	if (!existsSync(location.dbPath))
		return comparePlan(declaration, authority, null);
	const db = openConnection(location.dbPath, { readonly: true });
	try {
		return comparePlan(declaration, authority, readManifest(db));
	} finally {
		db.close();
	}
}

/* ------------------------------------------------------------------ readers */

/** A read over a store known to match the running declaration. */
export type CurrentReader = {
	readonly kind: 'current';
	readonly manifest: Manifest;
	read(table: string): MirrorRow[];
	sql<T>(query: string): T[];
	close(): void;
};

/** A read whose rows came from a shape the running release does not declare. */
export type StaleRead<T> = {
	readonly staleness: RebuildPlan;
	readonly rows: T[];
};

/**
 * A stale reader is a *different type*, not a flag on the same one. Readers may
 * open stale data (ADR-0061 makes the mirror the offline high-volume surface,
 * and failing closed would turn a renamed field into an outage), but the rows
 * arrive wrapped, so ignoring staleness is an explicit unwrap a reviewer sees.
 */
export type StaleReader = {
	readonly kind: 'stale';
	readonly plan: RebuildPlan;
	read(table: string): StaleRead<MirrorRow>;
	sql<T>(query: string): StaleRead<T>;
	close(): void;
};

/** No handle at all: another principal's data must not be read *or* rebuilt. */
export type ForeignStore = {
	readonly kind: 'foreign';
	readonly storedAuthority: string;
	readonly expectedAuthority: string;
};

export type AbsentStore = {
	readonly kind: 'absent';
	readonly plan: RebuildPlan;
};

export type ReaderResult =
	| CurrentReader
	| StaleReader
	| ForeignStore
	| AbsentStore;

export function openReader(
	declaration: MaterializationDeclaration,
	location: StoreLocation,
	authority: string,
): ReaderResult {
	const state = inspect(declaration, location, authority);
	if (state.kind === 'absent') return { kind: 'absent', plan: state.plan };
	if (state.kind === 'foreign') {
		return {
			kind: 'foreign',
			storedAuthority: state.manifest.authority,
			expectedAuthority: state.expectedAuthority,
		};
	}

	const db = openConnection(location.dbPath, { readonly: true });
	if (state.kind === 'current') {
		return {
			kind: 'current',
			manifest: state.manifest,
			read: (table) => readTable(db, declaration, table),
			sql: <T>(query: string) => db.query<T, []>(query).all(),
			close: () => db.close(),
		};
	}
	const { plan } = state;
	return {
		kind: 'stale',
		plan,
		read: (table) => ({
			staleness: plan,
			rows: readTable(db, declaration, table),
		}),
		sql: <T>(query: string) => ({
			staleness: plan,
			rows: db.query<T, []>(query).all(),
		}),
		close: () => db.close(),
	};
}

/* ------------------------------------------------------------------- leases */

export class LeaseRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LeaseRequiredError';
	}
}

/** A plan that does not belong to this store, or a store that is not ours. */
export class PlanRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlanRefusedError';
	}
}

/**
 * One sync owner per principal (ADR-0192 clause D), as an exclusive artifact
 * rather than a convention. A second attempt yields; it does not race a bulk
 * pull against a shared cursor.
 */
export type WriteLease = {
	readonly location: StoreLocation;
	open(declaration: MaterializationDeclaration, authority: string): Controller;
	release(): void;
};

export type LeaseResult =
	| { readonly acquired: true; readonly lease: WriteLease }
	| { readonly acquired: false; readonly heldSince: Date };

export function acquireWriteLease(location: StoreLocation): LeaseResult {
	let handle: number;
	try {
		handle = openSync(location.leasePath, 'wx');
	} catch {
		return { acquired: false, heldSince: statSync(location.leasePath).mtime };
	}
	closeSync(handle);

	let released = false;
	const open: WriteLease['open'] = (declaration, authority) => {
		if (released) throw new LeaseRequiredError('This lease has been released');
		return createController(declaration, location, authority, () => released);
	};
	return {
		acquired: true,
		lease: {
			location,
			open,
			release() {
				if (released) return;
				released = true;
				rmSync(location.leasePath, { force: true });
			},
		},
	};
}

/* --------------------------------------------------------------- controller */

/**
 * The only thing that can destroy data, and it is only reachable through a
 * lease. `apply` takes a plan produced by `inspect`, so what a release will do
 * to a store is a value you can print, log, assert on, and refuse before any
 * of it happens.
 */
export type Controller = {
	state(): MaterializationState;
	apply(plan: RebuildPlan): void;
	ingest(
		records: readonly UpstreamRecord[],
		options: { syncedAt: string },
	): void;
	read(table: string): MirrorRow[];
	cursor(): number;
	setCursor(value: number): void;
	close(): void;
};

function createController(
	declaration: MaterializationDeclaration,
	location: StoreLocation,
	authority: string,
	isReleased: () => boolean,
): Controller {
	const db = openConnection(location.dbPath, { readonly: false });
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);`,
	);
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (key TEXT PRIMARY KEY, value TEXT);`,
	);

	function guard(): void {
		if (isReleased())
			throw new LeaseRequiredError('The write lease was released');
	}

	return {
		state: () => comparePlan(declaration, authority, readManifest(db)),
		apply(plan) {
			guard();
			const current = comparePlan(declaration, authority, readManifest(db));
			if (current.kind === 'foreign') {
				throw new PlanRefusedError(
					`Refusing to rebuild a store held by ${current.manifest.authority}`,
				);
			}
			// A plan is a value, so it can travel. It must not travel between
			// stores: applying one store's plan to another is how a rebuild
			// silently discards someone else's data.
			const target = buildManifest(declaration, authority);
			if (
				plan.nextManifest.whole !== target.whole ||
				plan.nextManifest.authority !== authority
			) {
				throw new PlanRefusedError(
					'This plan was produced for a different declaration or authority',
				);
			}
			const write = db.transaction(() => {
				dropTables(db, plan.dropTables);
				if (plan.clearCursor)
					db.exec(`DELETE FROM ${STATE_TABLE} WHERE key = 'cursor';`);
				createDeclaredTables(db, declaration);
				applyIndexes(db, declaration);
				writeManifest(db, plan.nextManifest);
			});
			write.immediate();
		},
		ingest(records, options) {
			guard();
			ingest(db, declaration, records, options);
		},
		read: (table) => readTable(db, declaration, table),
		cursor: () =>
			Number(
				db
					.query<{ value: string | null }, [string]>(
						`SELECT value FROM ${STATE_TABLE} WHERE key = ?`,
					)
					.get('cursor')?.value ?? '0',
			),
		setCursor(value) {
			guard();
			db.query(
				`INSERT INTO ${STATE_TABLE} (key, value) VALUES ('cursor', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			).run(String(value));
		},
		close: () => db.close(),
	};
}

/* ------------------------------------------------------------------ storage */

function readManifest(db: Database): Manifest | null {
	const exists = db
		.query<{ name: string }, [string]>(
			`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
		)
		.get(MANIFEST_TABLE);
	if (!exists) return null;
	const row = db
		.query<{ json: string }, []>(
			`SELECT json FROM ${MANIFEST_TABLE} WHERE id = 1`,
		)
		.get();
	return row ? (JSON.parse(row.json) as Manifest) : null;
}

function writeManifest(db: Database, manifest: Manifest): void {
	db.query(
		`INSERT INTO ${MANIFEST_TABLE} (id, json) VALUES (1, ?)
		 ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
	).run(JSON.stringify(manifest));
}

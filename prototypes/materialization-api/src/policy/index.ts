/**
 * Prototype A, "policy": the shape ADR-0194 names, steelmanned.
 *
 *   defineMaterialization(decl)
 *   openMaterialization(decl, { path, policy, readonly })
 *
 * The declaration is pure data. The store's location is the caller's. The
 * rebuild gate is one SHA-256 string in `_meta`, compared for equality. What is
 * *added* over the tree's current shape, in good faith, is that the destructive
 * behaviour is named rather than unconditional: a `LifecyclePolicy` decides
 * what a stale store means, and three are supplied.
 *
 * This is the honest best version of "rebuild is an open policy", and the
 * conformance suite exists to find out how far that gets.
 */

import type { Database } from 'bun:sqlite';
import type { UpstreamRecord } from '../authority.ts';
import type { MaterializationDeclaration } from '../declaration.ts';
import { wholeDigest } from '../declaration.ts';
import {
	applyIndexes,
	createDeclaredTables,
	dropTables,
	ingest,
	listDerivedTables,
	type MirrorRow,
	openConnection,
	readTable,
} from '../store.ts';

const META = '_meta';
const FINGERPRINT_KEY = 'fingerprint';
const CURSOR_KEY = 'cursor';

/** Identity, for inference and for a place to hang the doc comment. */
export function defineMaterialization(
	declaration: MaterializationDeclaration,
): MaterializationDeclaration {
	return declaration;
}

export type StaleContext = {
	stored: string | null;
	expected: string;
	/** Drop every derived table and clear the cursor. */
	drop(): void;
};

/**
 * What a writer does when the stored fingerprint is not the expected one.
 * Returning `'refused'` aborts the open; the handle is never constructed.
 */
export type LifecyclePolicy = {
	readonly name: string;
	onStale(context: StaleContext): 'rebuilt' | 'refused' | 'kept';
};

/** Drop and re-pull. What the tree does today, made explicit. */
export const rebuildOnStale: LifecyclePolicy = {
	name: 'rebuildOnStale',
	onStale(context) {
		context.drop();
		return 'rebuilt';
	},
};

/** Refuse the open. Safe, and an outage caused by a renamed field. */
export const refuseStale: LifecyclePolicy = {
	name: 'refuseStale',
	onStale: () => 'refused',
};

/** Open anyway and leave the old tables in place. Reports, repairs nothing. */
export const readStale: LifecyclePolicy = {
	name: 'readStale',
	onStale: () => 'kept',
};

export class StaleMaterializationError extends Error {
	constructor(
		readonly stored: string | null,
		readonly expected: string,
	) {
		super(
			`Materialization is stale: stored ${stored ?? 'none'}, expected ${expected}`,
		);
		this.name = 'StaleMaterializationError';
	}
}

export type MaterializationHandle = {
	readonly fingerprint: string;
	readonly storedFingerprint: string | null;
	readonly stale: boolean;
	readonly policy: string;
	ingest(
		records: readonly UpstreamRecord[],
		options: { syncedAt: string },
	): void;
	read(table: string): MirrorRow[];
	/** Raw SQL, the ADR-0061 high-volume surface. */
	sql<T>(query: string): T[];
	cursor(): number;
	setCursor(value: number): void;
	/**
	 * Present on every handle. On a read-only handle SQLite rejects the write,
	 * so the invariant "a reader never drops" holds at runtime, late, and only
	 * if someone actually calls it. That lateness is the point of the
	 * comparison, not an oversight.
	 */
	rebuild(): void;
	close(): void;
};

export type OpenOptions = {
	path: string;
	policy?: LifecyclePolicy;
	readonly?: boolean;
};

export function openMaterialization(
	declaration: MaterializationDeclaration,
	{ path, policy = rebuildOnStale, readonly = false }: OpenOptions,
): MaterializationHandle {
	const expected = wholeDigest(declaration);
	const db = openConnection(path, { readonly });

	if (!readonly) {
		db.exec(
			`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT);`,
		);
	}

	const stored = readMeta(db, FINGERPRINT_KEY);
	const stale = stored !== expected;

	if (!readonly && stale) {
		const outcome = policy.onStale({
			stored,
			expected,
			drop: () => {
				dropTables(db, listDerivedTables(db, [META]));
				db.exec(`DELETE FROM ${META} WHERE key = '${CURSOR_KEY}';`);
			},
		});
		if (outcome === 'refused') {
			db.close();
			throw new StaleMaterializationError(stored, expected);
		}
		if (outcome === 'rebuilt') writeMeta(db, FINGERPRINT_KEY, expected);
	}

	if (!readonly) {
		createDeclaredTables(db, declaration);
		applyIndexes(db, declaration);
	}

	return {
		fingerprint: expected,
		storedFingerprint: stored,
		stale,
		policy: policy.name,
		ingest: (records, options) => ingest(db, declaration, records, options),
		read: (table) => readTable(db, declaration, table),
		sql: <T>(query: string) => db.query<T, []>(query).all(),
		cursor: () => Number(readMeta(db, CURSOR_KEY) ?? '0'),
		setCursor: (value) => writeMeta(db, CURSOR_KEY, String(value)),
		rebuild() {
			dropTables(db, listDerivedTables(db, [META]));
			db.exec(`DELETE FROM ${META} WHERE key = '${CURSOR_KEY}';`);
			writeMeta(db, FINGERPRINT_KEY, expected);
			createDeclaredTables(db, declaration);
			applyIndexes(db, declaration);
		},
		close: () => db.close(),
	};
}

function readMeta(db: Database, key: string): string | null {
	const exists = db
		.query<{ name: string }, [string]>(
			`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
		)
		.get(META);
	if (!exists) return null;
	return (
		db
			.query<{ value: string | null }, [string]>(
				`SELECT value FROM ${META} WHERE key = ?`,
			)
			.get(key)?.value ?? null
	);
}

function writeMeta(db: Database, key: string, value: string): void {
	db.query(
		`INSERT INTO ${META} (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(key, value);
}

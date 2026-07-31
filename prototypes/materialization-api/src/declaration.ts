/**
 * The declaration both prototypes share, plus the canonical serialization and
 * digest rules from ADR-0194.
 *
 * A declaration is deterministic plain data describing the stored row shape and
 * its projections. Everything that is *not* a stored-shape fact is deliberately
 * representable here and deliberately excluded from the fingerprint, so a test
 * can prove the exclusion instead of trusting a comment: `indexes` is the live
 * example.
 */

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';

/** One projected column: a name, a SQL type, and the upstream path it reads. */
export type ColumnDeclaration = {
	name: string;
	type: ColumnType;
	path: string[];
};

export type TableDeclaration = {
	table: string;
	columns: ColumnDeclaration[];
};

export type MaterializationDeclaration = {
	/**
	 * The serialization format of this declaration itself. A change here means
	 * the stored manifest cannot be structurally compared at all, so the only
	 * honest answer is a full rebuild. This is what keeps a structured
	 * comparison from becoming a migration reader (ADR-0192 clause A).
	 */
	format: 1;
	/** Domain separation, so two families' digests can never collide. */
	domain: string;
	/** Columns every table carries, independent of its projection. */
	row: Record<string, string>;
	/** The projected tables, keyed by upstream entity name. */
	tables: Record<string, TableDeclaration>;
	/**
	 * Query optimizations. Present in the declaration because the runtime
	 * applies them, absent from the fingerprint because they hold no facts and
	 * are applied idempotently (ADR-0194).
	 */
	indexes?: Record<string, string[]>;
};

/**
 * Canonical JSON: sorted object keys, preserved array order, and an explicit
 * refusal of anything whose serialization is not deterministic. Reordering the
 * source object must not change the bytes; that is the whole point.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return 'null';

	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				throw new TypeError('A declaration cannot contain a non-finite number');
			}
			return JSON.stringify(value);
		case 'object': {
			if (Array.isArray(value)) {
				return `[${value.map(canonicalJson).join(',')}]`;
			}
			const record = value as Record<string, unknown>;
			return `{${Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
				.join(',')}}`;
		}
		default:
			throw new TypeError(
				`A declaration cannot contain a ${typeof value} value`,
			);
	}
}

/** Domain-separated SHA-256 over the canonical serialization. */
export function digest(domain: string, value: unknown): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(`${domain}\0${canonicalJson(value)}`);
	return hasher.digest('hex');
}

/**
 * The rebuild-relevant projection of a declaration. Indexes are stripped here
 * rather than at each call site so "an index is not a rebuild input" is one
 * fact in one place, testable on its own.
 */
export function rebuildRelevant(declaration: MaterializationDeclaration): Json {
	return {
		format: declaration.format,
		domain: declaration.domain,
		row: declaration.row,
		tables: declaration.tables as unknown as Json,
	};
}

/** The digest of a whole declaration: the fast path both prototypes share. */
export function wholeDigest(declaration: MaterializationDeclaration): string {
	return digest(
		`${declaration.domain}/decl@${declaration.format}`,
		rebuildRelevant(declaration),
	);
}

/** The digest of one table's rebuild-relevant shape. */
export function tableDigest(
	declaration: MaterializationDeclaration,
	name: string,
	table: TableDeclaration,
): string {
	return digest(`${declaration.domain}/table@${declaration.format}`, {
		name,
		row: declaration.row,
		table: table as unknown as Json,
	});
}

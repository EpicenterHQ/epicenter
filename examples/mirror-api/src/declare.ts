/**
 * Declaration layer: pure plain data describing a mirror's stored shape.
 *
 * Nothing here touches a filesystem, a database, or a network. A declaration is
 * importable by a reader process, a writer process, a CLI that only wants to
 * print the fingerprint, and a test. That portability is the whole reason
 * defining and opening are separate operations.
 */

import { computeFingerprint, rebuildRelevant } from './fingerprint.ts';

/** SQL storage classes a mirror column may use. `json` is stored as TEXT. */
export type ColumnType = 'text' | 'integer' | 'real' | 'json';

/**
 * A property path into an authority object. Plain data, so it is a fingerprint
 * input: changing where a column reads from forces a rebuild.
 */
export type PathRef = { readonly $path: readonly string[] };

export function path(...segments: string[]): PathRef {
	return { $path: segments };
}

export function isPathRef(value: unknown): value is PathRef {
	return typeof value === 'object' && value !== null && '$path' in value;
}

/**
 * How a value is pulled out of an authority object. A {@link PathRef} is data
 * and is fingerprinted. A function is opaque: it is *not* fingerprinted, and
 * the declaration reports it in {@link MirrorDeclaration.unfingerprintedPaths}.
 */
export type Extractor<TObject, TValue> =
	| PathRef
	| ((object: TObject) => TValue);

export type SourceColumn<TObject> = {
	readonly type: ColumnType;
	readonly from: Extractor<TObject, unknown>;
	/** Ingest-time contract only. Every payload column is SQL-nullable because a
	 * tombstone row has no payload. */
	readonly nullable?: boolean;
};

/**
 * Whether the authority's version values sort as strings (ISO timestamps, ULIDs)
 * or as numbers (Gmail `historyId`, Stripe sequence). This picks the physical
 * column type, so it is a fingerprint input.
 */
export type VersionOrder = 'lexical' | 'numeric';

/**
 * What a rebuild costs, declared per table.
 *
 * - `raw` keeps the authority object beside the projected columns, so a
 *   declaration change is reprojected locally: no network, no lost cursor, no
 *   lost backfill latch. It costs disk.
 * - `projected` keeps only the declared columns, so a declaration change can
 *   only be answered by pulling the authority again. It costs a full re-pull.
 *
 * This is the one real rebuild knob. The *gate* is not declarable (ADR-0194
 * settled that); the *recovery* is, and it is the difference between a shape
 * change being free and being a network event.
 */
export type Retention = 'raw' | 'projected';

/** A table whose rows are authority objects. */
export type SourceTable<TObject> = {
	readonly kind: 'source';
	readonly key: Extractor<TObject, string>;
	/** Defaults to `raw`: a cheap rebuild is worth more than compact storage for
	 * a cache that would otherwise re-download its whole history. */
	readonly retain?: Retention;
	readonly version: {
		readonly from: Extractor<TObject, string | number>;
		readonly order: VersionOrder;
	};
	/** Truthy means the authority reported this object deleted. */
	readonly tombstone?: Extractor<TObject, unknown>;
	readonly columns: Readonly<Record<string, SourceColumn<TObject>>>;
	/** Query optimizations. Applied idempotently and never fingerprinted. */
	readonly indexes?: readonly (readonly string[])[];
};

export type DerivedColumn =
	| ColumnType
	| { readonly type: ColumnType; readonly nullable?: boolean };

/**
 * A table whose rows are owned by a row in `of`. The entire derived set for one
 * source row is replaced whenever that source row advances, so a derived row can
 * never outlive the source version that emitted it.
 */
export type DerivedTable<TOf extends string = string> = {
	readonly kind: 'derived';
	readonly of: TOf;
	/** Column identifying the row within its source. Unique per source row. */
	readonly key: string;
	readonly columns: Readonly<Record<string, DerivedColumn>>;
	readonly indexes?: readonly (readonly string[])[];
};

export type AnyTable = SourceTable<never> | DerivedTable;
export type TableMap = Readonly<Record<string, AnyTable>>;

export function table<TObject>(
	decl: Omit<SourceTable<TObject>, 'kind'>,
): SourceTable<TObject> {
	return { kind: 'source', ...decl };
}

export function derived<const TDecl extends Omit<DerivedTable, 'kind'>>(
	decl: TDecl,
): TDecl & { readonly kind: 'derived' } {
	return { kind: 'derived', ...decl };
}

// --- type-level plumbing ----------------------------------------------------

export type SourceKeys<TTables extends TableMap> = {
	[K in keyof TTables]: TTables[K] extends { kind: 'source' } ? K : never;
}[keyof TTables] &
	string;

export type ObjectOf<TTable> =
	TTable extends SourceTable<infer TObject> ? TObject : never;

type JsValue<TType extends ColumnType> = TType extends 'text'
	? string
	: TType extends 'integer' | 'real'
		? number
		: unknown;

type DerivedValue<TColumn> = TColumn extends ColumnType
	? JsValue<TColumn>
	: TColumn extends { type: infer TType extends ColumnType; nullable: true }
		? JsValue<TType> | null
		: TColumn extends { type: infer TType extends ColumnType }
			? JsValue<TType>
			: never;

export type DerivedRow<TTable> = TTable extends { columns: infer TColumns }
	? { [K in keyof TColumns]: DerivedValue<TColumns[K]> }
	: never;

/** The emit handle handed to one source table's derive function: exactly the
 * derived tables that declared `of: <that source>`, and nothing else. */
export type Emit<TTables extends TableMap, TSource extends string> = {
	[K in keyof TTables as TTables[K] extends { kind: 'derived'; of: infer TOf }
		? TOf extends TSource
			? K
			: never
		: never]: (row: DerivedRow<TTables[K]>) => void;
};

export type DeriveMap<TTables extends TableMap> = {
	readonly [S in SourceKeys<TTables>]?: (
		object: ObjectOf<TTables[S]>,
		emit: Emit<TTables, S>,
	) => void;
};

export type MirrorSpec<TTables extends TableMap> = {
	/** Human label. Deliberately *not* a fingerprint input: renaming a mirror
	 * changes no stored bytes. */
	readonly name: string;
	readonly tables: TTables;
	readonly derive?: DeriveMap<TTables>;
};

export type MirrorDeclaration<TTables extends TableMap = TableMap> =
	MirrorSpec<TTables> & {
		/** `sha256:<hex>` over the canonical rebuild-relevant declaration. */
		readonly fingerprint: string;
		/**
		 * Declaration paths whose behavior the fingerprint cannot see, because
		 * they are functions rather than data. A host may use this to decide a
		 * stricter dev-time rebuild policy. Empty means the gate is total.
		 */
		readonly unfingerprintedPaths: readonly string[];
	};

export class MirrorDeclarationError extends Error {
	override readonly name = 'MirrorDeclarationError';
}

export function defineMirror<TTables extends TableMap>(
	spec: MirrorSpec<TTables>,
): MirrorDeclaration<TTables> {
	validate(spec);
	return {
		...spec,
		fingerprint: computeFingerprint(rebuildRelevant(spec)),
		unfingerprintedPaths: collectUnfingerprinted(spec),
	};
}

const RESERVED_PREFIX = '_';

function validate(spec: MirrorSpec<TableMap>): void {
	const fail = (message: string): never => {
		throw new MirrorDeclarationError(message);
	};
	if (Object.keys(spec.tables).length === 0)
		fail('a mirror declares no tables');

	for (const [tableKey, decl] of Object.entries(spec.tables)) {
		if (tableKey.startsWith(RESERVED_PREFIX)) {
			fail(`table "${tableKey}" uses the reserved "_" prefix`);
		}
		const columnKeys = Object.keys(decl.columns);
		if (columnKeys.length === 0)
			fail(`table "${tableKey}" declares no columns`);
		for (const column of columnKeys) {
			if (column.startsWith(RESERVED_PREFIX)) {
				fail(`column "${tableKey}.${column}" uses the reserved "_" prefix`);
			}
		}
		if (decl.kind === 'derived') {
			if (!(decl.of in spec.tables)) {
				fail(`derived table "${tableKey}" names unknown source "${decl.of}"`);
			}
			if (spec.tables[decl.of]?.kind !== 'source') {
				fail(`derived table "${tableKey}" may not derive from a derived table`);
			}
			if (!columnKeys.includes(decl.key)) {
				fail(`derived table "${tableKey}" key "${decl.key}" is not a column`);
			}
		}
		for (const index of decl.indexes ?? []) {
			for (const column of index) {
				if (!columnKeys.includes(column)) {
					fail(`index on "${tableKey}" names unknown column "${column}"`);
				}
			}
		}
	}

	for (const source of Object.keys(spec.derive ?? {})) {
		if (spec.tables[source]?.kind !== 'source') {
			fail(`derive names "${source}", which is not a source table`);
		}
	}
	for (const [tableKey, decl] of Object.entries(spec.tables)) {
		if (decl.kind !== 'derived') continue;
		if (!(decl.of in (spec.derive ?? {}))) {
			fail(
				`derived table "${tableKey}" has no derive function for source "${decl.of}"`,
			);
		}
	}
}

function collectUnfingerprinted(spec: MirrorSpec<TableMap>): readonly string[] {
	const paths: string[] = [];
	for (const [tableKey, decl] of Object.entries(spec.tables)) {
		if (decl.kind !== 'source') continue;
		if (typeof decl.key === 'function') paths.push(`tables.${tableKey}.key`);
		if (typeof decl.version.from === 'function') {
			paths.push(`tables.${tableKey}.version.from`);
		}
		if (typeof decl.tombstone === 'function') {
			paths.push(`tables.${tableKey}.tombstone`);
		}
		for (const [column, columnDecl] of Object.entries(decl.columns)) {
			if (typeof columnDecl.from === 'function') {
				paths.push(`tables.${tableKey}.columns.${column}.from`);
			}
		}
	}
	for (const source of Object.keys(spec.derive ?? {})) {
		paths.push(`derive.${source}`);
	}
	return paths.sort();
}

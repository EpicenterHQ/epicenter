/**
 * The rebuild gate (ADR-0194): a mirror rebuilds when the SHA-256 of its
 * canonical rebuild-relevant declaration changes.
 *
 * Two responsibilities live here and they are deliberately separate:
 *
 * 1. `rebuildRelevant` decides *what counts*. It is the honest boundary of the
 *    gate: stored shape and projection structure in, indexes and names out.
 * 2. `canonicalize` decides *how it is spelled*. Sorted keys, ordered arrays,
 *    explicit rejection of anything whose JSON spelling is not stable.
 */

import type { MirrorSpec, TableMap } from './declare.ts';

/** Domain + format tag, hashed as a prefix so a bare JSON digest from some
 * other subsystem can never collide with a mirror fingerprint. */
const DOMAIN_TAG = 'epicenter.mirror.declaration/v1\n';

/** Marker standing in for a function extractor. The gate can see *that* a
 * mapping is opaque, never *what* it computes (ADR-0194 rejects hashing
 * function source). */
const OPAQUE = { $opaque: 'fn' } as const;

export type Canonical =
	| string
	| number
	| boolean
	| null
	| readonly Canonical[]
	| { readonly [key: string]: Canonical };

export class CanonicalizationError extends Error {
	override readonly name = 'CanonicalizationError';
}

/**
 * Reduce a declaration to exactly the facts that control stored bytes.
 *
 * Excluded on purpose: `name` (a label, not a shape), `indexes` (query
 * optimizations, re-applied idempotently), and function bodies (formatting and
 * bundling are not shape changes).
 */
export function rebuildRelevant(spec: MirrorSpec<TableMap>): Canonical {
	const tables: Record<string, Canonical> = {};
	for (const [tableKey, decl] of Object.entries(spec.tables)) {
		if (decl.kind === 'source') {
			const columns: Record<string, Canonical> = {};
			for (const [column, columnDecl] of Object.entries(decl.columns)) {
				columns[column] = {
					type: columnDecl.type,
					nullable: columnDecl.nullable === true,
					from: extractorShape(columnDecl.from),
				};
			}
			tables[tableKey] = {
				kind: 'source',
				// Retention decides whether `_raw` is a stored column, so it is shape.
				retain: decl.retain ?? 'raw',
				key: extractorShape(decl.key),
				version: {
					from: extractorShape(decl.version.from),
					order: decl.version.order,
				},
				tombstone:
					decl.tombstone === undefined ? null : extractorShape(decl.tombstone),
				columns,
			};
			continue;
		}
		const columns: Record<string, Canonical> = {};
		for (const [column, columnDecl] of Object.entries(decl.columns)) {
			const normalized =
				typeof columnDecl === 'string'
					? { type: columnDecl, nullable: false }
					: { type: columnDecl.type, nullable: columnDecl.nullable === true };
			columns[column] = normalized;
		}
		tables[tableKey] = {
			kind: 'derived',
			of: decl.of,
			key: decl.key,
			columns,
		};
	}
	return {
		tables,
		// The *set* of imperatively derived sources is shape; the bodies are not.
		derives: Object.keys(spec.derive ?? {}).sort(),
	};
}

function extractorShape(extractor: unknown): Canonical {
	if (typeof extractor === 'function') return OPAQUE;
	if (
		typeof extractor === 'object' &&
		extractor !== null &&
		'$path' in extractor
	) {
		const segments = (extractor as { $path: unknown }).$path;
		if (
			!Array.isArray(segments) ||
			segments.some((s) => typeof s !== 'string')
		) {
			throw new CanonicalizationError('a path must be an array of strings');
		}
		return { $path: segments as string[] };
	}
	throw new CanonicalizationError(
		'an extractor must be a path() or a function',
	);
}

/**
 * Deterministic serialization. Object keys sort; array order is preserved
 * because it is meaning; anything whose spelling is not stable is rejected
 * rather than coerced.
 */
export function canonicalize(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new CanonicalizationError(`non-finite number: ${String(value)}`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(',')}]`;
	}
	if (typeof value === 'object') {
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw new CanonicalizationError(
				'only plain objects may be fingerprinted',
			);
		}
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		const parts = entries.map(([key, entry]) => {
			if (entry === undefined) {
				throw new CanonicalizationError(`undefined value at key "${key}"`);
			}
			return `${JSON.stringify(key)}:${canonicalize(entry)}`;
		});
		return `{${parts.join(',')}}`;
	}
	throw new CanonicalizationError(`unsupported value of type ${typeof value}`);
}

export function computeFingerprint(value: Canonical): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(DOMAIN_TAG);
	hasher.update(canonicalize(value));
	return `sha256:${hasher.digest('hex')}`;
}

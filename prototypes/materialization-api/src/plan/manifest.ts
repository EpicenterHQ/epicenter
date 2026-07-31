/**
 * Prototype B's rebuild gate: a structured manifest and the plan produced by
 * comparing one against a declaration.
 *
 * A hash is a diff you already computed and threw away. Building the canonical
 * serialization is the expensive half; storing it costs kilobytes and buys
 * per-table granularity, a legible reason, and a comparison that is a pure
 * function of two values and needs no disk to test.
 *
 * The refusal that keeps this from becoming a migration reader (ADR-0192 clause
 * A): the comparison is **shape-blind**. It reports that the value at some
 * canonical path differs. It never knows what a column means, and it never
 * reads an older declaration *format* — a format change disables comparison
 * entirely and the answer is a full rebuild.
 */

import type { Json, MaterializationDeclaration } from '../declaration.ts';
import {
	canonicalJson,
	rebuildRelevant,
	tableDigest,
	wholeDigest,
} from '../declaration.ts';

export type Manifest = {
	format: number;
	domain: string;
	/** Digest of the whole rebuild-relevant declaration: the equality fast path. */
	whole: string;
	/** Per-table digests: which table moved, without interpreting anything. */
	parts: Record<string, string>;
	/**
	 * The canonical rebuild-relevant declaration, stored so a change can be
	 * *described*. Only ever compared as a tree, never interpreted.
	 */
	declaration: Json;
	/**
	 * The upstream principal this store holds. Deliberately *not* a fingerprint
	 * input (ADR-0194 is right that a fingerprint is a declaration identity),
	 * and deliberately stored, because otherwise nothing at all carries it and
	 * a restored or misfiled store opens as current.
	 */
	authority: string;
};

export type PartChange =
	| { kind: 'added'; table: string }
	| { kind: 'removed'; table: string }
	| { kind: 'changed'; table: string; paths: string[] };

export type RebuildPlan = {
	reason: 'absent' | 'format-change' | 'declaration-changed';
	/** Physical table names to drop. */
	dropTables: string[];
	/**
	 * Whether the realm cursor must be cleared. False for an ordinary
	 * declaration change: ADR-0064 makes table existence the per-entity init
	 * latch, so a dropped table backfills itself on the next pass while every
	 * other table stays incremental. Clearing the cursor is only honest when
	 * the comparison itself was impossible.
	 */
	clearCursor: boolean;
	changes: PartChange[];
	nextManifest: Manifest;
	describe(): string;
};

export type MaterializationState =
	| { kind: 'absent'; plan: RebuildPlan }
	| { kind: 'current'; manifest: Manifest }
	| { kind: 'stale'; manifest: Manifest; plan: RebuildPlan }
	| { kind: 'foreign'; manifest: Manifest; expectedAuthority: string };

export function buildManifest(
	declaration: MaterializationDeclaration,
	authority: string,
): Manifest {
	return {
		format: declaration.format,
		domain: declaration.domain,
		whole: wholeDigest(declaration),
		parts: Object.fromEntries(
			Object.entries(declaration.tables).map(([name, table]) => [
				name,
				tableDigest(declaration, name, table),
			]),
		),
		declaration: rebuildRelevant(declaration),
		authority,
	};
}

/** Generic tree comparison over canonical JSON. Knows nothing about tables. */
function differingPaths(
	before: Json,
	after: Json,
	prefix: string[] = [],
): string[] {
	if (canonicalJson(before) === canonicalJson(after)) return [];
	const bothPlainObjects =
		before !== null &&
		after !== null &&
		typeof before === 'object' &&
		typeof after === 'object' &&
		!Array.isArray(before) &&
		!Array.isArray(after);
	if (!bothPlainObjects) return [prefix.join('.') || '.'];

	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys]
		.sort()
		.flatMap((key) =>
			differingPaths(
				(before as { [k: string]: Json })[key] ?? null,
				(after as { [k: string]: Json })[key] ?? null,
				[...prefix, key],
			),
		);
}

function tableOf(
	declaration: MaterializationDeclaration,
	name: string,
): string | undefined {
	return declaration.tables[name]?.table;
}

function storedTableName(manifest: Manifest, name: string): string | undefined {
	const declared = manifest.declaration;
	if (
		declared === null ||
		typeof declared !== 'object' ||
		Array.isArray(declared)
	)
		return undefined;
	const tables = (declared as { [k: string]: Json })['tables'];
	if (
		tables === null ||
		tables === undefined ||
		typeof tables !== 'object' ||
		Array.isArray(tables)
	) {
		return undefined;
	}
	const table = (tables as { [k: string]: Json })[name];
	if (
		table === null ||
		table === undefined ||
		typeof table !== 'object' ||
		Array.isArray(table)
	) {
		return undefined;
	}
	const physical = (table as { [k: string]: Json })['table'];
	return typeof physical === 'string' ? physical : undefined;
}

function describePlan(plan: Omit<RebuildPlan, 'describe'>): string {
	if (plan.changes.length === 0) {
		return `${plan.reason}: rebuild ${plan.dropTables.length} table(s)`;
	}
	const parts = plan.changes.map((change) =>
		change.kind === 'changed'
			? `${change.table} changed at ${change.paths.join(', ')}`
			: `${change.table} ${change.kind}`,
	);
	return `${plan.reason}: ${parts.join('; ')}${plan.clearCursor ? ' (cursor cleared)' : ' (cursor kept)'}`;
}

function plan(fields: Omit<RebuildPlan, 'describe'>): RebuildPlan {
	return { ...fields, describe: () => describePlan(fields) };
}

/**
 * Compare a declaration against a stored manifest. Pure: no disk, no
 * connection, no side effect. This is what makes "would this release rebuild my
 * store, and why" answerable in a unit test and in a `--dry-run`.
 */
export function comparePlan(
	declaration: MaterializationDeclaration,
	authority: string,
	stored: Manifest | null,
): MaterializationState {
	const nextManifest = buildManifest(declaration, authority);
	const allTables = Object.values(declaration.tables).map(
		(table) => table.table,
	);

	if (stored === null) {
		return {
			kind: 'absent',
			plan: plan({
				reason: 'absent',
				dropTables: [],
				clearCursor: true,
				changes: Object.keys(declaration.tables).map((table) => ({
					kind: 'added',
					table,
				})),
				nextManifest,
			}),
		};
	}

	if (stored.authority !== authority) {
		return { kind: 'foreign', manifest: stored, expectedAuthority: authority };
	}

	if (
		stored.format !== declaration.format ||
		stored.domain !== declaration.domain
	) {
		return {
			kind: 'stale',
			manifest: stored,
			plan: plan({
				reason: 'format-change',
				dropTables: allTables,
				clearCursor: true,
				changes: [],
				nextManifest,
			}),
		};
	}

	if (stored.whole === nextManifest.whole)
		return { kind: 'current', manifest: stored };

	const names = new Set([
		...Object.keys(stored.parts),
		...Object.keys(nextManifest.parts),
	]);
	const changes: PartChange[] = [];
	const dropTables: string[] = [];

	for (const name of [...names].sort()) {
		const before = stored.parts[name];
		const after = nextManifest.parts[name];
		if (before === after) continue;
		if (before === undefined) {
			changes.push({ kind: 'added', table: name });
			continue;
		}
		if (after === undefined) {
			changes.push({ kind: 'removed', table: name });
			const physical = storedTableName(stored, name);
			if (physical !== undefined) dropTables.push(physical);
			continue;
		}
		changes.push({
			kind: 'changed',
			table: name,
			paths: differingPaths(
				readTableNode(stored.declaration, name),
				readTableNode(nextManifest.declaration, name),
			),
		});
		const physical =
			tableOf(declaration, name) ?? storedTableName(stored, name);
		if (physical !== undefined) dropTables.push(physical);
	}

	// A change to the shared row shape needs no separate branch: every table's
	// digest folds `row` in, so it already surfaces as every table changing.
	return {
		kind: 'stale',
		manifest: stored,
		plan: plan({
			reason: 'declaration-changed',
			dropTables,
			clearCursor: false,
			changes,
			nextManifest,
		}),
	};
}

function readNode(declaration: Json, key: string): Json {
	if (
		declaration === null ||
		typeof declaration !== 'object' ||
		Array.isArray(declaration)
	)
		return null;
	return (declaration as { [k: string]: Json })[key] ?? null;
}

function readTableNode(declaration: Json, name: string): Json {
	return readNode(readNode(declaration, 'tables'), name);
}

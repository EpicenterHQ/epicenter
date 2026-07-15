/**
 * The construction-time referential floor.
 *
 * `field.reference<T>(table)` declares that a column points at another table by carrying
 * the target table name in its at-rest schema (the `x-ref` marker the `@epicenter/field`
 * palette recognizes as kind `reference`). This module enforces the one guarantee that
 * turns that declaration into integrity at workspace construction: every reference target
 * must name a table defined in the SAME workspace. A typo (`field.reference('foldrs')`) or
 * a reference to a table that was never declared fails HERE, when the workspace is built,
 * instead of silently at query time.
 *
 * This is SCHEMA-level integrity: the target resolves to a real table. ROW-level
 * integrity (a stored value resolves to a real row id) needs the live data and is a
 * separate validator, not this construction-time check.
 */

import { REFERENCE_KEYWORD, recognize } from '@epicenter/field';
import type { TSchema } from 'typebox';
import type { TableDefinitions } from './table.js';

/**
 * The at-rest JSON of a live TypeBox schema. A live schema carries a non-enumerable
 * `~kind` tag the closed metas reject; JSON serialization drops it, so this is the shape
 * `recognize` actually classifies (and the shape stored on disk / in Yjs).
 */
function atRest(schema: TSchema): unknown {
	return JSON.parse(JSON.stringify(schema));
}

/**
 * The reference target a column names, or `null` when the column is not a reference. Sees
 * through `nullable(...)` (a `{anyOf:[inner, {type:'null'}]}` wrapper) by recognizing its
 * single non-null branch, mirroring how the SQLite materializer unwraps the same shape.
 */
function referenceTarget(schema: TSchema): string | null {
	const rest = atRest(schema) as { anyOf?: { type?: unknown }[] };
	const candidate = Array.isArray(rest.anyOf)
		? (rest.anyOf.find((branch) => branch.type !== 'null') ?? rest)
		: rest;
	const recognized = recognize(candidate);
	if (recognized?.kind !== 'reference') return null;
	return (recognized.schema as Record<string, unknown>)[
		REFERENCE_KEYWORD
	] as string;
}

/**
 * Assert every `field.reference(table)` column names a table defined in this workspace.
 * Throws on a dangling target. Called once at workspace construction (`createWorkspace`),
 * so a bad target is a build-time failure for every runtime (browser, Bun, tests) that
 * instantiates the workspace, not a silent mistake surfaced at query time.
 *
 * A no-op for every existing app: only columns authored with `field.reference()` carry the
 * marker, so a plain `field.string<FolderId>()` (a brand, not a reference) is skipped.
 */
export function assertReferenceTargets(tables: TableDefinitions): void {
	const tableNames = new Set(Object.keys(tables));
	for (const [tableName, definition] of Object.entries(tables)) {
		const properties = definition.schema.properties as Record<string, TSchema>;
		for (const [column, schema] of Object.entries(properties)) {
			const target = referenceTarget(schema);
			if (target === null) continue;
			if (!tableNames.has(target)) {
				throw new Error(
					`Table "${tableName}" column "${column}" references table "${target}", which is not defined in this workspace. Defined tables: ${[...tableNames].join(', ')}.`,
				);
			}
		}
	}
}

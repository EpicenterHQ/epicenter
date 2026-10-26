/** Pure view transforms and section-preserving schema installation. */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	parseDeclarationObject,
	readDeclaredTables,
	readTableSchemas,
} from './declaration.js';
import { type SavedView, savedViewProblem } from './declaration-schema.js';
import { hashBytes } from './hash.js';
import { parseJsonObject } from './json-object.js';
import { DEFINITION_PATH } from './paths.js';
import { confirmedPut, WRITE_ATTEMPTS } from './write.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Re-read and reapply the section change on every stale publication. A JSON
 * line merge cannot preserve independent changes on a shared one-line source.
 * Unrequested section values remain opaque and are carried through intact.
 */
export async function patchDeclaration(
	storage: Pick<FolderStorage, 'read' | 'put'>,
	change: (
		current: Record<string, unknown>,
	) => Result<Record<string, unknown>, { reason: string }>,
): Promise<Result<{ written: boolean }, { reason: string }>> {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await storage.read(DEFINITION_PATH);
		if (read.error !== null && read.error.name !== 'NotFound')
			return Err({ reason: read.error.message });
		let current: Record<string, unknown> = {};
		if (read.error === null) {
			let text: string;
			try {
				text = utf8.decode(read.data.bytes);
			} catch {
				return Err({ reason: `${DEFINITION_PATH} is not UTF-8 text` });
			}
			const parsed = parseDeclarationObject(text);
			if (parsed.error !== null) return parsed;
			current = parsed.data;
		}
		const before = JSON.stringify(current);
		const changed = change(current);
		if (changed.error !== null) return changed;
		if (before === JSON.stringify(changed.data)) return Ok({ written: false });
		const bytes = new TextEncoder().encode(
			`${JSON.stringify(changed.data, null, 2)}\n`,
		);
		const put = await confirmedPut(
			storage,
			DEFINITION_PATH,
			bytes,
			read.data === null ? 'absent' : { sha256: read.data.sha256 },
			await hashBytes(bytes),
		);
		if (put.error !== null) return Err({ reason: put.error.message });
		if (put.data?.kind === 'landed') return Ok({ written: true });
	}
	return Err({
		reason: `${DEFINITION_PATH} kept changing; no replacement was confirmed. Try again`,
	});
}

/** One named view assignment in the current declaration source. */
export type SavedViewChange = {
	key: string;
	value: SavedView | undefined;
};

/**
 * Compose a named view into the current source. This function performs no I/O;
 * its caller replaces and saves the same file editor that supplied the source.
 * Unrelated JSON entries, including unsupported views, remain opaque.
 */
export function changeSavedView(
	text: string,
	{ key, value }: SavedViewChange,
): Result<string, { reason: string }> {
	if (typeof key !== 'string' || key === '')
		return Err({ reason: 'A saved view needs a name' });
	if (value !== undefined) {
		const problem = savedViewProblem(value);
		if (problem !== undefined) return Err({ reason: problem });
	}
	const parsed = parseJsonObject(text);
	if (parsed.error !== null) return parsed;
	const current = parsed.data;
	if (Object.hasOwn(current, 'views') && !isObject(current.views))
		return Err({
			reason: "The 'views' section is not an object; repair it in Files",
		});
	const views = (current.views ?? {}) as Record<string, unknown>;
	if (value === undefined && !Object.hasOwn(views, key)) return Ok(text);
	const next = { ...views, [key]: value };
	if (value === undefined) delete next[key];
	return Ok(`${JSON.stringify({ ...current, views: next }, null, 2)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read only the table section; unrelated view configuration stays opaque. */
export function parseTableSchemas(text: string) {
	const source = readDeclaredTables(text);
	if (source.error !== null) return source;
	if (source.data === undefined)
		return Err({ reason: "The schema document has no 'tables'" });
	return Ok({ tables: source.data });
}

/** Install all source tables; conflicting definitions require an explicit choice. */
export async function importTables(
	storage: Pick<FolderStorage, 'read' | 'put'>,
	text: string,
	{ replace = false }: { replace?: boolean } = {},
) {
	const incoming = parseTableSchemas(text);
	if (incoming.error !== null) return incoming;
	return patchDeclaration(storage, (current) => {
		const existing = current.tables;
		if (
			existing !== undefined &&
			(typeof existing !== 'object' ||
				existing === null ||
				Array.isArray(existing))
		)
			return Err({
				reason:
					"The existing 'tables' section is not an object; repair it before importing",
			});
		const tables = { ...(existing as Record<string, unknown> | undefined) };
		const names = new Map<string, string>();
		for (const name of Object.keys(tables)) {
			const folded = name.toLowerCase();
			const previous = names.get(folded);
			if (previous !== undefined)
				return Err({
					reason: `Existing table names '${previous}' and '${name}' collide case-insensitively; repair them before importing`,
				});
			names.set(folded, name);
		}
		for (const [name, schema] of Object.entries(incoming.data.tables)) {
			const previous = names.get(name.toLowerCase());
			if (previous !== undefined && previous !== name)
				return Err({
					reason: `Table '${name}' collides case-insensitively with existing table '${previous}'; use the same table name before importing`,
				});
			if (
				Object.hasOwn(tables, name) &&
				!sameJson(tables[name], schema) &&
				!replace
			)
				return Err({
					reason: `Table '${name}' already has a different schema; use --replace to replace this table`,
				});
			tables[name] = schema;
			names.set(name.toLowerCase(), name);
		}
		return Ok({ ...current, tables });
	});
}

/** Generation owns tables and title; unrelated saved sections survive. */
export function writeGeneratedDeclaration(
	storage: Pick<FolderStorage, 'read' | 'put'>,
	text: string,
) {
	const generated = parseDeclarationObject(text);
	if (generated.error !== null) return Promise.resolve(generated);
	const tables = readTableSchemas(generated.data.tables);
	if (tables.error !== null) return Promise.resolve(tables);
	if (tables.data === undefined)
		return Promise.resolve(
			Err({ reason: "Generated declaration has no 'tables'" }),
		);
	const replacement = {
		...(generated.data.title === undefined
			? {}
			: { title: generated.data.title }),
		tables: tables.data,
	};
	return patchDeclaration(storage, (current) => {
		const next = { ...current };
		if (generated.data.title === undefined) delete next.title;
		return Ok({ ...next, ...replacement });
	});
}

/** JSON object key order does not make an otherwise identical schema conflict. */
function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (
		typeof left !== 'object' ||
		left === null ||
		typeof right !== 'object' ||
		right === null
	)
		return false;
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => sameJson(value, right[index]))
		);
	const entries = Object.entries(left);
	return (
		entries.length === Object.keys(right).length &&
		entries.every(
			([key, value]) =>
				Object.hasOwn(right, key) &&
				sameJson(value, (right as Record<string, unknown>)[key]),
		)
	);
}

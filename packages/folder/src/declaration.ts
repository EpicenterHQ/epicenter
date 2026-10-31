/**
 * `epicenter.json`: a folder's definition as JSON Schema (ADR-0517).
 *
 * The CLI's `query` reads the root file's tables (ADR-0632). A person or a
 * schema distribution installs it; opening a `Folder` neither reads nor
 * writes it. The portable file has independently optional `tables` and
 * `views`; `query` still requires declared tables. An app's contract
 * replaces it (decision 35): `epicenter check` and `format` take the
 * contract instead.
 *
 * Each table is a complete object schema. Readers retain its root `$defs`,
 * annotations, and constraints and validate each record against that root.
 * `required` is the portable optionality marker. Applications supply their
 * own runtime schemas; reading this file never admits or refuses an app.
 *
 * A top-level `$schema` lets an editor offer completion and is not
 * interpreted. Unknown envelope keys are refused, so a misspelled key never reads as
 * an empty definition.
 */

import { isTableName } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	DECLARATION_KEYS,
	type Declaration,
	declarationProblem,
	prepareTableSchemas,
	type SavedView,
	savedViewProblem,
} from './declaration-schema.js';
import { parseJsonObject } from './json-object.js';

const TOP_LEVEL_KEYS = DECLARATION_KEYS;

/** Read known envelope keys without interpreting another section's contents. */
export function parseDeclarationObject(
	text: string,
): Result<Record<string, unknown>, { reason: string }> {
	const { data: value, error } = parseJsonObject(text);
	if (error !== null) return Err(error);
	return checkEnvelope(value);
}

function checkEnvelope(
	value: Record<string, unknown>,
): Result<Record<string, unknown>, { reason: string }> {
	const unknown = Object.keys(value).filter(
		(key) => !TOP_LEVEL_KEYS.includes(key),
	);
	if (unknown.length > 0)
		return Err({
			reason: `unknown top-level key ${unknown.map((key) => `'${key}'`).join(', ')}; expected ${TOP_LEVEL_KEYS.join(', ')}`,
		});
	return Ok(value);
}

/** Read a portable document without changing or flattening its table schemas. */
export function parseDeclaration(
	text: string,
): Result<Declaration, { reason: string }> {
	const { data: value, error } = parseDeclarationObject(text);
	if (error !== null) return Err(error);
	const { tables: rawTables, ...metadata } = value;
	const problem = declarationProblem(metadata);
	if (problem !== undefined) return Err({ reason: problem });
	const tables = readTableSchemas(rawTables);
	if (tables.error !== null) return tables;
	return Ok({
		...metadata,
		...(tables.data === undefined ? {} : { tables: tables.data }),
	} as Declaration);
}

/** Read valid siblings and retain a visible diagnosis for every unsupported or invalid entry. */
export function readSavedViews(text: string): Result<
	{
		views: Record<string, SavedView>;
		diagnostics: {
			key: string;
			kind: 'invalid' | 'unsupported';
			reason: string;
		}[];
	},
	{ reason: string }
> {
	const parsed = parseJsonObject(text);
	if (parsed.error !== null) return parsed;
	const section = parsed.data.views;
	if (section !== undefined && !isObject(section))
		return Err({
			reason: "The 'views' section is not an object; repair it in Files",
		});
	const views: Record<string, SavedView> = Object.create(null);
	const diagnostics: {
		key: string;
		kind: 'invalid' | 'unsupported';
		reason: string;
	}[] = [];
	for (const [key, value] of Object.entries(section ?? {})) {
		if (
			isObject(value) &&
			typeof value.type === 'string' &&
			!['grid', 'board', 'sql'].includes(value.type)
		) {
			diagnostics.push({
				key,
				kind: 'unsupported',
				reason: `View type '${value.type}' is not supported by this version`,
			});
			continue;
		}
		const problem =
			key === '' ? 'A saved view needs a name' : savedViewProblem(value);
		if (problem !== undefined)
			diagnostics.push({ key, kind: 'invalid', reason: problem });
		else views[key] = value as SavedView;
	}
	return Ok({ views, diagnostics });
}

/** Read only table declarations; unrelated view problems stay with their readers. */
export function readDeclaredTables(
	text: string,
): Result<Declaration['tables'], { reason: string }> {
	const { data: value, error } = parseDeclarationObject(text);
	if (error !== null) return Err(error);
	return readTableSchemas(value.tables);
}

/** Prepare only an already-read table section, without serializing or parsing it again. */
export function readTableSchemas(
	value: unknown,
): Result<Declaration['tables'], { reason: string }> {
	if (value === undefined) return Ok(undefined);
	const prepared = prepareTableSchemas(value);
	if (prepared.error !== null) return prepared;
	const folded = new Set<string>();
	for (const name of Object.keys(prepared.data)) {
		if (!isTableName(name))
			return Err({ reason: `table name '${name}' is not usable` });
		if (folded.has(name.toLowerCase()))
			return Err({
				reason: `table names collide case-insensitively: '${name}'`,
			});
		folded.add(name.toLowerCase());
	}
	return prepared;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

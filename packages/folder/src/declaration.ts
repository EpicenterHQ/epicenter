/**
 * `epicenter.json`: a folder's definition as JSON Schema (ADR-0517).
 *
 * The CLI's `check` and `query` read the root file's tables (ADR-0632). A
 * person or a schema distribution installs it; opening a `Folder` neither
 * reads nor writes it. The older `epicenter generate` still writes it from a
 * folder's `epicenter.ts` (ADR-0527) until its callers migrate. The portable file has independently optional `tables` and `views`; the CLI
 * checking commands still require declared tables.
 *
 * Each table is a complete object schema. Readers retain its root `$defs`,
 * annotations, and constraints and validate each record against that root.
 * `required` is the portable optionality marker. Applications supply their
 * own runtime schemas; reading this file never admits or refuses an app.
 *
 * A folder that keeps files on the machine that wrote them adds
 * `"local": ["audio/"]`, its `.gitignore` patterns (ADR-0577). The folder's
 * own file is what the `epicenter` CLI's history reads (`parseLocalPolicy`),
 * so it leaves the same paths out of every commit whatever app wrote them.
 * That reading needs no `tables`: `{"local": ["audio/"]}` is a whole policy.
 * A file without `local` keeps nothing local.
 *
 * A top-level `$schema` lets an editor offer completion and is not
 * interpreted. Unknown envelope keys are refused, so a misspelled key never reads as
 * an empty definition.
 */

import { isOptional, isTableName } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	DECLARATION_KEYS,
	type Declaration,
	declarationProblem,
	prepareTableSchemas,
	type SavedView,
	savedViewProblem,
} from './declaration-schema.js';
import type { Definition } from './definition.js';
import { localMatcher } from './git/scope.js';
import { parseJsonObject } from './json-object.js';
import { DEFINITION_PATH } from './paths.js';

/** The `epicenter.json` text of a prepared definition. */
export function formatDefinition(definition: Definition): string {
	const tables: Record<string, unknown> = {};
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = {
			type: 'object',
			properties: table.fields,
			required: Object.keys(table.fields).filter(
				(key) => !isOptional(table.fields[key]!),
			),
			...(table.additionalProperties === false
				? { additionalProperties: false }
				: {}),
		};
	return `${JSON.stringify(
		{
			...(definition.title === undefined ? {} : { title: definition.title }),
			...(definition.local === undefined ? {} : { local: definition.local }),
			tables,
		},
		null,
		2,
	)}\n`;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The top-level keys an `epicenter.json` may hold. */
const TOP_LEVEL_KEYS = DECLARATION_KEYS;

/**
 * The `local` patterns of `epicenter.json`'s bytes, read as a directory's Git
 * history reads them to decide what stays on this computer: none when the
 * file lists none, or why the file says nothing usable.
 *
 * Only `local` is interpreted. `tables` and `title` are an app's, to read
 * files with, so a table schema no app can prepare does not stop history.
 * The file is still read whole and strictly: UTF-8 JSON, an object whose
 * every key is one `epicenter.json` declares, so a misspelled `Local` never
 * reads as an empty list, and each pattern one ignoring `.gitignore` line:
 * no comment, no negation, nothing empty, no second line, no surrounding
 * whitespace. No pattern may match `epicenter.json` itself: the file that
 * says what stays local goes with every commit.
 */
export function parseLocalPolicy(
	bytes: Uint8Array,
): Result<readonly string[], { readonly reason: string }> {
	const refuse = (reason: string) => Err({ reason });
	let text: string;
	try {
		text = utf8.decode(bytes);
	} catch {
		return refuse('it is not UTF-8 text');
	}
	const source = parseJsonObject(text, { forLocalPolicy: true });
	if (source.error !== null) return source;
	const { data: declared, error } = checkEnvelope(source.data);
	if (error !== null) return Err(error);
	return localPolicyOf(declared.local);
}

function localPolicyOf(
	local: unknown,
): Result<readonly string[], { reason: string }> {
	const refuse = (reason: string) => Err({ reason });
	if (local === undefined) return Ok([]);
	if (!Array.isArray(local))
		return refuse("'local' must list .gitignore patterns");
	for (const pattern of local as unknown[]) {
		if (typeof pattern !== 'string' || pattern === '')
			return refuse("each 'local' pattern must be a nonempty string");
		const quoted = JSON.stringify(pattern);
		if (/[\r\n]/.test(pattern))
			return refuse(`the local pattern ${quoted} must be one line`);
		if (pattern.trim() !== pattern)
			return refuse(`the local pattern ${quoted} has surrounding whitespace`);
		if (pattern.startsWith('#') || pattern.startsWith('!'))
			return refuse(
				`the local pattern ${quoted} must keep files local; it cannot be a comment or a negation`,
			);
		if (localMatcher([pattern])(DEFINITION_PATH))
			return refuse(
				`the local pattern ${quoted} matches ${DEFINITION_PATH} itself, which every commit must carry; narrow it`,
			);
	}
	return Ok(Object.freeze([...(local as string[])]));
}

/**
 * Read a folder's own `epicenter.json` through `storage` as its Git history
 * does (`parseLocalPolicy`): its `local` patterns, `undefined` when the
 * folder has none, or why the file cannot be used. It writes nothing.
 */
export async function readLocalPolicy(
	storage: Pick<FolderStorage, 'read'>,
): Promise<Result<readonly string[] | undefined, { readonly reason: string }>> {
	const { data: read, error } = await storage.read(DEFINITION_PATH);
	if (error !== null)
		return error.name === 'NotFound'
			? Ok(undefined)
			: Err({ reason: error.message });
	return parseLocalPolicy(read.bytes);
}

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
	const local = localPolicyOf(value.local);
	if (local.error !== null) return local;
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
	const parsed = parseDeclarationObject(text);
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

/** Read only table declarations; unrelated view or local problems stay with their readers. */
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

/** CLI checking requires declared tables; optional views never change that requirement. */
export async function readDefinition(
	storage: Pick<FolderStorage, 'read'>,
): Promise<
	Result<
		{ tables: NonNullable<Declaration['tables']> } | undefined,
		{ reason: string }
	>
> {
	const { data: read, error } = await storage.read(DEFINITION_PATH);
	if (error !== null)
		return error.name === 'NotFound'
			? Ok(undefined)
			: Err({ reason: error.message });
	let text: string;
	try {
		text = utf8.decode(read.bytes);
	} catch {
		return Err({ reason: 'it is not UTF-8 text' });
	}
	const parsed = readDeclaredTables(text);
	if (parsed.error !== null) return parsed;
	if (parsed.data === undefined)
		return Err({
			reason:
				"it has no 'tables'; check and query require declared table schemas",
		});
	return Ok({ tables: parsed.data });
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

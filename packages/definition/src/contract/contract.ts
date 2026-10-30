/**
 * A contract: the layout of an app's files, as plain data (decisions 1 to 5).
 *
 * A contract has a `name` and `collections`. The name is the app's
 * (`whispering`), a lowercase slug, not a repository address: a repository
 * is `<account>/<name>` (decision 46). A collection has a `path`
 * template; one whose path ends in `.md` holds notes, whose front matter
 * `fields` are JSON Schema properties, and any other holds files (decision
 * 3). Placeholders in the path (`{id}`, `{date}`) are what a writer passes to
 * name a file; nothing is minted for it (decision 5, see `ids.ts`).
 *
 * `defineContract` only captures the literal types, so the typed client
 * (`client.ts`) can read them; `compileContract` is the one check of a
 * contract's shape at run time, for a contract written in code or read from
 * JSON alike.
 *
 * Ported in part from `claude/repository-v2` `core/lens.ts` (the overlap
 * refusal, collection claims and note checks), without its blob flag, SQL
 * views or reserved handle names.
 */
import { Compile } from 'typebox/compile';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ConformanceIssue } from '../declaration.js';
import { isJsonSafe } from '../json.js';
import { schemaProblem } from '../prepare.js';
import { isNotePath } from './storage.js';
import {
	compileTemplate,
	fill,
	IDENTIFIER,
	isNoteTemplate,
	match,
	type Template,
	TemplateError,
	templatesOverlap,
} from './templates.js';

/**
 * One collection: where its files live, and, for notes, their front matter.
 *
 * `fields` maps each front matter key to a JSON Schema, as JSON Schema's own
 * `properties` does, and `required` lists the keys a note must hold, as JSON
 * Schema's own `required` does. A field not listed may be absent.
 */
export type Collection = {
	readonly path: string;
	readonly fields?: { readonly [field: string]: object };
	readonly required?: readonly string[];
};

/**
 * An app's contract: its name and its collections, by the name the client
 * uses. `$schema` and `description` are there for the published JSON, so an
 * editor can validate it and a person can read what it is for.
 */
export type Contract = {
	readonly $schema?: string;
	/** The app's name: a lowercase slug (`whispering`, `quick-capture`). */
	readonly name: string;
	readonly description?: string;
	readonly collections: { readonly [collection: string]: Collection };
};

/** An app's name: lowercase letters, digits and `-`, starting with a letter or digit. */
const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** The keys a contract may hold. */
const CONTRACT_KEYS = new Set([
	'$schema',
	'name',
	'description',
	'collections',
]);

/**
 * Write a contract with its literal types kept: the identity function, so
 * the same object can be published as JSON.
 *
 * @example
 * ```ts
 * const recorder = defineContract({
 *   name: 'whispering',
 *   collections: {
 *     recordings: {
 *       path: 'recordings/{id}.md',
 *       fields: { title: { type: 'string' }, durationMs: { type: 'number' } },
 *       required: ['title'],
 *     },
 *     audio: { path: 'recordings/{id}.{ext}' },
 *   },
 * });
 * ```
 */
export function defineContract<const TContract extends Contract>(
	contract: TContract,
): TContract {
	return contract;
}

export const ContractError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This contract is not well formed: ${reason}`,
		reason,
	}),
});
export type ContractError = InferErrors<typeof ContractError>;

/**
 * Names a value already uses: a note's `body`, a file's `bytes`, and every
 * read's `version`. No placeholder or field may take one.
 */
const RESERVED = new Set(['body', 'bytes', 'version']);

/** One collection, compiled: its kind, its template, and its field validators. */
export type CompiledCollection = ReturnType<typeof compiledCollection>;

/**
 * A contract checked and compiled: every collection's template and field
 * validators, and which collection claims a path. Refused, never thrown,
 * when the contract is not well formed: it may have arrived as JSON.
 */
export function compileContract(
	contract: unknown,
): Result<CompiledContract, ContractError> {
	const malformed = (reason: string) => ContractError.Malformed({ reason });
	if (!isPlainObject(contract)) return malformed('it is not a plain object');
	const unknown = Object.keys(contract).filter(
		(key) => !CONTRACT_KEYS.has(key),
	);
	if (unknown.length > 0)
		return malformed(
			`it declares ${unknown.map((key) => `'${key}'`).join(', ')}; a contract declares $schema, name, description and collections`,
		);
	const { $schema, name, description, collections } = contract;
	if (typeof name !== 'string' || !APP_NAME.test(name))
		return malformed(
			`its name ${JSON.stringify(name)} is not an app name: lowercase letters, digits and '-', such as 'whispering'`,
		);
	for (const [key, value] of [
		['$schema', $schema],
		['description', description],
	] as const)
		if (value !== undefined && typeof value !== 'string')
			return malformed(`its ${key} is not a string`);
	if (!isPlainObject(collections) || Object.keys(collections).length === 0)
		return malformed('it declares no collections');
	const compiled: CompiledCollection[] = [];
	for (const [key, collection] of Object.entries(collections)) {
		const one = compileCollection(key, collection);
		if (one.error !== null) return malformed(one.error);
		compiled.push(one.data);
	}
	for (const [index, a] of compiled.entries())
		for (const b of compiled.slice(index + 1))
			if (a.kind === b.kind && templatesOverlap(a.template, b.template))
				return malformed(
					`'${a.name}' (${a.template.source}) and '${b.name}' (${b.template.source}) can name the same file`,
				);
	return Ok(compiledContract(name, compiled));
}

function compiledContract(name: string, collections: CompiledCollection[]) {
	return {
		name,
		collections,
		/**
		 * The collection that names `path`, with its placeholder values, or
		 * null. A note path is claimed only by a note collection and any other
		 * path only by a file collection, so `recordings/{id}.{ext}` never
		 * claims `recordings/x.md`. Collections of one kind never overlap, so
		 * at most one claims a path.
		 */
		claim(path: string): {
			collection: CompiledCollection;
			params: Record<string, string>;
		} | null {
			const kind = isNotePath(path) ? 'note' : 'file';
			for (const collection of collections) {
				if (collection.kind !== kind) continue;
				const params = match(collection.template, path);
				if (params !== null) return { collection, params };
			}
			return null;
		},
	};
}
export type CompiledContract = ReturnType<typeof compiledContract>;

/** One collection compiled, or why it is not well formed. */
function compileCollection(
	name: string,
	declared: unknown,
): Result<ReturnType<typeof compiledCollection>, string> {
	const refuse = (reason: string) => Err(reason);
	if (!IDENTIFIER.test(name))
		return refuse(`the collection name '${name}' is not an identifier`);
	if (!isPlainObject(declared))
		return refuse(`collection '${name}' is not a plain object`);
	const unknown = Object.keys(declared).filter(
		(key) => key !== 'path' && key !== 'fields' && key !== 'required',
	);
	if (unknown.length > 0)
		return refuse(
			`collection '${name}' declares ${unknown.map((key) => `'${key}'`).join(', ')}; a collection declares path, fields and required`,
		);
	const { path, fields = {}, required = [] } = declared;
	if (typeof path !== 'string')
		return refuse(`collection '${name}' has no path`);
	const template = compileTemplate(path);
	if (template.error !== null) return refuse(template.error.message);
	for (const param of template.data.params)
		if (RESERVED.has(param))
			return refuse(`{${param}} in '${name}' is a name every value reserves`);
	const kind = isNoteTemplate(template.data) ? 'note' : 'file';
	if (
		kind === 'file' &&
		(Object.hasOwn(declared, 'fields') || Object.hasOwn(declared, 'required'))
	)
		return refuse(
			`collection '${name}' holds files (its path does not end in .md), which have no fields`,
		);
	if (!isPlainObject(fields))
		return refuse(
			`collection '${name}' has fields that are not a plain object`,
		);
	const validators = new Map<string, ReturnType<typeof Compile>>();
	for (const [field, schema] of Object.entries(fields)) {
		if (field === '' || RESERVED.has(field))
			return refuse(`the field name '${field}' in '${name}' is not usable`);
		if (template.data.params.includes(field))
			return refuse(`the field '${field}' in '${name}' is also a placeholder`);
		if (!isPlainObject(schema))
			return refuse(`the field '${name}.${field}' is not a JSON Schema`);
		const problem = schemaProblem(schema);
		if (problem !== undefined)
			return refuse(`the field '${name}.${field}' is not usable: ${problem}`);
		try {
			validators.set(field, Compile(JSON.parse(JSON.stringify(schema))));
		} catch (cause) {
			return refuse(
				`the field '${name}.${field}' does not compile: ${String(cause)}`,
			);
		}
	}
	if (
		!Array.isArray(required) ||
		required.some((key) => typeof key !== 'string' || !validators.has(key))
	)
		return refuse(`collection '${name}' requires a field it does not declare`);
	return Ok(
		compiledCollection(name, kind, template.data, validators, required),
	);
}

function compiledCollection(
	name: string,
	kind: 'note' | 'file',
	template: Template,
	validators: Map<string, ReturnType<typeof Compile>>,
	required: string[],
) {
	return {
		name,
		kind,
		template,
		/** The declared field names, in declaration order: the house style's key order. */
		keys: [...validators.keys()],
		/** The path these placeholder values name; a file collection refuses to name a note. */
		pathOf(params: Record<string, unknown>): Result<string, TemplateError> {
			const filled = fill(template, params);
			if (filled.error !== null || kind === 'note' || !isNotePath(filled.data))
				return filled;
			const [param = ''] = template.params.slice(-1);
			return TemplateError.InvalidValue({ param, value: params[param] });
		},
		/**
		 * How front matter values fail this collection's fields, one issue per
		 * failure; none when they conform. A key the contract does not declare
		 * is not an issue: front matter may carry other keys.
		 */
		checkFields(values: Readonly<Record<string, unknown>>): ConformanceIssue[] {
			const issues: ConformanceIssue[] = [];
			for (const [field, validator] of validators) {
				const value = Object.hasOwn(values, field) ? values[field] : undefined;
				if (value === undefined) {
					if (required.includes(field))
						issues.push({ field, message: `${field} is missing` });
					continue;
				}
				if (!isJsonSafe(value)) {
					issues.push({ field, message: `${field} is not a JSON value` });
					continue;
				}
				if (validator.Check(value)) continue;
				const errors = validator.Errors(value);
				if (errors.length === 0)
					issues.push({ field, message: `${field} does not conform` });
				for (const error of errors)
					issues.push({
						field,
						...(error.instancePath === '' ? {} : { path: error.instancePath }),
						message: `${field}${error.instancePath} does not conform: ${error.message}`,
					});
			}
			return issues;
		},
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

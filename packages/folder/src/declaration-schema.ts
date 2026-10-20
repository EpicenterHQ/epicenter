/** The portable epicenter.json format. Runtime app schemas remain application code. */
import { type Static, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Format } from 'typebox/format';
import { Resolve } from 'typebox/schema';
import { Check, Errors } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { pathProblem } from './paths.js';
import { schemaSourceProblem } from './schema-source.js';

const formats = {
	'date-time': Format.IsDateTime,
	date: Format.IsDate,
	duration: Format.IsDuration,
	email: Format.IsEmail,
	hostname: Format.IsHostname,
	'idn-email': Format.IsIdnEmail,
	'idn-hostname': Format.IsIdnHostname,
	ipv4: Format.IsIPv4,
	ipv6: Format.IsIPv6,
	'iri-reference': Format.IsIriReference,
	iri: Format.IsIri,
	'json-pointer-uri-fragment': Format.IsJsonPointerUriFragment,
	'json-pointer': Format.IsJsonPointer,
	regex: Format.IsRegex,
	'relative-json-pointer': Format.IsRelativeJsonPointer,
	time: Format.IsTime,
	'uri-reference': Format.IsUriReference,
	'uri-template': Format.IsUriTemplate,
	uri: Format.IsUri,
	url: Format.IsUrl,
	uuid: Format.IsUuid,
};
const schema = Type.Ref('Schema');
const schemaMap = Type.Record(Type.String(), schema);
const stringList = Type.Array(Type.String(), { uniqueItems: true });
const count = Type.Integer({ minimum: 0 });
const jsonType = Type.Union([
	Type.Literal('null'),
	Type.Literal('boolean'),
	Type.Literal('object'),
	Type.Literal('array'),
	Type.Literal('number'),
	Type.Literal('integer'),
	Type.Literal('string'),
]);

/** Supported JSON Schema keywords, recursively checked instead of trusting Compile as a metaschema. */
const schemaProperties = {
	$schema: Type.Optional(Type.String()),
	$id: Type.Optional(Type.String()),
	$ref: Type.Optional(Type.String()),
	$defs: Type.Optional(schemaMap),
	definitions: Type.Optional(schemaMap),
	type: Type.Optional(
		Type.Union([
			jsonType,
			Type.Array(jsonType, { minItems: 1, uniqueItems: true }),
		]),
	),
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	$comment: Type.Optional(Type.String()),
	default: Type.Optional(Type.Unknown()),
	examples: Type.Optional(Type.Array(Type.Unknown())),
	const: Type.Optional(Type.Unknown()),
	enum: Type.Optional(
		Type.Array(Type.Unknown(), { minItems: 1, uniqueItems: true }),
	),
	readOnly: Type.Optional(Type.Boolean()),
	writeOnly: Type.Optional(Type.Boolean()),
	deprecated: Type.Optional(Type.Boolean()),
	'x-field': Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	minimum: Type.Optional(Type.Number()),
	maximum: Type.Optional(Type.Number()),
	exclusiveMinimum: Type.Optional(Type.Number()),
	exclusiveMaximum: Type.Optional(Type.Number()),
	multipleOf: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	minLength: Type.Optional(count),
	maxLength: Type.Optional(count),
	pattern: Type.Optional(Type.String()),
	format: Type.Optional(Type.String({ enum: Object.keys(formats) })),
	properties: Type.Optional(schemaMap),
	patternProperties: Type.Optional(schemaMap),
	required: Type.Optional(stringList),
	additionalProperties: Type.Optional(schema),
	propertyNames: Type.Optional(schema),
	minProperties: Type.Optional(count),
	maxProperties: Type.Optional(count),
	dependentRequired: Type.Optional(Type.Record(Type.String(), stringList)),
	dependentSchemas: Type.Optional(schemaMap),
	items: Type.Optional(schema),
	prefixItems: Type.Optional(Type.Array(schema)),
	contains: Type.Optional(schema),
	minContains: Type.Optional(count),
	maxContains: Type.Optional(count),
	minItems: Type.Optional(count),
	maxItems: Type.Optional(count),
	uniqueItems: Type.Optional(Type.Boolean()),
	allOf: Type.Optional(Type.Array(schema, { minItems: 1 })),
	anyOf: Type.Optional(Type.Array(schema, { minItems: 1 })),
	oneOf: Type.Optional(Type.Array(schema, { minItems: 1 })),
	not: Type.Optional(schema),
	if: Type.Optional(schema),
	then: Type.Optional(schema),
	else: Type.Optional(schema),
};
const sort = Type.Object(
	{
		field: Type.String(),
		direction: Type.Union([Type.Literal('asc'), Type.Literal('desc')]),
	},
	{ additionalProperties: false },
);
const filter = Type.Object(
	{
		field: Type.String(),
		operator: Type.Union([
			Type.Literal('eq'),
			Type.Literal('ne'),
			Type.Literal('lt'),
			Type.Literal('lte'),
			Type.Literal('gt'),
			Type.Literal('gte'),
			Type.Literal('contains'),
			Type.Literal('exists'),
		]),
		value: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
export const SavedViewSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal('grid'),
			title: Type.String({ minLength: 1 }),
			table: Type.String(),
			columns: Type.Optional(stringList),
			filters: Type.Optional(Type.Array(filter)),
			sort: Type.Optional(Type.Array(sort)),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal('board'),
			title: Type.String({ minLength: 1 }),
			table: Type.String(),
			groupBy: Type.String(),
			columns: Type.Optional(stringList),
			filters: Type.Optional(Type.Array(filter)),
			sort: Type.Optional(Type.Array(sort)),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal('sql'),
			title: Type.String({ minLength: 1 }),
			sql: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);
export type SavedView = Static<typeof SavedViewSchema>;
export type SavedViewFilter = Static<typeof filter>;
export type SavedViewSort = Static<typeof sort>;

/** Validate a single known view without interpreting unrelated declaration sections. */
export function savedViewProblem(value: unknown): string | undefined {
	const source = schemaSourceProblem(value);
	if (source !== undefined) return source;
	if (!Check(SavedViewSchema, value)) {
		const issue = Errors(SavedViewSchema, value).sort(
			(left, right) => right.instancePath.length - left.instancePath.length,
		)[0];
		return issue === undefined
			? 'it is not a supported saved view'
			: `${issue.instancePath || '/'} ${issue.message}`;
	}
	if (
		value.type !== 'sql' &&
		(value.table.includes('/') || pathProblem(value.table) !== undefined)
	)
		return `table '${value.table}' must name one top-level table directory`;
	return undefined;
}

const declaration = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		title: Type.Optional(Type.String({ minLength: 1 })),
		local: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		tables: Type.Optional(Type.Record(Type.String(), Type.Ref('Table'))),
		views: Type.Optional(Type.Record(Type.String(), SavedViewSchema)),
	},
	{ additionalProperties: false },
);

/** Canonical document schema; serializing this value produces the editor's JSON Schema. */
export const DeclarationSchema = Type.Cyclic(
	{
		Schema: Type.Union([
			Type.Boolean(),
			Type.Object(schemaProperties, { additionalProperties: false }),
		]),
		Table: Type.Object(
			{
				...schemaProperties,
				type: Type.Literal('object'),
				properties: schemaMap,
			},
			{ additionalProperties: false },
		),
		Declaration: declaration,
	},
	'Declaration',
	{ $schema: 'https://json-schema.org/draft/2020-12/schema' },
);
export type Declaration = Static<typeof DeclarationSchema>;
export type PortableTableSchema = NonNullable<Declaration['tables']>[string];
/** History and section writers share the envelope without validating unrelated sections. */
export const DECLARATION_KEYS = Object.keys(declaration.properties);

/** Structural errors include nested schema grammar errors and unknown keywords. */
export function declarationProblem(value: unknown): string | undefined {
	if (Check(DeclarationSchema, value)) return undefined;
	const first = Errors(DeclarationSchema, value).sort(
		(left, right) => right.instancePath.length - left.instancePath.length,
	)[0];
	if (first === undefined) return 'it is not an epicenter.json declaration';
	const path = first.instancePath.split('/').slice(1);
	let found: unknown = value;
	for (const segment of path)
		found =
			found !== null && typeof found === 'object'
				? (found as Record<string, unknown>)[segment]
				: undefined;
	return `${path.filter((part) => part !== 'properties').join('.') || '/'} ${first.message}: ${JSON.stringify(found)}`;
}

/** Validate one portable table and return its owned, frozen snapshot. */
export function validateTableSchema(
	value: unknown,
): Result<PortableTableSchema, { reason: string }> {
	const prepared = prepareTableSchemas({ table: value });
	if (prepared.error !== null) return prepared;
	return Ok(prepared.data.table!);
}

/** Check table structure once, then own and prepare each complete root. */
export function prepareTableSchemas(
	value: unknown,
): Result<NonNullable<Declaration['tables']>, { reason: string }> {
	const sourceProblem = schemaSourceProblem(value);
	if (sourceProblem !== undefined) return Err({ reason: sourceProblem });
	const problem = declarationProblem({ tables: value });
	if (problem !== undefined || value === undefined)
		return Err({ reason: problem ?? 'tables must be an object' });
	// The input may be a mutable caller value. Compiled validators belong only
	// to these snapshots, never to the caller's object identity.
	let tables: NonNullable<Declaration['tables']>;
	try {
		tables = structuredClone(value) as NonNullable<Declaration['tables']>;
	} catch (cause) {
		return Err({ reason: `table schemas cannot be copied: ${String(cause)}` });
	}
	for (const [name, table] of Object.entries(tables)) {
		const semantic = schemaProblem(table);
		if (semantic !== undefined)
			return Err({ reason: `tables.${name}: ${semantic}` });
		freeze(table);
		ownedSchemas.add(table);
		try {
			compileTableSchema(table);
		} catch (cause) {
			return Err({ reason: `tables.${name}: ${String(cause)}` });
		}
	}
	return Ok(Object.freeze(tables));
}

function freeze(value: unknown): void {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value))
		return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}

const ownedSchemas = new WeakSet<object>();
const tableValidators = new WeakMap<object, ReturnType<typeof Compile>>();
/** Only owned snapshots are cached. Mutable caller schemas are compiled afresh. */
export function compileTableSchema(
	schema: PortableTableSchema,
): ReturnType<typeof Compile> {
	const found = tableValidators.get(schema);
	if (found !== undefined) return found;
	const validator = Compile(schema);
	if (ownedSchemas.has(schema)) tableValidators.set(schema, validator);
	return validator;
}

function schemaProblem(root: PortableTableSchema): string | undefined {
	const ids = new Set<string>();
	const positions = new Map<object, string>();
	const schemaPaths = new Set<string>();
	const references: { scope: object; at: string; ref: string }[] = [];
	function visit(node: unknown, scope: object, at: string): string | undefined {
		schemaPaths.add(at);
		if (typeof node === 'boolean') return undefined;
		if (typeof node !== 'object' || node === null || Array.isArray(node))
			return `${at} is not a schema`;
		const object = node as Record<string, unknown>;
		positions.set(object, at);
		if (typeof object.$id === 'string') {
			if (ids.has(object.$id))
				return `${at} repeats schema $id '${object.$id}'`;
			ids.add(object.$id);
			scope = object;
		}
		if (typeof object.$ref === 'string')
			references.push({ scope, at, ref: object.$ref });

		if (
			typeof object.format === 'string' &&
			Format.Get(object.format) !==
				formats[object.format as keyof typeof formats]
		)
			return `${at} has a replaced portable format '${object.format}'`;
		if (typeof object.pattern === 'string') {
			try {
				new RegExp(object.pattern);
			} catch {
				return `${at} has an invalid pattern`;
			}
		}
		for (const keyword of [
			'properties',
			'patternProperties',
			'$defs',
			'definitions',
			'dependentSchemas',
		]) {
			const children = object[keyword];
			if (typeof children !== 'object' || children === null) continue;
			for (const [key, child] of Object.entries(children)) {
				if (keyword === 'patternProperties') {
					try {
						new RegExp(key);
					} catch {
						return `${at} has an invalid property pattern '${key}'`;
					}
				}
				const problem = visit(
					child,
					scope,
					`${at}/${keyword}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
				);
				if (problem !== undefined) return problem;
			}
		}
		for (const keyword of [
			'items',
			'prefixItems',
			'additionalProperties',
			'contains',
			'propertyNames',
			'not',
			'if',
			'then',
			'else',
			'allOf',
			'anyOf',
			'oneOf',
		]) {
			const child = object[keyword];
			if (child === undefined) continue;
			for (const [index, item] of (Array.isArray(child)
				? child
				: [child]
			).entries()) {
				const problem = visit(
					item,
					scope,
					`${at}/${keyword}${Array.isArray(child) ? `/${index}` : ''}`,
				);
				if (problem !== undefined) return problem;
			}
		}
		return undefined;
	}
	const problem = visit(root, root, '#');
	if (problem !== undefined) return problem;
	for (const { scope, at, ref } of references) {
		let target: unknown;
		try {
			target = Resolve.Ref(
				(ref.startsWith('#') ? scope : root) as Parameters<
					typeof Resolve.Ref
				>[0],
				ref,
			);
		} catch {}
		let supported =
			typeof target === 'object' && target !== null && positions.has(target);
		// A JSON pointer may name a boolean schema. Its location must still be
		// a schema position, rather than a boolean buried in const/default data.
		if (ref.startsWith('#')) {
			try {
				const pointer = decodeURIComponent(ref.slice(1));
				const base = positions.get(scope);
				supported =
					target !== undefined &&
					base !== undefined &&
					schemaPaths.has(`${base}${pointer}`);
			} catch {
				supported = false;
			}
		}
		if (!supported)
			return `${at} has unresolved or unsupported schema reference '${ref}'; references must name a supported schema position`;
	}
	return undefined;
}

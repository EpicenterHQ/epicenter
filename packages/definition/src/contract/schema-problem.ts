/**
 * Whether a declared schema can be a contract's note field: plain JSON that
 * a published contract holds and validates exactly as it does in memory.
 */
import { Format } from 'typebox/format';
import { Resolve } from 'typebox/schema';
import { Ok, trySync } from 'wellcrafted/result';

// Compare against TypeBox's stock handlers, not a registry that an
// application may have changed before this module was imported.
const PORTABLE_FORMATS = new Map<string, (value: string) => boolean>([
	['date-time', Format.IsDateTime],
	['date', Format.IsDate],
	['duration', Format.IsDuration],
	['email', Format.IsEmail],
	['hostname', Format.IsHostname],
	['idn-email', Format.IsIdnEmail],
	['idn-hostname', Format.IsIdnHostname],
	['ipv4', Format.IsIPv4],
	['ipv6', Format.IsIPv6],
	['iri-reference', Format.IsIriReference],
	['iri', Format.IsIri],
	['json-pointer-uri-fragment', Format.IsJsonPointerUriFragment],
	['json-pointer', Format.IsJsonPointer],
	['regex', Format.IsRegex],
	['relative-json-pointer', Format.IsRelativeJsonPointer],
	['time', Format.IsTime],
	['uri-reference', Format.IsUriReference],
	['uri-template', Format.IsUriTemplate],
	['uri', Format.IsUri],
	['url', Format.IsUrl],
	['uuid', Format.IsUuid],
]);

/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(['default', 'const', 'enum', 'examples']);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
	'dependencies',
]);
/** Keywords whose value is a schema or a list of schemas. */
const SCHEMA_KEYWORDS = new Set([
	'items',
	'prefixItems',
	'additionalItems',
	'additionalProperties',
	'unevaluatedItems',
	'unevaluatedProperties',
	'contains',
	'propertyNames',
	'not',
	'if',
	'then',
	'else',
	'anyOf',
	'allOf',
	'oneOf',
]);

/**
 * Why a declared schema cannot be a contract's note field, or `undefined` when it can. A field
 * is JSON, so the file it is written to validates exactly as the field does:
 *
 * - no function anywhere, which is how a refinement, guard, or codec is held;
 * - only plain objects and dense arrays, with enumerable data properties and
 *   no symbol keys, because anything else would not survive being written;
 * - finite numbers;
 * - a `format` only from the portable set, at a schema position. TypeBox
 *   passes every value for a format it does not know, so a misspelled format
 *   would check nothing;
 * - a `$ref` that resolves, the way TypeBox resolves it, to a schema inside
 *   the field. A reference to nothing fails every value, so every row would
 *   read as invalid.
 *
 * TypeBox's own hidden `~` keywords are allowed and left behind; a visible
 * `~` key is refused, so optionality has one spelling in a file: `required`.
 */
export function schemaProblem(declared: object): string | undefined {
	const seen = new Set<object>();
	const visit = (
		node: unknown,
		path: string,
		position: 'schema' | 'data',
		// The nearest schema with an `$id`, which a `#` reference resolves
		// against, as TypeBox's compiler does; the field itself without one.
		base: object = declared,
	): string | undefined => {
		if (typeof node === 'function') return `${path} holds a runtime callback`;
		if (typeof node === 'number' && !Number.isFinite(node))
			return `${path} is not a finite number`;
		if (typeof node !== 'object' || node === null) return undefined;
		if (seen.has(node)) return `${path} refers back to itself`;
		if (!Array.isArray(node) && !isPlainObject(node))
			return `${path} is not plain JSON`;
		if (Object.getOwnPropertySymbols(node).length > 0)
			return `${path} has symbol keys`;
		seen.add(node);
		try {
			const array = Array.isArray(node);
			const scope =
				position === 'schema' &&
				!array &&
				typeof (node as { $id?: unknown }).$id === 'string'
					? node
					: base;
			for (const key of Object.getOwnPropertyNames(node)) {
				if (array && key === 'length') continue;
				const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
				const at = `${path}.${key}`;
				if (!('value' in descriptor)) return `${at} is an accessor`;
				if (key.startsWith('~')) {
					if (key === '~guard' || key === '~refine' || key === '~codec')
						return `${at} is a runtime callback`;
					// TypeBox keeps its own `~` keywords hidden. A visible one in a
					// schema, such as a hand-written "~optional", would mean
					// something only here. In data it is an ordinary key.
					if (descriptor.enumerable && position === 'schema' && !array)
						return `${at} is not a JSON Schema keyword`;
					if (descriptor.enumerable) {
						const problem = visit(descriptor.value, at, 'data');
						if (problem !== undefined) return problem;
						continue;
					}
					// A hidden keyword is dropped, so it may not hide a callback.
					const hidden = visit(descriptor.value, at, 'data');
					if (hidden !== undefined) return hidden;
					continue;
				}
				if (!descriptor.enumerable) return `${at} is hidden`;
				if (array && !/^(0|[1-9][0-9]*)$/.test(key))
					return `${path} holds a non-index property`;
				const value = descriptor.value;
				// JSON drops an `undefined` member and writes `null` for an
				// `undefined` element, either of which would change the check.
				if (value === undefined && (array || key === 'const'))
					return `${at} is undefined, which JSON cannot hold`;
				let next: 'schema' | 'data' = 'data';
				let children: 'self' | 'values' = 'self';
				if (position === 'schema' && !array) {
					if (key === 'format' && typeof value === 'string') {
						const stock = PORTABLE_FORMATS.get(value);
						if (stock === undefined || Format.Get(value) !== stock)
							return `${at} is not a portable format: '${value}'`;
					}
					if (key === '$ref' && typeof value === 'string') {
						const problem = referenceProblem(declared, scope, value);
						if (problem !== undefined)
							return `${at} names '${value}', ${problem}`;
					}
					if (SCHEMA_KEYWORDS.has(key)) next = 'schema';
					else if (SCHEMA_MAP_KEYWORDS.has(key)) {
						next = 'schema';
						children = 'values';
					} else if (DATA_KEYWORDS.has(key)) next = 'data';
				} else if (position === 'schema' && array) next = 'schema';
				const problem =
					children === 'values' && isPlainObject(value)
						? Object.keys(value)
								.map((name) => visit(value[name], `${at}.${name}`, next, scope))
								.find((found) => found !== undefined)
						: visit(value, at, next, scope);
				if (problem !== undefined) return problem;
			}
			if (array && Object.keys(node).length !== (node as unknown[]).length)
				return `${path} is sparse`;
		} finally {
			seen.delete(node);
		}
		return undefined;
	};
	return visit(declared, '$', 'schema');
}

/**
 * Why `ref` does not lead to a schema inside the field, or `undefined` when it
 * does. TypeBox resolves a `#` reference against the nearest schema with an
 * `$id` and any other against the whole field; this asks the same resolver.
 */
function referenceProblem(
	field: object,
	scope: object,
	ref: string,
): string | undefined {
	// A reference that is not a URI resolves to nothing.
	const { data: target } = trySync({
		try: () =>
			Resolve.Ref(
				(ref.startsWith('#') ? scope : field) as Parameters<
					typeof Resolve.Ref
				>[0],
				ref,
			),
		catch: () => Ok(undefined),
	});
	if (target === undefined) return 'which nothing in this field defines';
	if (typeof target !== 'boolean' && !isPlainObject(target))
		return 'which is not a schema';
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

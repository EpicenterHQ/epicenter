/**
 * The closed field palette, expressed as a META-SCHEMA (a schema OF schemas).
 *
 * A field's at-rest truth is a plain JSON Schema. This module answers the one
 * question about such a schema, through a single total entry point:
 *
 *   recognize(s) -> the kind whose closed meta matches, or null if `s` is outside
 *                   the palette (the rejection lane that degrades a field to raw).
 *
 * Each kind carries a CLOSED TypeBox object meta-schema (`additionalProperties:
 * false`). Two properties fall out of that closure and they are the whole point:
 *
 *   1. The metas are MUTUALLY EXCLUSIVE. A `url` schema carries `format:'uri'`,
 *      which the bare-`string` meta forbids; an `instant` schema carries the exact
 *      UTC pattern, which the broad `datetime` meta forbids; a `select` schema
 *      carries `enum`, which every closed meta forbids; a `multiSelect`'s items
 *      carry `enum`, which the `tags` item meta forbids. So at most one meta
 *      matches any legal schema, which means `recognize` needs no priority order
 *      and cannot be ambiguous.
 *   2. TYPOS DIE AT THE BOUNDARY. `{type:'strng'}` or `{type:'string', minLgth:1}`
 *      matches no meta, so `recognize` returns null and the field degrades to a raw
 *      field instead of silently rendering as `string`.
 *
 * Every meta reads `{ ...discriminators, ...refinements, ...annotations }`: three
 * buckets with one rule, only the DISCRIMINATORS differ across kinds.
 *
 *   discriminators  type / format / enum / items   the keys recognition reads.
 *   refinements     minLength.. / minimum.. / minItems..   closed per value-domain,
 *                   so a typo'd refinement key still dies, and the value constraint
 *                   rides along for free: a rating is `{type:'integer', minimum:1,
 *                   maximum:5}`, still kind `integer`, still validated, no new kind.
 *   annotations     title / description / default   inert metadata, IDENTICAL on
 *                   every meta. That identity is load-bearing: because the same
 *                   bucket is spread into every meta, an annotation can never tip
 *                   which kind matches, which is exactly why the bucket is safe to
 *                   widen. Held to the standard keywords with a real authoring path
 *                   into a field (`title`/`description` from the field builders,
 *                   `default` for a new-row default). `examples`, `$comment`,
 *                   `deprecated`, `readOnly`, `writeOnly`, `$id`, `$schema` are NOT
 *                   admitted: no path today, so a schema carrying one degrades to raw.
 *                   The day a real schema carries one and degrades is the signal to
 *                   add it here, not before.
 *
 * There is NO `nullable` / optional axis: optionality is not part of the vocabulary, so
 * a substrate that wants emptiness layers a nullable wrapper on top (the workspace's
 * `nullable`), and a nullable `anyOf`-with-null shape matches no meta here. Emptiness
 * stays SUBSTRATE POLICY, applied at each substrate's own edge.
 *
 * `json` IS a kind: an arbitrary-JSON payload cell. It is the one OPEN meta, discriminated
 * by an `x-json-schema` MARKER rather than by a `type` (see {@link JSON_SCHEMA_KEYWORD}).
 * `field.json(inner)` spreads the payload's own JSON Schema keywords (so a value still
 * validates) and adds the marker (so `recognize` classifies it as `json`); for an opaque
 * cell, `field.json(jsonValue)` carries the marker over a `Type.Any` payload and accepts
 * any JSON. The rejection lane is now `null`: a typo, a bare object, or a nullable wrapper
 * carries no marker and matches no meta, so it degrades to raw.
 *
 * Everything public is DERIVED from the one `FIELDS` object below: `Kind`,
 * `recognize`, `KINDS`, `META_BY_KIND`. Adding a kind is one entry here,
 * plus its widget in the consuming app's component registry, which the compiler forces.
 *
 * This module also owns the VALUE side of a field schema through `compile` (the single
 * `Schema.Compile` that turns a stored schema into a per-cell validator). The
 * value-semantic formats it leans on (`uri` for `url`, `date` for `date`,
 * `date-time` for `datetime` / `instant`) are TypeBox standard formats,
 * registered for us when `typebox/schema` loads, so `compile` is just the call.
 * So one place answers both readings of a stored schema: "which kind is it"
 * (`recognize`) and "does this value satisfy it" (`compile`).
 */

import { type Static, Type } from 'typebox';
import * as Schema from 'typebox/schema';
import { Value } from 'typebox/value';
import { INSTANT_STRING_PATTERN } from './instant-string.js';

/** Reject any property the meta does not explicitly name. The source of mutual exclusivity. */
const CLOSED = { additionalProperties: false } as const;

/**
 * The `json` kind's discriminator: a marker keyword whose PRESENCE (not value) signals an
 * arbitrary-JSON payload cell. It is a non-standard keyword, so `Value.Check` and
 * `Schema.Compile` ignore it, which is the whole trick: `field.json(inner)` spreads the
 * payload's OWN keywords (which DO validate) alongside this marker (which is invisible to
 * validation but visible to `recognize`). The closed metas forbid it via
 * `additionalProperties:false`, so a marker can only ever land on the `json` kind.
 */
export const JSON_SCHEMA_KEYWORD = 'x-json-schema';

/**
 * The `reference` kind's discriminator: a marker keyword whose VALUE is the name of the
 * table this field points at. Like {@link JSON_SCHEMA_KEYWORD} it is a non-standard
 * keyword, so `Value.Check` and `Schema.Compile` ignore it: a reference cell validates as a
 * plain string (the row stem / id), while `recognize` reads the marker to classify the
 * field as `reference` and to recover its target. The closed metas forbid it via
 * `additionalProperties:false`, so the marker can only ever land on the `reference` kind,
 * which is what keeps `reference` mutually exclusive with the bare `string` kind: a plain
 * string carries no marker (so it is never a reference) and a reference always carries one
 * (so it is never a bare string). The target resolves WITHIN one substrate (a sibling
 * Matter folder / a workspace table key); cross-mount links are the `epicenter://` scheme,
 * not this keyword.
 */
export const REFERENCE_KEYWORD = 'x-ref';

/**
 * Bucket 3: ANNOTATIONS. Inert standard metadata, whitelisted into EVERY closed meta
 * (identically, so it can never affect discrimination) so carrying one does not open
 * the shape. Held to the keys with a real authoring path into a field: `title` /
 * `description` from the field builders, `default` for a new-row default. `default` is
 * `Unknown` (any JSON value, not constrained to the field's own type; conformance
 * validates cell values, not defaults). Other standard annotations (`examples`,
 * `$comment`, `deprecated`, `readOnly`, `writeOnly`, `$id`, `$schema`) are deliberately
 * NOT admitted, so a schema carrying one degrades to raw until a real case argues it in.
 */
const ANNOT = {
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	default: Type.Optional(Type.Unknown()),
};

/**
 * The closed-set discriminant: a non-empty `enum` of STRINGS, optionally pinned to
 * `type:'string'`. Shared by the `select` meta and the `multiSelect` item meta, so
 * the two recognize the same closed-set shape. `enum` is REQUIRED here, which is
 * what keeps `select` mutually exclusive from the closed kinds (they forbid `enum`).
 *
 * The optional `type` accepts both the blessed `field.select` wire-form
 * (`{enum:[...]}`, no `type`, what `Type.Enum` emits) and a `type:'string'`-pinned
 * form authored by hand or another tool. Closed sets are STRING-ONLY: a numeric
 * range is an `integer` with `minimum` / `maximum`, not a select, so a numeric
 * `enum` matches no meta and degrades to raw.
 */
const enumProps = {
	enum: Type.Array(Type.String(), { minItems: 1 }),
	type: Type.Optional(Type.Literal('string')),
};

/** Item shape for `tags`: a plain string, no annotations. Forbids `enum` (that is `multiSelect`). */
const StringItem = Type.Object({ type: Type.Literal('string') }, CLOSED);

/** Item shape for `multiSelect`: the closed-set discriminant. Requires `enum` (that is not `tags`). */
const SelectItem = Type.Object(enumProps, CLOSED);

/** Bucket 2: character and UTF-8 byte refinements for stored strings. */
const STRING_REFINE = {
	minLength: Type.Optional(Type.Integer()),
	maxLength: Type.Optional(Type.Integer()),
	maxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	pattern: Type.Optional(Type.String()),
};

/** Bucket 2: numeric refinements, shared by `integer` and `number`. */
const NUMBER_REFINE = {
	minimum: Type.Optional(Type.Number()),
	maximum: Type.Optional(Type.Number()),
};

/** Bucket 2: list refinements, shared by `tags` and `multiSelect`. */
const LIST_REFINE = {
	minItems: Type.Optional(Type.Integer()),
	maxItems: Type.Optional(Type.Integer()),
	uniqueItems: Type.Optional(Type.Boolean()),
};

/**
 * The single source of the palette, keyed by kind: each entry is a kind's closed
 * meta-schema, used for recognition and boundary validation. `Kind`, `SchemaOf`,
 * `recognize`, `KINDS`, and `META_BY_KIND` all derive from this object, so adding a
 * kind is one entry. Key order is NOT a contract: the metas are mutually exclusive, so
 * `recognize` returns the same answer regardless of iteration order. The keyed shape
 * (not an array) is what lets `Kind` be `keyof` and `SchemaOf<K>` index a single meta
 * without an `Extract`. Each `meta` reads `{ ...discriminators, ...refinements, ...annotations }`.
 */
const FIELDS = {
	select: {
		meta: Type.Object({ ...enumProps, ...ANNOT }, CLOSED),
	},
	url: {
		meta: Type.Object(
			{ type: Type.Literal('string'), format: Type.Literal('uri'), ...ANNOT },
			CLOSED,
		),
	},
	datetime: {
		meta: Type.Object(
			{
				type: Type.Literal('string'),
				format: Type.Literal('date-time'),
				...ANNOT,
			},
			CLOSED,
		),
	},
	instant: {
		meta: Type.Object(
			{
				type: Type.Literal('string'),
				format: Type.Literal('date-time'),
				pattern: Type.Literal(INSTANT_STRING_PATTERN),
				...ANNOT,
			},
			CLOSED,
		),
	},
	date: {
		meta: Type.Object(
			{ type: Type.Literal('string'), format: Type.Literal('date'), ...ANNOT },
			CLOSED,
		),
	},
	integer: {
		meta: Type.Object(
			{ type: Type.Literal('integer'), ...NUMBER_REFINE, ...ANNOT },
			CLOSED,
		),
	},
	number: {
		meta: Type.Object(
			{ type: Type.Literal('number'), ...NUMBER_REFINE, ...ANNOT },
			CLOSED,
		),
	},
	boolean: {
		meta: Type.Object({ type: Type.Literal('boolean'), ...ANNOT }, CLOSED),
	},
	string: {
		meta: Type.Object(
			{ type: Type.Literal('string'), ...STRING_REFINE, ...ANNOT },
			CLOSED,
		),
	},
	reference: {
		// A cross-row pointer: a string VALUE (the target row's stem / id) plus the
		// REFERENCE_KEYWORD marker carrying the target TABLE name. Closed and string-typed,
		// so it stores, materializes, and value-validates exactly like `string` (the marker
		// is invisible to `Value.Check`); the REQUIRED marker is the only thing separating it
		// from `string`, which is what makes the two mutually exclusive (string forbids the
		// marker via CLOSED, reference requires it). The string refinements ride along so an
		// upgraded `{type:'string',minLength:1}` field keeps its constraint when it gains the
		// marker.
		meta: Type.Object(
			{
				type: Type.Literal('string'),
				[REFERENCE_KEYWORD]: Type.String({ minLength: 1 }),
				...STRING_REFINE,
				...ANNOT,
			},
			CLOSED,
		),
	},
	multiSelect: {
		meta: Type.Object(
			{
				type: Type.Literal('array'),
				items: SelectItem,
				...LIST_REFINE,
				...ANNOT,
			},
			CLOSED,
		),
	},
	tags: {
		meta: Type.Object(
			{
				type: Type.Literal('array'),
				items: StringItem,
				...LIST_REFINE,
				...ANNOT,
			},
			CLOSED,
		),
	},
	// The one OPEN meta: a json schema carries the payload's OWN keywords (spread by
	// field.json), so it cannot be closed. Recognition keys off the marker's PRESENCE
	// (see JSON_SCHEMA_KEYWORD); the closed metas forbid the marker, so json stays
	// mutually exclusive with every other kind regardless of what the payload looks like.
	json: {
		meta: Type.Object({ [JSON_SCHEMA_KEYWORD]: Type.Unknown() }),
	},
} as const;

/** The set of field kinds, DERIVED from the palette keys. Includes `json` (the open meta). */
export type Kind = keyof typeof FIELDS;

/** The precise at-rest schema type for one kind, derived from its meta via TypeBox. */
type SchemaOf<K extends Kind> = Static<(typeof FIELDS)[K]['meta']>;

/**
 * A recognized field: a kind paired with its precisely-typed schema. The union is
 * DISCRIMINATED by `kind`, so a downstream `switch (field.kind)` narrows `schema` to
 * the matching shape with no cast. The one cast that establishes the kind/schema
 * pairing lives in `recognize`, right after the `Value.Check` that proves it.
 */
type Recognized = { [K in Kind]: { kind: K; schema: SchemaOf<K> } }[Kind];

/**
 * One validated, compiled field of kind `K`: the frontmatter key it models, its
 * precisely-typed stored schema, the kind, and the precompiled validator. `FieldOf<K>`
 * is the per-kind variant, so `FieldOf<'select'>['schema']['enum']` is typed; {@link
 * Field} is the discriminated union over every kind, so a `switch (field.kind)` narrows
 * `schema` to the matching shape with no cast.
 *
 * `name` is identity (the map key, not in the schema); `schema`, `kind`, and `check` are
 * derived ONCE at the parse boundary (`recognize` + `compile`, both here) so downstream
 * readers never re-gate or recompile. The loaded field lives HERE, beside the catalog and
 * the `compile` that builds it, so this module owns the whole field: the kind set AND the
 * loaded instance. Consumers assemble these into a model.
 */
export type FieldOf<K extends Kind> = {
	/** The frontmatter key this field models. */
	name: string;
	/** This field's kind: the discriminant. */
	kind: K;
	/** The precisely-typed JSON Schema as stored at rest. */
	schema: SchemaOf<K>;
	/** The precompiled value validator (`Schema.Compile`), built once. */
	check: (value: unknown) => boolean;
};

/** A validated, compiled field: the discriminated union over every kind. */
export type Field = { [K in Kind]: FieldOf<K> }[Kind];

/**
 * The table a recognized field points at, read from its {@link REFERENCE_KEYWORD} marker,
 * or `null` when the field is not a reference. The ONE place the marker is read off a
 * loaded {@link Field}, so every consumer (the row-level validator, a relation widget, a
 * grid) recovers a reference target the same way instead of re-narrowing the union and
 * indexing the marker by hand. The `kind === 'reference'` guard narrows `schema` to the
 * reference meta, whose `[REFERENCE_KEYWORD]` is a required string, so no cast is needed.
 *
 * This reads a field AFTER recognition. The schema-level floor in `@epicenter/data/definition`
 * reads the marker off a raw `TSchema` BEFORE recognition (and sees through `nullable`),
 * a genuinely different input, so the two readers stay separate.
 */
export function referenceTargetOf(field: Field): string | null {
	return field.kind === 'reference' ? field.schema[REFERENCE_KEYWORD] : null;
}

/**
 * The one classifier: the recognized field (kind + typed schema) whose closed meta
 * matches `schema`, or `null` when `schema` is outside the palette (the rejection lane
 * that degrades a field to raw). One pass over the metas, no gate to forget and no
 * throw-contract to violate, so a boundary can read `null` directly. Because the metas
 * are mutually exclusive, exactly one matches any legal schema, so there is no priority
 * order.
 */
export function recognize(schema: unknown): Recognized | null {
	for (const kind of Object.keys(FIELDS) as Kind[]) {
		// The Value.Check just proved `schema` matches this kind's meta, so pairing the
		// two as `Recognized` is honest. This is the cast at the MODEL boundary; the field
		// pipeline has exactly one more, at the UI-dispatch boundary in the widget registry.
		// Everything between the two stays cast-free.
		if (Value.Check(FIELDS[kind].meta, schema))
			return { kind, schema } as Recognized;
	}
	return null;
}

/**
 * Every kind in the palette, in declaration order. Package-internal: the discrimination
 * test reads it. Not re-exported from the package barrel (no external consumer); re-export
 * it there the day real tooling needs the catalog.
 */
export const KINDS = Object.keys(FIELDS) as readonly Kind[];

/**
 * The per-kind metas, exposed so a test can prove the discrimination invariant
 * (every legal schema matches EXACTLY ONE meta). Keyed by kind for readable failures.
 */
export const META_BY_KIND = Object.fromEntries(
	Object.entries(FIELDS).map(([kind, def]) => [kind, def.meta]),
) as Record<Kind, (typeof FIELDS)[Kind]['meta']>;

/**
 * Compile a stored JSON Schema into a value check: the ONE place `Schema.Compile` is
 * called. It closes over the validator rather than tearing `Check` off (it reads
 * `this`). `recognize` decides WHICH kind a schema is; `compile` decides whether a
 * VALUE satisfies it.
 *
 * No format registration here. TypeBox treats an UNREGISTERED format as "always passes",
 * so a CUSTOM format would have to be registered or `url` / `date` / `datetime` would
 * accept any string. But `uri`, `date`, and `date-time` are TypeBox STANDARD formats,
 * registered as a load side effect of `typebox/format` (which `Schema.Compile` imports),
 * so the bare compile already enforces them.
 *
 * A reference VALUE is a pointer to a row by its stem, so the empty string names no row
 * and is never a valid reference. That non-emptiness is intrinsic to the kind, the way the
 * marker is already `minLength: 1`, so it holds even when a stored reference omits the
 * refinement: floor the value's `minLength` at 1 here. Any larger author-set `minLength`
 * is kept; non-reference schemas compile verbatim. This makes `""` INVALID at the value
 * check rather than a silently-accepted empty pointer.
 */
export function compile(
	schema: Recognized['schema'],
): (value: unknown) => boolean {
	const effective =
		REFERENCE_KEYWORD in schema
			? { ...schema, minLength: Math.max(1, schema.minLength ?? 0) }
			: schema;
	const validator = Schema.Compile(effective);
	const maxBytes = 'maxBytes' in schema ? schema.maxBytes : undefined;
	const encoder = maxBytes === undefined ? undefined : new TextEncoder();
	return (value) =>
		validator.Check(value) &&
		(maxBytes === undefined ||
			(typeof value === 'string' &&
				encoder !== undefined &&
				encoder.encode(value).byteLength <= maxBytes));
}

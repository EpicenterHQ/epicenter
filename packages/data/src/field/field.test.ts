/**
 * Field Vocabulary Tests
 *
 * The two halves of the closed vocabulary, proven to be inverses over one
 * wire-form: the `field.*` builders construct schemas, `recognize` classifies
 * them back. The ROUND-TRIP suite is the convergence proof: a serialized
 * `field.X(...)` recognizes as kind `X` for every kind.
 *
 * Key behaviors:
 * - Round-trip: recognize(at-rest of field.X(...)) === X, for every kind
 * - Discrimination invariant: every legal schema matches EXACTLY ONE meta
 * - Cross-discrimination: the shapes that could collide resolve to one kind
 * - Refinements and annotations ride along without changing the kind
 * - String byte bounds count UTF-8 bytes at runtime
 * - Rejection lane: unsupported shapes match no meta and recognize as null
 *
 * See also:
 * - `field.test-d.ts` for the `Static<>` preservation of the branded builders.
 */

import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import { field, jsonValue } from './builders.js';
import { compile, KINDS, type Kind, META_BY_KIND, recognize } from './field.js';
import { INSTANT_STRING_PATTERN } from './instant-string.js';

/**
 * The at-rest form of a built schema: a live TypeBox schema carries a
 * non-enumerable `~kind` tag that the CLOSED metas reject; JSON serialization
 * drops it. This mirrors what is actually stored (on disk / in Yjs) and what
 * `recognize` reads, so the round-trip is over the honest stored shape.
 */
const atRest = (schema: TSchema): unknown => JSON.parse(JSON.stringify(schema));

/**
 * The discrimination invariant is the whole bet: every legal field schema must
 * match EXACTLY ONE meta. `countMatches` is the proof instrument; if it ever
 * returns a number other than 1 for a legal schema, the total `recognize` and
 * the per-field degrade both rest on sand.
 */
function countMatches(schema: unknown): number {
	return (Object.keys(META_BY_KIND) as Kind[]).filter((kind) =>
		Value.Check(META_BY_KIND[kind], schema),
	).length;
}

/** The kind `recognize` assigns, or null when the schema is outside the palette. */
const kindOf = (schema: unknown): Kind | null =>
	recognize(schema)?.kind ?? null;

// ============================================================================
// Round-trip: field.* builders are the inverse of recognize
// ============================================================================

/** One representative builder call per kind. The convergence proof iterates these. */
const BUILT: Record<Kind, TSchema> = {
	blob: field.blob(),
	string: field.string(),
	reference: field.reference('pages'),
	url: field.url(),
	date: field.date(),
	instant: field.instant(),
	datetime: field.datetime(),
	select: field.select(['draft', 'published']),
	integer: field.integer(),
	number: field.number(),
	boolean: field.boolean(),
	tags: field.tags(),
	multiSelect: field.multiSelect(['a', 'b']),
	json: field.json(jsonValue),
};

describe('round-trip: recognize(field.X(...)) is kind X', () => {
	for (const kind of KINDS) {
		test(`field.${kind} recognizes back as ${kind} and matches exactly one meta`, () => {
			const rest = atRest(BUILT[kind]);
			expect(kindOf(rest)).toBe(kind);
			expect(countMatches(rest)).toBe(1);
		});
	}
});

describe('round-trip: the native enum wire-form', () => {
	test('field.select emits the native {enum:[...]} keyword at rest', () => {
		expect(atRest(field.select(['draft', 'published']))).toEqual({
			enum: ['draft', 'published'],
		});
	});

	test('field.multiSelect items carry enum (so it is multiSelect, not tags)', () => {
		const rest = atRest(field.multiSelect(['a', 'b']));
		expect(rest).toEqual({
			type: 'array',
			items: { enum: ['a', 'b'] },
		});
		expect(kindOf(rest)).toBe('multiSelect');
	});

	test('a type:"string"-pinned enum still recognizes as select', () => {
		expect(kindOf({ type: 'string', enum: ['draft', 'published'] })).toBe(
			'select',
		);
	});

	test('an empty member list degrades to raw (recognize returns null)', () => {
		expect(recognize(atRest(field.select([])))).toBeNull();
	});
});

// ============================================================================
// The palette catalog
// ============================================================================

describe('the palette catalog', () => {
	test('exactly the fourteen kinds, including blob, date, instant, json, and reference', () => {
		const expected: Kind[] = [
			'blob',
			'boolean',
			'date',
			'datetime',
			'integer',
			'instant',
			'json',
			'multiSelect',
			'number',
			'reference',
			'select',
			'string',
			'tags',
			'url',
		];
		expect([...KINDS].sort()).toEqual(expected.sort());
		expect(KINDS).toContain('json');
		expect(KINDS).toContain('reference');
	});
});

// ============================================================================
// Discrimination: every canonical schema matches exactly one meta
// ============================================================================

/** Canonical at-rest shape per kind: the minimal schema that should recognize as it. */
const CANONICAL: Record<Kind, unknown> = {
	blob: { type: 'string', 'x-blob': true },
	string: { type: 'string' },
	reference: { type: 'string', 'x-ref': 'pages' },
	url: { type: 'string', format: 'uri' },
	date: { type: 'string', format: 'date' },
	instant: {
		type: 'string',
		format: 'date-time',
		pattern: INSTANT_STRING_PATTERN,
	},
	datetime: { type: 'string', format: 'date-time' },
	select: { type: 'string', enum: ['draft', 'published'] },
	integer: { type: 'integer' },
	number: { type: 'number' },
	boolean: { type: 'boolean' },
	tags: { type: 'array', items: { type: 'string' } },
	multiSelect: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
	json: { 'x-json-schema': true },
};

describe('recognize: every canonical schema matches exactly one meta', () => {
	for (const kind of KINDS) {
		test(`${kind} canonical matches exactly one meta and recognizes as ${kind}`, () => {
			const schema = CANONICAL[kind];
			expect(countMatches(schema)).toBe(1);
			expect(kindOf(schema)).toBe(kind);
		});
	}
});

describe('the cross-discrimination pairs (the shapes that could collide)', () => {
	test('bare string is string, not url/datetime/select', () => {
		expect(kindOf({ type: 'string' })).toBe('string');
		expect(countMatches({ type: 'string' })).toBe(1);
	});

	test('a uri-format string is url, not string', () => {
		const s = { type: 'string', format: 'uri' };
		expect(kindOf(s)).toBe('url');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `format`
	});

	test('a date-format string is date, not string or datetime', () => {
		const s = { type: 'string', format: 'date' };
		expect(kindOf(s)).toBe('date');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `format`
		expect(Value.Check(META_BY_KIND.datetime, s)).toBe(false);
	});

	test('a date-time string is datetime, not string', () => {
		expect(kindOf({ type: 'string', format: 'date-time' })).toBe('datetime');
	});

	test('a fixed UTC date-time schema is instant, not datetime', () => {
		const s = {
			type: 'string',
			format: 'date-time',
			pattern: INSTANT_STRING_PATTERN,
		};
		expect(kindOf(s)).toBe('instant');
		expect(Value.Check(META_BY_KIND.datetime, s)).toBe(false); // datetime forbids `pattern`
	});

	test('a string with enum is select, not string', () => {
		const s = { type: 'string', enum: ['a', 'b'] };
		expect(kindOf(s)).toBe('select');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `enum`
	});

	test('select is string-only: an integer enum is NOT select (degrades to raw)', () => {
		const s = { type: 'integer', enum: [1, 2, 3] };
		expect(kindOf(s)).toBeNull(); // a numeric range is integer + min/max, not a select
		expect(Value.Check(META_BY_KIND.select, s)).toBe(false); // select holds strings
		expect(Value.Check(META_BY_KIND.integer, s)).toBe(false); // integer forbids `enum`
		expect(countMatches(s)).toBe(0);
	});

	test('an enum with no type is select', () => {
		expect(kindOf({ enum: ['a', 'b'] })).toBe('select');
	});

	test('a string array is tags, not multiSelect', () => {
		const s = { type: 'array', items: { type: 'string' } };
		expect(kindOf(s)).toBe('tags');
		expect(Value.Check(META_BY_KIND.multiSelect, s)).toBe(false); // items lack `enum`
	});

	test('an enum-item array is multiSelect, not tags', () => {
		const s = { type: 'array', items: { type: 'string', enum: ['a', 'b'] } };
		expect(kindOf(s)).toBe('multiSelect');
		expect(Value.Check(META_BY_KIND.tags, s)).toBe(false); // string item forbids `enum`
	});

	test('an enum-item array with no item type is multiSelect', () => {
		expect(kindOf({ type: 'array', items: { enum: ['a', 'b'] } })).toBe(
			'multiSelect',
		);
	});
});

describe('json: the marker-discriminated escape kind', () => {
	test('field.json(jsonValue) recognizes as json and accepts any JSON value', () => {
		const schema = field.json(jsonValue);
		expect(kindOf(atRest(schema))).toBe('json');
		for (const v of [1, 'x', true, null, { a: 1 }, [1, 2]]) {
			expect(Value.Check(schema, v)).toBe(true);
		}
	});

	test('field.json(inner) recognizes as json and validates the payload on read', () => {
		const schema = field.json(
			Type.Object({ author: Type.String() }, { additionalProperties: false }),
		);
		expect(kindOf(atRest(schema))).toBe('json');
		expect(Value.Check(schema, { author: 'Braden' })).toBe(true);
		expect(Value.Check(schema, { author: 42 })).toBe(false); // payload validation preserved
		expect(Value.Check(schema, 'garbage')).toBe(false);
	});

	test('a json wire-form matches exactly one meta (the open json meta)', () => {
		expect(countMatches(atRest(field.json(jsonValue)))).toBe(1);
		expect(
			countMatches(atRest(field.json(Type.Object({ author: Type.String() })))),
		).toBe(1);
	});

	test('the marker is what flips a bare object from raw to json', () => {
		// same shape, no marker -> raw; with marker -> json
		expect(kindOf({ type: 'object', properties: {} })).toBeNull();
		expect(
			kindOf({ type: 'object', properties: {}, 'x-json-schema': true }),
		).toBe('json');
	});

	test('jsonValue: field.json(Type.Array(jsonValue)) is the any-JSON-list pattern, kind json', () => {
		const schema = field.json(Type.Array(jsonValue));
		expect(kindOf(atRest(schema))).toBe('json');
		expect(countMatches(atRest(schema))).toBe(1);
		expect(Value.Check(schema, [1, 'x', null, { a: 1 }])).toBe(true);
		expect(Value.Check(schema, 'not-an-array')).toBe(false);
	});
});

describe('reference: the marker-discriminated cross-row pointer', () => {
	test('field.reference recognizes as reference and carries its target table', () => {
		const rest = atRest(field.reference('pages')) as Record<string, unknown>;
		expect(kindOf(rest)).toBe('reference');
		expect(countMatches(rest)).toBe(1);
		expect(rest['x-ref']).toBe('pages');
	});

	test('the marker is what flips a plain string into a reference', () => {
		// same string shape, no marker -> string; with marker -> reference
		expect(kindOf({ type: 'string' })).toBe('string');
		expect(kindOf({ type: 'string', 'x-ref': 'pages' })).toBe('reference');
	});

	test('a plain string is NOT a reference (the marker is required)', () => {
		expect(Value.Check(META_BY_KIND.reference, { type: 'string' })).toBe(false);
	});

	test('the string meta forbids the marker, so the two are mutually exclusive', () => {
		const s = { type: 'string', 'x-ref': 'pages' };
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids x-ref
		expect(countMatches(s)).toBe(1);
	});

	test('value validation ignores the marker and validates the value as a string', () => {
		const schema = field.reference('pages', { minLength: 1 });
		expect(Value.Check(schema, 'become-the-source')).toBe(true);
		expect(Value.Check(schema, '')).toBe(false); // minLength rides along
		expect(Value.Check(schema, 42)).toBe(false);
	});

	test('string refinements ride along without changing the kind', () => {
		const s = { type: 'string', 'x-ref': 'pages', minLength: 1 };
		expect(kindOf(s)).toBe('reference');
		expect(countMatches(s)).toBe(1);
	});

	test('the compiled value check rejects an empty reference even with no stored minLength', () => {
		// A reference points at a row by stem, so "" names no row and is never a valid pointer.
		// The floor is intrinsic to the kind: a bare {type:'string','x-ref':'pages'} (no minLength)
		// still rejects "" at the value check, so an empty pointer is INVALID, not silently OK.
		const check = compile(
			recognize({ type: 'string', 'x-ref': 'pages' })!.schema,
		);
		expect(check('become-the-source')).toBe(true);
		expect(check('')).toBe(false);
	});

	test('a larger author-set minLength is kept, not lowered to 1', () => {
		const check = compile(
			recognize({ type: 'string', 'x-ref': 'pages', minLength: 5 })!.schema,
		);
		expect(check('abcd')).toBe(false);
		expect(check('abcde')).toBe(true);
	});
});

describe('temporal value validation', () => {
	test('field.date accepts only calendar-date strings', () => {
		const schema = field.date();
		expect(Value.Check(schema, '2026-06-09')).toBe(true);
		expect(Value.Check(schema, '2026-02-30')).toBe(false);
		expect(Value.Check(schema, '2026-06-09T00:00:00.000Z')).toBe(false);
	});

	test('field.instant accepts only fixed millisecond UTC instants', () => {
		const schema = field.instant();
		expect(Value.Check(schema, '2026-06-09T14:00:00.000Z')).toBe(true);
		expect(Value.Check(schema, '2026-06-09T14:00:00Z')).toBe(false);
		expect(Value.Check(schema, '2026-06-09T14:00:00.000-05:00')).toBe(false);
		expect(Value.Check(schema, '2026-06-09T14:00:00.000z')).toBe(false);
	});
});

describe('refinements and annotations ride along without changing the kind', () => {
	test('string with minLength/pattern is still string', () => {
		const s = { type: 'string', minLength: 1, pattern: '^[a-z-]+$' };
		expect(kindOf(s)).toBe('string');
		expect(countMatches(s)).toBe(1);
	});

	test('string maxBytes counts UTF-8 bytes at the exact boundary', () => {
		const recognized = recognize(atRest(field.string({ maxBytes: 4 })));
		expect(recognized?.kind).toBe('string');
		if (recognized?.kind !== 'string')
			throw new Error('Expected string schema');
		const check = compile(recognized.schema);

		expect(check('abcd')).toBe(true);
		expect(check('abcde')).toBe(false);
		expect(check('😀')).toBe(true);
		expect(check('😀a')).toBe(false);
	});

	test('a rating (integer with min/max) is still integer', () => {
		const s = { type: 'integer', minimum: 1, maximum: 5 };
		expect(kindOf(s)).toBe('integer');
		expect(countMatches(s)).toBe(1);
	});

	test('the annotation bucket (title/description/default) does not open the shape', () => {
		const s = {
			type: 'string',
			title: 'Headline',
			description: 'the H1',
			default: 'untitled',
		};
		expect(kindOf(s)).toBe('string');
		expect(countMatches(s)).toBe(1);
	});

	test('a default rides along on a select without tipping the kind', () => {
		const s = {
			type: 'string',
			enum: ['draft', 'published'],
			default: 'draft',
		};
		expect(kindOf(s)).toBe('select');
		expect(countMatches(s)).toBe(1);
	});

	test('tags with uniqueItems is still tags', () => {
		const s = { type: 'array', items: { type: 'string' }, uniqueItems: true };
		expect(kindOf(s)).toBe('tags');
		expect(countMatches(s)).toBe(1);
	});
});

describe('the rejection lane: unsupported shapes match no meta', () => {
	const UNSUPPORTED: Array<[string, unknown]> = [
		['a typo in the type', { type: 'strng' }],
		['a typo in a refinement key', { type: 'string', minLgth: 1 }],
		['an unknown extra key', { type: 'string', foo: 1 }],
		['a plain object', { type: 'object' }],
		['an object with properties', { type: 'object', properties: {} }],
		[
			'a number array (number[] is not curated)',
			{ type: 'array', items: { type: 'number' } },
		],
		['an object array', { type: 'array', items: { type: 'object' } }],
		[
			'a nullable wrapper (emptiness is substrate policy, not vocabulary)',
			{ anyOf: [{ type: 'string' }, { type: 'null' }] },
		],
		[
			'a true multi-branch union',
			{ anyOf: [{ type: 'string' }, { type: 'integer' }] },
		],
		[
			'a date-or-instant union (input schema, not a field kind)',
			atRest(Type.Union([field.date(), field.instant()])),
		],
		[
			'an unrecognized format (email is not yet a kind)',
			{ type: 'string', format: 'email' },
		],
		// Annotations we deliberately did NOT admit: standard JSON Schema keywords with
		// no real authoring path into a field. They degrade today; the day a real schema
		// carries one and degrades is the signal to add it to ANNOT, not before.
		['examples is not admitted', { type: 'string', examples: ['x'] }],
		['$comment is not admitted', { type: 'string', $comment: 'note' }],
		['deprecated is not admitted', { type: 'string', deprecated: true }],
		['an empty object', {}],
		['a non-object', 'string'],
		['null', null],
	];

	for (const [label, schema] of UNSUPPORTED) {
		test(`${label} matches no meta and recognizes as null`, () => {
			expect(countMatches(schema)).toBe(0);
			expect(recognize(schema)).toBeNull();
		});
	}
});

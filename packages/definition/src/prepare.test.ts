/**
 * Definition Preparation Tests
 *
 * `prepareSchema` checks a declaration and returns an owned schema of the
 * same shape, without knowing which storage will use it. `check` reads values
 * through its fields, as a read, a whole-row input, or a patch.
 *
 * Key behaviors:
 * - A table goes through `defineTable`, which leaves its fields exact
 * - A prepared schema has the declared shape: records of native schemas,
 *   named by their keys, frozen and without a prototype
 * - Preparation is memoized on the declaration and on the schema it
 *   returned
 * - A schema names no dataset, so a declaration with an ID is malformed
 * - A validator belongs to a prepared snapshot, never to the author's schema:
 *   a schema reused in two declarations is prepared twice, and a schema that
 *   was never prepared is refused with an error
 * - A field is any native TypeBox schema that is plain JSON: raw,
 *   helper-built, or read back from JSON. A prepared field is a deeply frozen
 *   JSON copy, so its `JSON.stringify` is the declared schema's
 * - What a file cannot hold is refused with the path that holds it: a
 *   refinement, guard, or codec, any function, an accessor, a hidden keyword,
 *   a symbol key, a non-finite number, a hole, a non-plain object, a schema
 *   that contains itself, a `format` outside the portable set where it is
 *   a keyword, and a `$ref` that leads to no schema in the field. No callback
 *   is run to decide
 * - The schema alone decides conformance; a hint that is absent, wrong, or
 *   unknown changes the editor and nothing else
 * - Every field holds a present value to JSON before its schema runs
 * - Every mode reports one field's diagnostics the same way, and a value the
 *   check refuses is an issue even when TypeBox's error report is capped to
 *   nothing
 * - Whether a field admits `null` is asked of its check when a reader needs it
 * - `check` checks every declared field on its own. `read` ignores an
 *   undeclared key; `input` and `patch` report one. An absent required field is
 *   missing except in a `patch`, an absent optional field never is, and a key
 *   holding `undefined` is absent
 * - `field.optional` makes a field absentable; `field.nullable` over an
 *   optional schema throws. Every KV field is optional once prepared
 * - A native `default` annotation is admitted and inert: it fills nothing, and
 *   a missing required field is still an issue
 * - A frozen declared schema is prepared with every check it had
 *
 * See also:
 * - `field/field.test.ts` for the helpers and the editor resolver on their own
 */
import { expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Settings } from 'typebox/system';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	check,
	type DataSchema,
	defineTable,
	FIELD_KEYWORD,
	type FieldMap,
	field,
	fieldEditorOf,
	isOptional,
	jsonValue,
	prepareSchema,
} from './index.js';

/**
 * Prepare one bucket of fields as a definition's kv. Every KV field is
 * optional once prepared, so a test about absence uses {@link rowFields}.
 */
const prepareKv = (kv: FieldMap) => prepareSchema({ kv, tables: {} });

/** Prepare one bucket of fields as a table's, where a field may be required. */
const rowFields = (fields: FieldMap) =>
	expectOk(
		prepareSchema({
			kv: {},
			tables: { rows: defineTable({ fields }) },
		}),
	).tables.rows.fields;

/**
 * A declared field of a prepared bucket. It throws for a name the bucket does
 * not hold, so no assertion below passes on a misspelled name.
 */
function fieldOf(fields: FieldMap, name: string) {
	if (!Object.hasOwn(fields, name)) throw new Error(`no field '${name}'`);
	return fields[name] as TSchema & object;
}

/**
 * Whether one prepared field admits a present value. `undefined` is absence,
 * so it is never a value a field admits.
 */
const accepts = (schema: (TSchema & object) | undefined, value: unknown) =>
	schema !== undefined &&
	value !== undefined &&
	check({ value: schema }, { value }, 'patch').issues.length === 0;

/** Whether one prepared field of a bucket admits a present value. */
const admits = (fields: FieldMap, name: string, value: unknown) =>
	accepts(fieldOf(fields, name), value);

/** One prepared field's own diagnostics, as a write of that field reports them. */
const issuesOf = (fields: FieldMap, name: string, value: unknown) =>
	check({ [name]: fieldOf(fields, name) }, { [name]: value }, 'patch').issues;

/**
 * What a reader shows for a prepared field: the editor read from its
 * keywords, beside whether its check admits `null`.
 */
const editorOf = (fields: FieldMap, name: string) => ({
	...fieldEditorOf(fieldOf(fields, name)),
	nullable: admits(fields, name, null),
});

const editorsOf = (fields: FieldMap) =>
	Object.fromEntries(
		Object.keys(fields).map((name) => [name, editorOf(fields, name)]),
	);

const declaration: DataSchema = {
	kv: { theme: field.string() },
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
		queries: defineTable({
			fields: { name: field.string(), limit: field.nullable(field.integer()) },
		}),
	},
};

const Node = Type.Cyclic(
	{
		Node: Type.Object({
			value: Type.Number(),
			next: Type.Union([Type.Ref('Node'), Type.Null()]),
		}),
	},
	'Node',
);

// ============================================================================
// Declarations
// ============================================================================

test('a table is prepared as its fields', () => {
	const prepared = expectOk(prepareSchema(declaration));
	const queries = prepared.tables.queries?.fields ?? {};
	expect(Object.keys(queries)).toEqual(['name', 'limit']);
	expect(editorOf(queries, 'limit')).toEqual({
		kind: 'integer',
		nullable: true,
	});
	expect(admits(queries, 'limit', null)).toBe(true);
	expect(admits(queries, 'limit', '3')).toBe(false);
});

test('a prepared schema has the declared shape and nothing else', () => {
	const prepared = expectOk(
		prepareSchema({ ...declaration, title: 'Shared', extra: true } as never),
	) as DataSchema;
	expect(Object.keys(prepared)).toEqual(['title', 'kv', 'tables']);
	expect(prepared.title).toBe('Shared');
	expect(Object.keys(prepared.kv)).toEqual(['theme']);
	expect(Object.keys(prepared.tables)).toEqual(['notes', 'queries']);
	// A table is its fields. Its key is its only name.
	expect(Object.keys(prepared.tables.notes ?? {})).toEqual(['fields']);
	expect(Object.keys(prepared.tables.queries ?? {})).toEqual(['fields']);
	// A field is the native schema, hint and all, not a wrapper around one.
	expect(prepared.kv.theme).toEqual(field.string());
	expect(prepared.tables.queries?.fields.limit).toEqual(
		field.nullable(field.integer()),
	);
	expect(Object.keys(expectOk(prepareSchema(declaration)))).toEqual([
		'kv',
		'tables',
	]);
});

test('preparation is memoized on the declaration and on the schema it returned', () => {
	const first = prepareSchema(declaration);
	expect(prepareSchema(declaration)).toBe(first);
	expect(prepareSchema({ ...declaration })).not.toBe(first);
	// Preparing a prepared schema returns it, and prepares nothing again.
	const prepared = expectOk(first);
	expect(prepared).not.toBe(declaration);
	expect(prepareSchema(prepared)).toBe(first);
	expect(expectOk(prepareSchema(prepared))).toBe(prepared);
	// A refusal is memoized the same way.
	const malformed = { ...declaration, kv: { id: field.string() } };
	expect(prepareSchema(malformed)).toBe(prepareSchema(malformed));
	expectErr(prepareSchema(malformed));
});

test('a schema names no dataset, so a declaration with an id is malformed', () => {
	// @ts-expect-error A schema names no dataset.
	const named = prepareSchema({ ...declaration, id: 'so.epicenter.shared' });
	expect(expectErr(named).message).toContain('declares an id');
	expect(
		expectErr(prepareSchema({ ...declaration, id: undefined } as never)).name,
	).toBe('Malformed');
});

test('a declaration that is not an object is malformed', () => {
	for (const value of [undefined, null, 7, 'definition', []])
		expect(expectErr(prepareSchema(value as never)).name).toBe('Malformed');
});

test('an unknown table option is malformed', () => {
	const extra = expectErr(
		prepareSchema({
			...declaration,
			tables: {
				// @ts-expect-error A table declares fields and whether it is closed.
				notes: defineTable({ fields: {}, attachments: true }),
			},
		}),
	);
	expect(extra.message).toContain('unknown option');
});

test('a table closes with additionalProperties false', () => {
	const closed = {
		fields: { title: Type.String() },
		additionalProperties: false,
	} as const;
	const prepared = expectOk(
		prepareSchema({ kv: {}, tables: { notes: defineTable(closed) } }),
	);
	expect(prepared.tables.notes.additionalProperties).toBe(false);
	expect(
		expectErr(
			prepareSchema({
				kv: {},
				tables: {
					notes: defineTable({
						fields: {},
						// @ts-expect-error Only false closes a table.
						additionalProperties: true,
					}),
				},
			}),
		).message,
	).toContain('the only value is false');
});

test('field and table names keep their grammar for raw schemas', () => {
	for (const name of ['id', 'ID', '1st', 'a-b', ''])
		expect(expectErr(prepareKv({ [name]: Type.String() })).name).toBe(
			'Malformed',
		);
	expect(
		expectErr(
			prepareSchema({
				kv: {},
				tables: { kv: defineTable({ fields: { a: Type.String() } }) },
			}),
		).name,
	).toBe('Malformed');
});

test('a name that is also an Object.prototype member is an ordinary name, and __proto__ is refused', () => {
	const row = defineTable({
		fields: { constructor: field.string(), toString: field.integer() },
	});
	const prepared = expectOk(
		prepareSchema({
			kv: { constructor: field.boolean(), valueOf: field.string() },
			tables: { constructor: row, toString: row },
		}),
	);
	// The records have no prototype, so a name reads as its own entry or not at all.
	for (const record of [
		prepared.kv,
		prepared.tables,
		prepared.tables.constructor.fields,
	])
		expect(Object.getPrototypeOf(record)).toBeNull();
	expect(Object.keys(prepared.tables)).toEqual(['constructor', 'toString']);
	expect((prepared.kv as FieldMap).hasOwnProperty).toBeUndefined();
	expect(
		(prepared.tables as Record<string, unknown>).hasOwnProperty,
	).toBeUndefined();
	expect(
		(prepared.tables as Record<string, unknown>).__proto__,
	).toBeUndefined();

	const { fields } = prepared.tables.constructor;
	expect(admits(prepared.kv, 'constructor', true)).toBe(true);
	expect(admits(prepared.kv, 'constructor', 'true')).toBe(false);
	expect(
		check(fields, { constructor: 'made', toString: 2, valueOf: 1 }, 'read'),
	).toEqual({ conforming: { constructor: 'made', toString: 2 }, issues: [] });
	// A payload's inherited members are not stored values.
	expect(check(fields, {}, 'read').issues).toEqual([
		{ field: 'constructor', message: 'constructor is missing' },
		{ field: 'toString', message: 'toString is missing' },
	]);
	expect(check(fields, { constructor: 1, valueOf: 1 }, 'input').issues).toEqual(
		[
			{
				field: 'constructor',
				message: 'constructor does not conform: must be string',
			},
			{ field: 'toString', message: 'toString is missing' },
			{ field: 'valueOf', message: 'valueOf is not declared' },
		],
	);

	// An own `__proto__` key, as JSON reads one, fails the name grammar.
	for (const section of ['kv', 'tables'] as const)
		expect(
			expectErr(
				prepareSchema({
					kv: {},
					tables: {},
					[section]: JSON.parse('{"__proto__": {"type": "string"}}'),
				}),
			).name,
		).toBe('Malformed');
});

test('one declared table under two names is prepared once per name', () => {
	const shared = defineTable({
		fields: { title: field.string(), status: field.select(['open', 'done']) },
	});
	const prepared = expectOk(
		prepareSchema({
			kv: {},
			tables: { tasks: shared, archive: shared },
		}),
	);
	const { tasks, archive } = prepared.tables;
	expect(Object.keys(prepared.tables)).toEqual(['tasks', 'archive']);
	expect(tasks).not.toBe(archive);
	expect(tasks.fields).not.toBe(archive.fields);
	expect(tasks.fields.status).not.toBe(archive.fields.status);
	expect(tasks.fields.status).not.toBe(shared.fields.status);
	for (const { fields } of [tasks, archive]) {
		expect(Object.keys(fields)).toEqual(['title', 'status']);
		expect(check(fields, { title: 't', status: 'archived' }, 'read')).toEqual({
			conforming: { title: 't' },
			issues: [expect.objectContaining({ field: 'status' })],
		});
	}
});

// ============================================================================
// A field is a native schema
// ============================================================================

test('raw native schemas are prepared, validate, and get the JSON editor', () => {
	const kv = expectOk(
		prepareKv({
			meta: Type.Object(
				{ author: Type.String(), words: Type.Optional(Type.Integer()) },
				{ additionalProperties: false },
			),
			size: Type.Enum(['small', 'large']),
			anything: Type.Any(),
			maybe: Type.Union([Type.Number(), Type.Null()]),
			written: { type: 'string', minLength: 2 },
			chain: Node,
		}),
	).kv;
	const verdicts = (name: string, values: unknown[]) =>
		values.map((value) => admits(kv, name, value));

	expect(
		verdicts('meta', [
			{ author: 'a' },
			{ author: 'a', words: 2 },
			{ author: 1 },
			{ author: 'a', extra: 1 },
		]),
	).toEqual([true, true, false, false]);
	expect(verdicts('size', ['small', 'medium', 1])).toEqual([
		true,
		false,
		false,
	]);
	expect(verdicts('anything', [null, 1, 'x', { a: [1] }])).toEqual([
		true,
		true,
		true,
		true,
	]);
	expect(verdicts('maybe', [1, null, 'x'])).toEqual([true, true, false]);
	expect(verdicts('written', ['ab', 'a'])).toEqual([true, false]);
	expect(
		verdicts('chain', [
			{ value: 1, next: { value: 2, next: null } },
			{ value: 1, next: { value: '2', next: null } },
		]),
	).toEqual([true, false]);

	// No hint, so no editor is guessed: not a select for the enum, not a
	// string editor for the string.
	for (const name of Object.keys(kv))
		expect(editorOf(kv, name)).toEqual({
			kind: 'json',
			nullable: ['anything', 'maybe'].includes(name),
		});
});

test('a field that is not a schema object is refused', () => {
	for (const bare of ['string', 7, true, null, undefined, [], new Map()]) {
		// The type refuses these too; see `declaration.test-d.ts`.
		const error = expectErr(prepareKv({ title: bare as never }));
		expect(error).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'title',
		});
	}
});

test('a helper schema read back from JSON is prepared as the same field', () => {
	const declared = {
		title: field.string({ minLength: 2 }),
		page: field.nullable(field.reference('pages')),
		status: field.select(['draft', 'published']),
		labels: field.multiSelect(['a', 'b'], { uniqueItems: true }),
		due: field.nullable(field.instant()),
		day: field.date(),
		home: field.url(),
		rating: field.integer({ minimum: 1, maximum: 5 }),
		done: field.boolean(),
		tags: field.tags(),
		extra: field.json(Type.Object({ by: Type.String() })),
	};
	const original = expectOk(prepareKv(declared)).kv;
	const restored = expectOk(
		prepareKv(JSON.parse(JSON.stringify(declared)) as FieldMap),
	).kv;
	const samples = [
		null,
		true,
		3,
		9,
		2.5,
		'',
		'a',
		'draft',
		'https://epicenter.so/',
		'2026-06-09',
		'2026-06-09T14:00:00.000Z',
		[],
		['a', 'a'],
		['c'],
		{ by: 'x' },
		{ by: 1 },
		new Date(),
	];
	expect(Object.keys(restored)).toEqual(Object.keys(original));
	for (const name of Object.keys(original)) {
		expect(restored[name]).toEqual(original[name] as TSchema & object);
		expect(editorOf(restored, name)).toEqual(editorOf(original, name));
		for (const value of samples) {
			expect(admits(restored, name, value)).toBe(admits(original, name, value));
			expect(issuesOf(restored, name, value)).toEqual(
				issuesOf(original, name, value),
			);
		}
	}
	const stored = { title: 'a', status: 'archived', labels: ['a'], done: true };
	expect(check(restored, stored, 'read')).toEqual(
		check(original, stored, 'read'),
	);
});

test('a spread or rebuilt helper schema is admitted with the keywords it has', () => {
	const title = field.string({ minLength: 2 });
	const kv = expectOk(
		prepareKv({
			spread: { ...title },
			unsafe: Type.Unsafe(title),
			optioned: Type.Options(title, {}),
			handwritten: { type: 'string', [FIELD_KEYWORD]: { kind: 'string' } },
		}),
	).kv;
	for (const name of Object.keys(kv)) {
		expect(editorOf(kv, name)).toEqual({ kind: 'string', nullable: false });
		expect(admits(kv, name, 'ab')).toBe(true);
		expect(admits(kv, name, 2)).toBe(false);
	}
	expect(admits(kv, 'spread', 'a')).toBe(false);
});

// ============================================================================
// The editor
// ============================================================================

test('a prepared field resolves the editor its schema carries', () => {
	const kv = expectOk(
		prepareKv({
			status: field.nullable(field.select(['draft', 'published'])),
			page: field.nullable(field.reference('pages')),
			rating: field.integer({ minimum: 1, maximum: 5 }),
			score: field.number(),
			labels: field.multiSelect(['a', 'b']),
		}),
	).kv;
	expect(editorOf(kv, 'status')).toEqual({
		kind: 'select',
		nullable: true,
		options: ['draft', 'published'],
	});
	expect(admits(kv, 'status', null)).toBe(true);
	expect(admits(kv, 'status', 'archived')).toBe(false);
	expect(editorOf(kv, 'page')).toEqual({
		kind: 'reference',
		nullable: true,
		target: 'pages',
	});
	expect(admits(kv, 'page', '')).toBe(false);
	expect(editorOf(kv, 'labels')).toEqual({
		kind: 'multiSelect',
		nullable: false,
		options: ['a', 'b'],
	});
	expect(editorOf(kv, 'rating').kind).toBe('integer');
	expect(editorOf(kv, 'score').kind).toBe('number');
	expect(admits(kv, 'rating', 2.5)).toBe(false);
	expect(admits(kv, 'score', 2.5)).toBe(true);
	expect(admits(kv, 'score', Number.NaN)).toBe(false);
	// The hint is on the prepared schema itself, where it was declared.
	expect(fieldOf(kv, 'labels')).toMatchObject({
		[FIELD_KEYWORD]: { kind: 'multiSelect' },
	});
	expect(fieldOf(kv, 'status')).toMatchObject({
		anyOf: [{ [FIELD_KEYWORD]: { kind: 'select' } }, { type: 'null' }],
	});
});

test('a hint never changes checks, issues, or conformance', () => {
	const samples = [
		null,
		'',
		'draft',
		'archived',
		3,
		['draft'],
		{ a: 1 },
		new Date(),
		undefined,
	];
	const stored = { value: 'archived' };
	const bases: (() => TSchema)[] = [
		() => Type.Enum(['draft', 'published']),
		() => Type.String({ minLength: 1 }),
		() => Type.Union([Type.Enum(['draft', 'published']), Type.Null()]),
		() => Type.Array(Type.Enum(['draft', 'published'])),
	];
	const hints: unknown[] = [
		{ kind: 'select' },
		{ kind: 'string' },
		{ kind: 'integer' },
		{ kind: 'multiSelect' },
		{ kind: 'reference', target: 'pages' },
		{ kind: 'reference' },
		{ kind: 'blob' },
		{ kind: 'select', nullable: true, options: ['archived'] },
		'select',
		null,
		7,
	];
	for (const base of bases) {
		const plain = expectOk(prepareKv({ value: base() })).kv;
		expect(editorOf(plain, 'value').kind).toBe('json');
		for (const hint of hints) {
			const hinted = expectOk(
				prepareKv({ value: { ...base(), [FIELD_KEYWORD]: hint } }),
			).kv;
			for (const value of samples) {
				expect(admits(hinted, 'value', value)).toBe(
					admits(plain, 'value', value),
				);
				expect(issuesOf(hinted, 'value', value)).toEqual(
					issuesOf(plain, 'value', value),
				);
			}
			expect(editorOf(hinted, 'value').nullable).toBe(
				editorOf(plain, 'value').nullable,
			);
			expect(check(hinted, stored, 'read')).toEqual(
				check(plain, stored, 'read'),
			);
			expect(check(hinted, {}, 'read')).toEqual(check(plain, {}, 'read'));
			expect(check(hinted, stored, 'input').issues).toEqual(
				check(plain, stored, 'input').issues,
			);
		}
	}
});

test('a hint the schema has no shape for falls back to the JSON editor and keeps the check', () => {
	const kv = expectOk(
		prepareKv({
			count: Type.Integer({ [FIELD_KEYWORD]: { kind: 'select' } }),
			text: Type.String({ [FIELD_KEYWORD]: { kind: 'tags' } }),
			either: Type.Union([field.string(), field.integer()]),
			unknown: Type.String({ [FIELD_KEYWORD]: { kind: 'blob' } }),
		}),
	).kv;
	for (const name of Object.keys(kv))
		expect(editorOf(kv, name)).toEqual({ kind: 'json', nullable: false });
	expect(admits(kv, 'count', 1)).toBe(true);
	expect(admits(kv, 'count', '1')).toBe(false);
	expect(admits(kv, 'text', 'x')).toBe(true);
	expect(admits(kv, 'text', ['x'])).toBe(false);
	expect(admits(kv, 'either', 1.5)).toBe(false);
});

test('a conflicting, composed, or unusable hint resolves to the JSON editor and validates as the schema says', () => {
	const select = { [FIELD_KEYWORD]: { kind: 'select' } };
	const kv = expectOk(
		prepareKv({
			// A malformed root hint is not replaced by the member's select.
			rootNull: Type.Union([field.select(['a']), Type.Null()], {
				[FIELD_KEYWORD]: null,
			}),
			// An enum of strings on a numeric schema admits nothing.
			numericEnum: Type.Number({ enum: ['draft'], ...select }),
			numericItems: Type.Array(Type.Number({ enum: ['draft'] }), {
				[FIELD_KEYWORD]: { kind: 'multiSelect' },
			}),
			// A root `type` beside the union decides the field, so the member's
			// hint is not inherited and the root's is not honored.
			sibling: {
				type: 'string',
				anyOf: [Type.Number(), Type.Null()],
				[FIELD_KEYWORD]: { kind: 'number' },
			},
			inherited: { type: 'string', anyOf: [field.number(), Type.Null()] },
			badTarget: Type.String({
				[FIELD_KEYWORD]: { kind: 'reference', target: 'a | `b`' },
			}),
			// The schema's format is not the one a date widget writes.
			emailDate: Type.String({
				format: 'email',
				[FIELD_KEYWORD]: { kind: 'date' },
			}),
		}),
	).kv;
	expect(editorsOf(kv)).toEqual({
		rootNull: { kind: 'json', nullable: true },
		numericEnum: { kind: 'json', nullable: false },
		numericItems: { kind: 'json', nullable: false },
		sibling: { kind: 'json', nullable: false },
		inherited: { kind: 'json', nullable: false },
		badTarget: { kind: 'json', nullable: false },
		emailDate: { kind: 'json', nullable: false },
	});
	expect(admits(kv, 'emailDate', 'a@epicenter.so')).toBe(true);
	expect(admits(kv, 'emailDate', '2026-06-09')).toBe(false);
	expect(admits(kv, 'rootNull', 'a')).toBe(true);
	expect(admits(kv, 'rootNull', 'b')).toBe(false);
	for (const value of ['draft', 1])
		expect(admits(kv, 'numericEnum', value)).toBe(false);
	expect(admits(kv, 'numericItems', ['draft'])).toBe(false);
	expect(admits(kv, 'numericItems', [])).toBe(true);
	for (const name of ['sibling', 'inherited'])
		for (const value of ['x', 1, null])
			expect(admits(kv, name, value)).toBe(false);
	expect(admits(kv, 'badTarget', 'row')).toBe(true);
});

test('an enum edited before preparation is what the check and the options follow', () => {
	const status = field.select(['draft', 'published']);
	(status.enum as string[]).splice(0, 1, 'archived');
	const labels = field.nullable(field.multiSelect(['a', 'b']));
	(labels.anyOf[0].items.enum as string[]).push('c');
	const kv = expectOk(prepareKv({ status, labels })).kv;

	expect(editorOf(kv, 'status')).toEqual({
		kind: 'select',
		nullable: false,
		options: ['archived', 'published'],
	});
	expect(admits(kv, 'status', 'archived')).toBe(true);
	expect(admits(kv, 'status', 'draft')).toBe(false);
	expect(editorOf(kv, 'labels')).toEqual({
		kind: 'multiSelect',
		nullable: true,
		options: ['a', 'b', 'c'],
	});
	expect(admits(kv, 'labels', ['c'])).toBe(true);
});

test('whether a field admits null is what its check says, not what its keywords or hint say', () => {
	const kv = expectOk(
		prepareKv({
			helper: field.nullable(field.string()),
			plain: field.nullable(Type.Object({ a: Type.Number() })),
			native: Type.Union([Type.Null(), field.url()]),
			typed: { type: ['string', 'null'] },
			any: jsonValue,
			// No keyword names null, and the check admits it.
			anything: Type.Any(),
			required: field.string(),
			// A hint cannot make a field nullable.
			claimed: Type.String({
				[FIELD_KEYWORD]: { kind: 'string', nullable: true },
			}),
			// The union names null, and a `not` beside it refuses null.
			refused: {
				...field.nullable(field.string()),
				not: { type: 'null' },
			},
		}),
	).kv;
	expect(editorsOf(kv)).toEqual({
		helper: { kind: 'string', nullable: true },
		plain: { kind: 'json', nullable: true },
		native: { kind: 'url', nullable: true },
		typed: { kind: 'json', nullable: true },
		any: { kind: 'json', nullable: true },
		anything: { kind: 'json', nullable: true },
		required: { kind: 'string', nullable: false },
		claimed: { kind: 'string', nullable: false },
		refused: { kind: 'json', nullable: false },
	});
	// The resolver itself carries no flag, for a nullable field or any other.
	for (const name of Object.keys(kv))
		expect(fieldEditorOf(fieldOf(kv, name))).not.toHaveProperty('nullable');
	expect(admits(kv, 'plain', { a: 1 })).toBe(true);
	expect(admits(kv, 'plain', { a: '1' })).toBe(false);
	expect(admits(kv, 'refused', 'text')).toBe(true);
});

test('a hidden validation keyword is refused, at the root and nested, because a file would lose it', () => {
	const root = Type.Union([field.select(['a']), Type.Null()]);
	Object.defineProperty(root, 'type', { value: 'number' });
	const member = Type.Null();
	Object.defineProperty(member, 'enum', { value: [1] });
	const union = Type.Union([field.select(['a']), member]);

	expect(expectErr(prepareKv({ root }))).toMatchObject({
		name: 'UnrecognizedField',
		field: 'root',
		reason: '$.type is hidden',
	});
	expect(expectErr(prepareKv({ union }))).toMatchObject({
		name: 'UnrecognizedField',
		field: 'union',
		reason: '$.anyOf.1.enum is hidden',
	});
});

// ============================================================================
// Native validation
// ============================================================================

test('nested errors keep their own messages and paths', () => {
	const Author = Type.Object({ name: Type.String({ minLength: 2 }) });
	const shape = Type.Object({
		by: Author,
		tags: Type.Array(Type.String()),
	});
	const kv = expectOk(
		prepareKv({
			raw: shape,
			wrapped: field.json(shape),
			other: field.string(),
		}),
	).kv;
	const value = { by: { name: 'x' }, tags: ['a', 2] };
	const native = Compile(shape)
		.Errors(value)
		.map((error) => error.message);
	expect(native.length).toBe(2);
	for (const name of ['raw', 'wrapped']) {
		const expected = [
			{
				field: name,
				path: '/by/name',
				message: `${name} does not conform at /by/name: ${native[0]}`,
			},
			{
				field: name,
				path: '/tags/1',
				message: `${name} does not conform at /tags/1: ${native[1]}`,
			},
		];
		// A read and a write report the field's diagnostics the same way.
		expect(issuesOf(kv, name, value)).toEqual(expected);
		const issues = check(kv, { [name]: value, other: 'kept' }, 'read');
		expect(issues.conforming).toEqual({ other: 'kept' });
		expect(issues.issues.filter((issue) => issue.field === name)).toEqual(
			expected,
		);
		expect(
			check(kv, { [name]: value }, 'patch').issues.map((issue) => issue.path),
		).toEqual(['/by/name', '/tags/1']);
	}
});

test('a schema TypeBox cannot compile names its table and field', () => {
	for (const broken of [
		field.json({ type: 'string', pattern: '[' }),
		{ type: 'string', pattern: '[' },
	]) {
		const error = expectErr(prepareKv({ title: broken }));
		expect(error).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'title',
		});
		expect(error.message).toContain('regular expression');
	}
});

// ============================================================================
// A field is JSON: what a file cannot hold is refused
// ============================================================================

/** Why a single declared field is refused, as preparation reports it. */
const refusalOf = (declared: unknown) =>
	expectErr(prepareKv({ value: declared as TSchema })).reason;

test('a native refinement is refused, alone, over a helper, and nested, without being run', () => {
	let calls = 0;
	const counting = (value: unknown) => {
		calls += 1;
		return value !== null;
	};
	const refused = Type.Refine(Type.Object({ a: Type.String() }), counting);
	const cases: [TSchema, string][] = [
		[Type.Refine(Type.String(), counting), '$.~refine is a runtime callback'],
		[
			Type.Refine(field.string({ minLength: 1 }), counting),
			'$.~refine is a runtime callback',
		],
		[
			field.nullable(Type.Refine(field.reference('pages'), counting)),
			'$.anyOf.0.~refine is a runtime callback',
		],
		[field.json(refused), '$.~refine is a runtime callback'],
		[
			field.nullable(Type.Array(refused)),
			'$.anyOf.0.items.~refine is a runtime callback',
		],
		[
			Type.Object({ inner: refused }),
			'$.properties.inner.~refine is a runtime callback',
		],
	];
	for (const [declared, reason] of cases) {
		const error = expectErr(prepareKv({ value: declared }));
		expect(error).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'value',
			reason,
		});
		expect(error.message).toContain(reason);
	}
	// Nothing was validated to decide: a callback is refused for being one.
	expect(calls).toBe(0);
});

test('a guard and a codec are refused, at the root and nested', () => {
	const guard = { check: () => true, errors: () => [] };
	expect(refusalOf({ '~guard': guard, title: 'guarded' })).toBe(
		'$.~guard is a runtime callback',
	);
	expect(
		refusalOf(Type.Object({ inner: { '~guard': guard } as TSchema })),
	).toBe('$.properties.inner.~guard is a runtime callback');
	const codec = Type.Codec(Type.String())
		.Decode((value) => value)
		.Encode((value) => value);
	expect(refusalOf(codec)).toBe('$.~codec is a runtime callback');
	expect(refusalOf(Type.Array(codec))).toBe(
		'$.items.~codec is a runtime callback',
	);
});

test('a function anywhere in a declaration is refused, at a schema position or inside data', () => {
	expect(refusalOf({ type: 'string', 'x-check': () => true })).toBe(
		'$.x-check holds a runtime callback',
	);
	expect(
		refusalOf(Type.Object({ a: Type.String({ default: () => 'now' }) })),
	).toBe('$.properties.a.default holds a runtime callback');
	expect(refusalOf({ enum: ['a', () => 'b'] })).toBe(
		'$.enum.1 holds a runtime callback',
	);
});

test('an accessor is refused, even one that would read as a usable hint', () => {
	const accessor = Object.defineProperty(Type.String(), FIELD_KEYWORD, {
		enumerable: true,
		get: () => ({ kind: 'url' }),
	});
	expect(refusalOf(accessor)).toBe(`$.${FIELD_KEYWORD} is an accessor`);
	const nested = Type.Object({ a: Type.String() });
	Object.defineProperty(nested.properties.a, 'minLength', {
		enumerable: true,
		get: () => 2,
	});
	expect(refusalOf(nested)).toBe('$.properties.a.minLength is an accessor');
});

test('what JSON cannot write is refused: symbol keys, non-finite numbers, holes, a non-plain object, and a schema that contains itself', () => {
	const recursive: Record<string, unknown> = { type: 'object' };
	recursive.properties = { self: recursive };
	expect(refusalOf({ type: 'string', [Symbol('s')]: 1 })).toBe(
		'$ has symbol keys',
	);
	expect(refusalOf({ type: 'number', maximum: Number.POSITIVE_INFINITY })).toBe(
		'$.maximum is not a finite number',
	);
	expect(refusalOf({ type: 'number', minimum: Number.NaN })).toBe(
		'$.minimum is not a finite number',
	);
	// biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
	expect(refusalOf({ enum: [1, , 2] })).toBe('$.enum is sparse');
	expect(refusalOf({ type: 'string', default: new Date(0) })).toBe(
		'$.default is not plain JSON',
	);
	expect(refusalOf(recursive)).toBe('$.properties.self refers back to itself');
	// A schema shared by two properties is not a cycle; JSON writes it twice.
	const shared = { type: 'string' };
	const kv = expectOk(
		prepareKv({
			pair: { type: 'object', properties: { a: shared, b: shared } },
		}),
	).kv;
	expect(admits(kv, 'pair', { a: 'x', b: 'y' })).toBe(true);
	expect(admits(kv, 'pair', { a: 'x', b: 1 })).toBe(false);
});

test('a format outside the portable set is refused where it is a keyword, and is plain data anywhere else', () => {
	expect(refusalOf({ type: 'string', format: 'date-tme' })).toBe(
		"$.format is not a portable format: 'date-tme'",
	);
	expect(
		refusalOf(Type.Object({ due: Type.String({ format: 'date-tme' }) })),
	).toBe("$.properties.due.format is not a portable format: 'date-tme'");
	expect(
		refusalOf(Type.Array(Type.Union([Type.String({ format: 'nope' })]))),
	).toBe("$.items.anyOf.0.format is not a portable format: 'nope'");

	// Inside a data keyword, `format` is a value, not a keyword.
	// A property named `format` is a name, not a keyword.
	const kv = expectOk(
		prepareKv({
			defaulted: JSON.parse('{"default":{"format":"nope"}}'),
			data: {
				const: { format: 'x' },
				enum: [{ format: 'x' }],
				examples: [{ format: 'y' }],
			},
			named: Type.Object({ format: Type.String() }),
			portable: Type.String({ format: 'email' }),
		}),
	).kv;
	expect(admits(kv, 'defaulted', 1)).toBe(true);
	expect(admits(kv, 'data', { format: 'x' })).toBe(true);
	expect(admits(kv, 'data', { format: 'y' })).toBe(false);
	expect(admits(kv, 'named', { format: 'anything' })).toBe(true);
	expect(admits(kv, 'named', { format: 1 })).toBe(false);
	expect(admits(kv, 'portable', 'a@epicenter.so')).toBe(true);
	expect(admits(kv, 'portable', 'not an email')).toBe(false);
});

test('a reference to a definition the field does not hold is refused, naming the reference', () => {
	expect(refusalOf({ $ref: 'Missing' })).toBe(
		"$.$ref names 'Missing', which nothing in this field defines",
	);
	expect(
		refusalOf({
			$defs: { text: { type: 'string' } },
			$ref: '#/$defs/txt',
		}),
	).toBe("$.$ref names '#/$defs/txt', which nothing in this field defines");
	expect(
		refusalOf(
			Type.Object({ next: Type.Union([Type.Ref('Node'), Type.Null()]) }),
		),
	).toBe(
		"$.properties.next.anyOf.0.$ref names 'Node', which nothing in this field defines",
	);
	// A pointer to a value that is not a schema resolves to nothing usable.
	expect(
		refusalOf({ $defs: { n: { type: 'string' } }, $ref: '#/$defs/n/type' }),
	).toBe("$.$ref names '#/$defs/n/type', which is not a schema");

	// Resolved references stand, whether by `$id` or by pointer, and a `$ref`
	// inside data is a value.
	const kv = expectOk(
		prepareKv({
			chain: Node,
			pointer: {
				$defs: { text: { type: 'string', minLength: 2 } },
				$ref: '#/$defs/text',
			},
			data: { const: { $ref: 'Missing' } },
		}),
	).kv;
	expect(admits(kv, 'chain', { value: 1, next: null })).toBe(true);
	expect(admits(kv, 'pointer', 'ab')).toBe(true);
	expect(admits(kv, 'pointer', 'a')).toBe(false);
	expect(admits(kv, 'data', { $ref: 'Missing' })).toBe(true);
});

test('a prepared field is the JSON of its declaration, so the field in memory is the field a file holds', () => {
	const declared = {
		title: field.string({ minLength: 2 }),
		status: field.nullable(field.select(['draft', 'published'])),
		note: field.optional(field.nullable(field.string())),
		meta: Type.Object({
			author: Type.String(),
			words: Type.Optional(Type.Integer()),
		}),
		chain: Node,
		written: { type: 'string', maxLength: 4 },
	};
	const prepared = expectOk(
		prepareSchema({
			kv: declared,
			tables: { rows: defineTable({ fields: declared }) },
		}),
	);
	const restored = expectOk(
		prepareSchema({
			kv: JSON.parse(JSON.stringify(declared)) as FieldMap,
			tables: {
				rows: defineTable({
					fields: JSON.parse(JSON.stringify(declared)) as FieldMap,
				}),
			},
		}),
	);
	for (const fields of [
		prepared.kv,
		prepared.tables.rows.fields,
		restored.kv,
		restored.tables.rows.fields,
	])
		for (const [name, schema] of Object.entries(declared)) {
			expect(JSON.stringify(fieldOf(fields, name))).toBe(
				JSON.stringify(schema),
			);
			// Only the optional marker is kept hidden; TypeBox's others are dropped.
			expect(
				Object.getOwnPropertyNames(fieldOf(fields, name)).filter((key) =>
					key.startsWith('~'),
				),
			).toEqual(isOptional(fieldOf(fields, name)) ? ['~optional'] : []);
		}
	// A present value is checked the same from the file as from memory.
	const rows = prepared.tables.rows.fields;
	const fromFile = restored.tables.rows.fields;
	const values = [null, 'ab', 'a', 'draft', { author: 'a', words: 'x' }, 3];
	for (const name of Object.keys(declared))
		for (const value of values)
			expect(issuesOf(fromFile, name, value)).toEqual(
				issuesOf(rows, name, value),
			);
	// Whether a row field may be absent is not in its JSON: the file that holds
	// a table says it with `required`, and the storage that reads it applies
	// `field.optional`. A KV field is optional wherever it came from.
	expect(isOptional(fieldOf(rows, 'note'))).toBe(true);
	expect(isOptional(fieldOf(fromFile, 'note'))).toBe(false);
	expect(isOptional(fieldOf(restored.kv, 'note'))).toBe(true);
	expect(isOptional(fieldOf(restored.kv, 'title'))).toBe(true);
});

// ============================================================================
// JSON safety
// ============================================================================

const loop: Record<string, unknown> = { value: 1 };
loop.next = loop;

class Point {
	x = 1;
}

test('every field holds a value to JSON, whatever its schema admits', () => {
	// The control: these native schemas alone admit a Date.
	expect(Compile(Type.Any()).Check(new Date())).toBe(true);
	expect(Compile(Type.Object({})).Check(new Point())).toBe(true);

	const kv = expectOk(
		prepareKv({
			any: Type.Any(),
			unknown: Type.Unknown(),
			open: jsonValue,
			wrapped: field.json(jsonValue),
			object: Type.Object({}),
			unsafe: Type.Unsafe<Date>({}),
			optional: field.nullable(jsonValue),
			list: Type.Array(Type.Any()),
		}),
	).kv;
	// `undefined` is absence, not a value; see the absence tests.
	const unsafe = [
		new Date(),
		Number.NaN,
		Number.POSITIVE_INFINITY,
		loop,
		new Point(),
		new Map(),
		() => 1,
		1n,
		Symbol('s'),
		{ nested: [new Date()] },
		{ nested: undefined },
		[undefined],
		[new Date()],
	];
	for (const name of Object.keys(kv)) {
		for (const value of unsafe) {
			expect(admits(kv, name, value)).toBe(false);
			expect(issuesOf(kv, name, value)).toEqual([
				{
					field: name,
					message: `${name} does not conform: must be a JSON value`,
				},
			]);
			expect(check(kv, { [name]: value } as never, 'read')).toMatchObject({
				conforming: {},
			});
			expect(check(kv, { [name]: value }, 'patch').issues).toEqual([
				{
					field: name,
					message: `${name} does not conform: must be a JSON value`,
				},
			]);
		}
	}
	for (const name of ['any', 'unknown', 'open', 'wrapped', 'optional'])
		for (const value of [1, 'x', true, null, { a: [1, null] }, [1, 2]]) {
			expect(admits(kv, name, value)).toBe(true);
			expect(issuesOf(kv, name, value)).toEqual([]);
		}

	// A storage hands conformance whatever it read; the cast stands in for that.
	const stored = { open: new Date(), any: 1, optional: null } as never;
	const result = check(kv, stored, 'read');
	expect(result.conforming).toEqual({ any: 1, optional: null });
	expect(result.issues).toContainEqual({
		field: 'open',
		message: 'open does not conform: must be a JSON value',
	});
});

test('a cyclic value stops at the JSON check and never reaches a recursive schema', () => {
	// The control: the recursive schema alone overflows on a cyclic value.
	expect(() => Compile(Node).Check(loop)).toThrow(RangeError);
	expect(() => Compile(Node).Errors(loop)).toThrow(RangeError);

	const kv = expectOk(
		prepareKv({
			raw: Node,
			wrapped: field.json(Node),
			optional: field.nullable(Node),
		}),
	).kv;

	for (const name of Object.keys(kv)) {
		expect(admits(kv, name, loop)).toBe(false);
		const stored = { [name]: loop } as never;
		expect(check(kv, stored, 'read').conforming).toEqual({});
		expect(
			check(kv, stored, 'read').issues.filter((issue) => issue.field === name),
		).toEqual([
			{
				field: name,
				message: `${name} does not conform: must be a JSON value`,
			},
		]);
		expect(check(kv, { [name]: loop }, 'patch').issues).toEqual([
			{
				field: name,
				message: `${name} does not conform: must be a JSON value`,
			},
		]);
	}

	const chain = { value: 1, next: { value: 2, next: null } };
	const wrong = { value: 1, next: { value: 'two', next: null } };
	for (const name of Object.keys(kv)) {
		expect(admits(kv, name, chain)).toBe(true);
		expect(issuesOf(kv, name, chain)).toEqual([]);
		expect(admits(kv, name, wrong)).toBe(false);
		expect(issuesOf(kv, name, wrong)).not.toEqual([]);
	}
});

test('a shared acyclic value passes; being JSON has no depth or width', () => {
	const shared = { value: 2, next: null };
	const dag = { left: shared, right: shared, both: [shared, shared] };
	const wide = Object.fromEntries(
		Array.from({ length: 1025 }, (_, index) => [`key${index}`, index]),
	);
	let deep: unknown = 'bottom';
	for (let level = 0; level < 100_000; level++) deep = [deep];

	const kv = expectOk(
		prepareKv({
			open: jsonValue,
			pair: Type.Object({ left: Node, right: Node, both: Type.Array(Node) }),
			chain: Node,
		}),
	).kv;
	for (const value of [dag, wide, deep]) {
		expect(admits(kv, 'open', value)).toBe(true);
		expect(issuesOf(kv, 'open', value)).toEqual([]);
	}
	expect(admits(kv, 'pair', dag)).toBe(true);
	// The same node at two depths of one chain is shared, not a cycle.
	expect(admits(kv, 'chain', { value: 1, next: shared })).toBe(true);
	expect(check(kv, { open: dag, pair: dag } as never, 'read')).toMatchObject({
		conforming: { open: dag, pair: dag },
	});
});

// ============================================================================
// Conformance
// ============================================================================

test('conformance checks every field on its own, however many fail', () => {
	const names = Array.from({ length: 12 }, (_, index) => `field${index}`);
	const kv = rowFields({
		...Object.fromEntries(names.map((name) => [name, field.integer()])),
		kept: field.string(),
		payload: Type.Object({ a: Type.String() }),
		absent: field.nullable(field.string()),
	});
	const payload = {
		...Object.fromEntries(names.map((name) => [name, 'not a number'])),
		kept: 'still here',
		payload: { a: 'x' },
		undeclared: true,
	};
	const { conforming, issues } = check(kv, payload, 'read');
	expect(conforming).toEqual({ kept: 'still here', payload: { a: 'x' } });
	expect(issues.map((issue) => issue.field)).toEqual([...names, 'absent']);
	expect(issues[0]).toEqual({
		field: 'field0',
		message: 'field0 does not conform: must be integer',
	});
	expect(issues.at(-1)).toEqual({
		field: 'absent',
		message: 'absent is missing',
	});
});

test('a value the check refuses is an issue and not conforming when TypeBox reports no errors', () => {
	// `maxErrors` caps what `Errors` collects and is process-wide, so it is put
	// back whatever happens here.
	const { maxErrors } = Settings.Get();
	Settings.Set({ maxErrors: 0 });
	try {
		// The control: the native validator refuses the value and says nothing.
		const native = Compile(Type.Integer());
		expect(native.Check('x')).toBe(false);
		expect(native.Errors('x')).toEqual([]);

		const kv = expectOk(
			prepareKv({ count: field.integer(), kept: field.string() }),
		).kv;
		const undiagnosed = [{ field: 'count', message: 'count does not conform' }];
		expect(admits(kv, 'count', 'x')).toBe(false);
		expect(issuesOf(kv, 'count', 'x')).toEqual(undiagnosed);
		expect(check(kv, { count: 'x', kept: 'still here' }, 'read')).toEqual({
			conforming: { kept: 'still here' },
			issues: undiagnosed,
		});
		expect(check(kv, { count: 'x' }, 'patch').issues).toEqual(undiagnosed);
		expect(check(kv, { count: 1, kept: 'k' }, 'read').issues).toEqual([]);
	} finally {
		Settings.Set({ maxErrors });
	}
	expect(Compile(Type.Integer()).Errors('x')).not.toEqual([]);
});

test('a native default annotation is admitted and validates like the schema without it', () => {
	const declared = {
		root: Type.String({ minLength: 2, default: 'untitled' }),
		spread: { ...field.string({ minLength: 2 }), default: 'untitled' },
		nested: Type.Object({
			theme: Type.String({ default: 'light' }),
			size: Type.Optional(Type.Integer({ default: 12 })),
		}),
		list: field.json(
			Type.Array(Type.String({ default: 'x' }), { default: [] }),
		),
		optional: field.nullable(Type.Integer({ default: 0 })),
		referenced: {
			$defs: { text: { type: 'string', default: '' } },
			$ref: '#/$defs/text',
		},
	};
	const kv = expectOk(prepareKv(declared)).kv;
	const verdicts = (name: string, values: unknown[]) =>
		values.map((value) => admits(kv, name, value));

	expect(verdicts('root', ['ab', 'a', 3])).toEqual([true, false, false]);
	expect(verdicts('spread', ['ab', 'a'])).toEqual([true, false]);
	expect(
		verdicts('nested', [
			{ theme: 'dark' },
			{ theme: 'dark', size: 14 },
			// A nested default does not stand in for a required property.
			{},
			{ size: 14 },
			{ theme: 'dark', size: 'big' },
		]),
	).toEqual([true, true, false, false, false]);
	expect(verdicts('list', [[], ['a'], [1]])).toEqual([true, true, false]);
	expect(verdicts('optional', [null, 1, 'x'])).toEqual([true, true, false]);
	expect(verdicts('referenced', ['', 1])).toEqual([true, false]);

	// The annotation is kept on the prepared schema and changes no editor.
	expect(fieldOf(kv, 'root')).toMatchObject({ default: 'untitled' });
	expect(editorOf(kv, 'spread')).toEqual({ kind: 'string', nullable: false });
});

test('a default initializes and recovers nothing: missing values stay missing and no payload is changed', () => {
	const kv = rowFields({
		title: Type.String({ default: 'untitled' }),
		settings: Type.Object({
			theme: Type.String({ default: 'light' }),
			size: Type.Optional(Type.Integer({ default: 12 })),
		}),
		count: field.nullable(Type.Integer({ default: 0 })),
	});

	// An absent required field is missing, default or not.
	expect(check(kv, {}, 'read')).toEqual({
		conforming: {},
		issues: ['title', 'settings', 'count'].map((name) => ({
			field: name,
			message: `${name} is missing`,
		})),
	});
	expect(
		check(kv, { title: 'T' }, 'input').issues.map(({ field }) => field),
	).toEqual(['settings', 'count']);

	// A value that fails is reported, not replaced by the default.
	const stored = Object.freeze({
		title: 7,
		settings: Object.freeze({}),
		count: null,
	});
	const before = JSON.stringify(stored);
	const result = check(kv, stored, 'read');
	expect(result.conforming).toEqual({ count: null });
	expect([...new Set(result.issues.map(({ field }) => field))]).toEqual([
		'title',
		'settings',
	]);
	expect(admits(kv, 'title', undefined)).toBe(false);
	expect(issuesOf(kv, 'settings', {})).not.toEqual([]);
	check(kv, stored, 'input').issues;

	// A value that passes comes back as the same object, with nothing filled in.
	const partial = Object.freeze({ theme: 'dark' });
	const kept = check(kv, { title: 'T', settings: partial, count: 1 }, 'read');
	expect(kept.issues).toEqual([]);
	expect(kept.conforming.settings).toBe(partial);
	expect(partial).toEqual({ theme: 'dark' });
	expect(JSON.stringify(stored)).toBe(before);
});

test('a property, a literal, and an option named default are ordinary names', () => {
	const kv = expectOk(
		prepareKv({
			settings: Type.Object({
				default: Type.String(),
				nested: Type.Object({ default: Type.Boolean() }),
			}),
			choice: Type.Literal('default'),
			named: field.select(['default', 'custom']),
		}),
	).kv;
	expect(
		admits(kv, 'settings', { default: 'light', nested: { default: true } }),
	).toBe(true);
	expect(admits(kv, 'settings', { default: 1 })).toBe(false);
	expect(admits(kv, 'named', 'default')).toBe(true);
});

// ============================================================================
// The frozen snapshot
// ============================================================================

test('a frozen declared schema is prepared with every check it had', () => {
	// A select narrowed by a keyword the helper does not set.
	const refined = Object.freeze({
		...field.select(['draft', 'done']),
		not: { const: 'done' },
	});
	const declared = {
		helper: Object.freeze(field.select(['draft', 'done'])),
		refined,
		// Annotated again from a frozen helper, then frozen again.
		wrapped: Object.freeze(field.json(refined)),
		optional: Object.freeze(field.nullable(refined)),
	};
	const kv = expectOk(prepareKv(declared)).kv;
	const verdicts = (name: string) =>
		['draft', 'done', 'archived', null].map((value) => admits(kv, name, value));

	expect(verdicts('helper')).toEqual([true, true, false, false]);
	expect(verdicts('refined')).toEqual([true, false, false, false]);
	expect(verdicts('wrapped')).toEqual([true, false, false, false]);
	expect(verdicts('optional')).toEqual([true, false, false, true]);
	expect(editorsOf(kv)).toEqual({
		helper: { kind: 'select', nullable: false, options: ['draft', 'done'] },
		// A composition keyword beside the hint gives the JSON editor.
		refined: { kind: 'json', nullable: false },
		wrapped: { kind: 'json', nullable: false },
		optional: { kind: 'json', nullable: true },
	});
	// The declared schemas are as they were, and the prepared ones are copies.
	expect(declared.helper['x-field']).toEqual({ kind: 'select' });
	expect(refined['x-field']).toEqual({ kind: 'select' });
	for (const [name, schema] of Object.entries(kv)) {
		expect(schema).not.toBe(declared[name as keyof typeof declared]);
		expect(Object.isFrozen(schema)).toBe(true);
	}
});

test('a prepared field is a frozen snapshot, so later edits change nothing', () => {
	const options = ['draft', 'published'];
	const payload = Type.Object({ a: Type.String() });
	const declared = {
		status: field.select(options),
		payload,
		wrapped: field.json(payload),
		refined: field.string({ maxLength: 2 }),
		optional: field.nullable(field.reference('pages')),
	};
	const kv = expectOk(prepareKv(declared)).kv;

	// Everything the author still holds is an ordinary mutable schema.
	options.push('archived');
	Object.assign(payload.properties, { a: Type.Number() });
	(declared.status.enum as string[]).push('archived');
	Object.assign(declared.status, { [FIELD_KEYWORD]: { kind: 'string' } });
	Object.assign(declared.optional.anyOf[0], {
		[FIELD_KEYWORD]: { kind: 'reference', target: 'elsewhere' },
	});
	declared.optional.anyOf.pop();
	Object.assign(declared.refined, { maxLength: 1 });

	expect(admits(kv, 'status', 'archived')).toBe(false);
	expect(editorOf(kv, 'status')).toEqual({
		kind: 'select',
		nullable: false,
		options: ['draft', 'published'],
	});
	expect(editorOf(kv, 'optional')).toEqual({
		kind: 'reference',
		nullable: true,
		target: 'pages',
	});
	expect(admits(kv, 'optional', null)).toBe(true);
	for (const name of ['payload', 'wrapped']) {
		expect(admits(kv, name, { a: 'x' })).toBe(true);
		expect(admits(kv, name, { a: 1 })).toBe(false);
	}

	// The check and its issues read the same snapshot, so they agree.
	expect(admits(kv, 'refined', 'ab')).toBe(true);
	expect(issuesOf(kv, 'refined', 'ab')).toEqual([]);
	expect(admits(kv, 'refined', 'abc')).toBe(false);
	expect(issuesOf(kv, 'refined', 'abc')).not.toEqual([]);

	for (const [name, schema] of Object.entries(kv)) {
		expect(schema).not.toBe(declared[name as keyof typeof declared]);
		expect(Object.isFrozen(schema)).toBe(true);
		expect(Object.isFrozen(fieldEditorOf(schema))).toBe(true);
		expect(() => {
			(schema as { maxLength?: number }).maxLength = 0;
		}).toThrow();
	}
	const status = fieldOf(kv, 'status');
	expect(() =>
		(fieldEditorOf(status) as unknown as { options: string[] }).options.push(
			'x',
		),
	).toThrow();
	// The freeze is deep: every node of the snapshot, not just its root.
	expect(Object.isFrozen((status as unknown as { enum: string[] }).enum)).toBe(
		true,
	);
	const optional = fieldOf(kv, 'optional') as unknown as {
		anyOf: Record<string, unknown>[];
	};
	expect(Object.isFrozen(optional.anyOf)).toBe(true);
	expect(Object.isFrozen(optional.anyOf[0])).toBe(true);
	expect(Object.isFrozen(optional.anyOf[0]?.[FIELD_KEYWORD])).toBe(true);
});

test('a prepared definition and its records cannot be changed', () => {
	const prepared = expectOk(prepareSchema(declaration));
	const notes = prepared.tables.notes;
	for (const owned of [
		prepared,
		prepared.kv,
		prepared.tables,
		notes,
		notes?.fields,
		notes?.fields.title,
	])
		expect(Object.isFrozen(owned)).toBe(true);
	const writes: (() => void)[] = [
		() => Object.assign(prepared, { id: 'so.epicenter.other' }),
		() => Object.assign(prepared.kv, { added: field.string() }),
		() => Object.assign(prepared.kv, { theme: field.integer() }),
		() => Object.assign(prepared.tables, { added: notes }),
		() => Object.assign(notes ?? {}, { additionalProperties: false }),
		() => Object.assign(notes?.fields ?? {}, { title: field.integer() }),
		() => Object.assign(notes?.fields.title ?? {}, { minLength: 9 }),
		() => {
			delete (prepared.kv as Record<string, unknown>).theme;
		},
	];
	for (const write of writes) expect(write).toThrow(TypeError);
	expect(Object.keys(prepared.kv)).toEqual(['theme']);
	expect(admits(prepared.kv, 'theme', 'dark')).toBe(true);
	expect(admits(notes?.fields ?? {}, 'title', 'short')).toBe(true);
	// The declaration the author holds is theirs, and is not frozen.
	expect(Object.isFrozen(declaration.kv)).toBe(false);
	expect(Object.isFrozen(declaration.kv.theme)).toBe(false);
});

test('a schema reused in a second definition after an edit is prepared again, apart from the first', () => {
	const status = field.select(['draft', 'published']);
	const limit = field.integer({ maximum: 9 });
	const first = expectOk(prepareKv({ status, limit })).kv;

	// The author edits the schemas they still hold, then declares them again.
	(status.enum as string[]).push('archived');
	Object.assign(limit, { minimum: 5 });
	const second = expectOk(prepareKv({ status, limit })).kv;

	for (const name of ['status', 'limit']) {
		expect(fieldOf(second, name)).not.toBe(fieldOf(first, name));
		expect(fieldOf(first, name)).not.toBe({ status, limit }[name]);
	}
	// Two validators: each definition reads through its own snapshot.
	expect(admits(first, 'status', 'archived')).toBe(false);
	expect(admits(second, 'status', 'archived')).toBe(true);
	expect(admits(first, 'limit', 3)).toBe(true);
	expect(admits(second, 'limit', 3)).toBe(false);
	expect(admits(second, 'limit', 12)).toBe(false);
	expect(editorOf(first, 'status')).toMatchObject({
		options: ['draft', 'published'],
	});
	expect(editorOf(second, 'status')).toMatchObject({
		options: ['draft', 'published', 'archived'],
	});
	expect(
		check(first, { status: 'archived', limit: 3 }, 'read').conforming,
	).toEqual({ limit: 3 });
	expect(
		check(second, { status: 'archived', limit: 7 }, 'read').conforming,
	).toEqual({ status: 'archived', limit: 7 });

	// One schema under two names of one definition is two snapshots too.
	const twice = expectOk(prepareKv({ a: status, b: status })).kv;
	expect(fieldOf(twice, 'a')).not.toBe(fieldOf(twice, 'b'));
});

test('a schema that was never prepared is refused with an error, not validated and not answered false', () => {
	const raw = field.string();
	const refusal = 'This schema was not prepared';
	expect(() => accepts(raw, 'text')).toThrow(refusal);
	expect(() => check({ title: raw }, { title: 'text' }, 'read')).toThrow(
		refusal,
	);
	expect(
		() => check({ title: raw }, { title: 'text' }, 'patch').issues,
	).toThrow(refusal);
	// Preparing it elsewhere prepares a copy: the author's object is still raw.
	const prepared = expectOk(prepareKv({ title: raw })).kv;
	expect(admits(prepared, 'title', 'text')).toBe(true);
	expect(() => accepts(raw, 'text')).toThrow(refusal);
	// A structurally equal copy of a prepared schema is not that schema.
	expect(() => accepts({ ...fieldOf(prepared, 'title') }, 'text')).toThrow(
		refusal,
	);

	// A name the definition does not declare has no schema, and accepts nothing.
	expect(accepts(prepared.absent, 'text')).toBe(false);
	expect(accepts(undefined, null)).toBe(false);
	// Nothing is read from a field map that declares nothing.
	expect(check({}, { title: 'text' }, 'read')).toEqual({
		conforming: {},
		issues: [],
	});
});

test('undefined annotations do not stop freezing a prepared snapshot', () => {
	const declared = Type.Object(
		{ a: Type.String() },
		{ description: undefined },
	);
	const kv = expectOk(prepareKv({ value: declared })).kv;
	const schema = fieldOf(kv, 'value') as unknown as {
		properties: { a: { minLength?: number } };
	};
	expect(Object.isFrozen(schema.properties)).toBe(true);
	expect(Object.isFrozen(schema.properties.a)).toBe(true);
	expect(() => {
		schema.properties.a.minLength = 10;
	}).toThrow();
	expect(admits(kv, 'value', { a: 'x' })).toBe(true);
	expect(issuesOf(kv, 'value', { a: 'x' })).toEqual([]);
});

// ============================================================================
// Conformance and input issues on one table
// ============================================================================

const checked: FieldMap = expectOk(
	prepareSchema({
		kv: {},
		tables: {
			rows: defineTable({
				fields: {
					title: field.string({ maxLength: 4 }),
					due: field.nullable(field.instant()),
					parent: field.reference('rows'),
					tags: field.tags(),
					extra: Type.Object({ 'a/b': Type.Array(Type.Integer()) }),
				},
			}),
		},
	}),
).tables.rows.fields;
const conforming = {
	title: 'Milk',
	due: null,
	parent: 'row',
	tags: ['a'],
	extra: { 'a/b': [1] },
};

test('each declared field is checked by itself, and an undeclared key is not an issue', () => {
	expect(check(checked, { ...conforming, unknown: 1 }, 'read')).toEqual({
		conforming,
		issues: [],
	});
	const partial = check(
		checked,
		{
			...conforming,
			title: 3,
			due: 'soon',
		},
		'read',
	);
	// A field that fails does not take a field that validated with it.
	expect(partial.conforming).toEqual({
		parent: 'row',
		tags: ['a'],
		extra: { 'a/b': [1] },
	});
	expect([...new Set(partial.issues.map((issue) => issue.field))]).toEqual([
		'title',
		'due',
	]);
	expect(check(checked, {}, 'read').issues.map((issue) => issue.field)).toEqual(
		Object.keys(conforming),
	);
});

test('issues agree with the value check for null, an empty reference, and a length limit', () => {
	const issuesFor = (values: Record<string, unknown>) =>
		check(checked, { ...conforming, ...values }, 'read').issues;
	expect(admits(checked, 'title', 'Milky')).toBe(false);
	expect(issuesFor({ title: 'Milky' })).toEqual([
		expect.objectContaining({ field: 'title' }),
	]);
	expect(issuesFor({ title: 'Milk' })).toEqual([]);
	expect(admits(checked, 'parent', '')).toBe(false);
	expect(issuesFor({ parent: '' })).toHaveLength(1);
	expect(issuesFor({ due: null })).toEqual([]);
	// Only a nullable field accepts null.
	expect(issuesFor({ title: null }).map((issue) => issue.field)).toEqual([
		'title',
	]);
	for (const name of Object.keys(checked))
		for (const value of [null, '', 'Milky', 3, [], ['a', 3], {}, new Date()])
			expect(
				issuesFor({ [name]: value }).filter((issue) => issue.field === name)
					.length === 0,
			).toBe(admits(checked, name, value));
});

test('a nested pointer is reported only where it names a location in the value', () => {
	const tags = check(
		checked,
		{ ...conforming, tags: ['a', 3, 'c', 4] },
		'read',
	);
	expect(tags.issues.map(({ field, path }) => ({ field, path }))).toEqual([
		{ field: 'tags', path: '/1' },
		{ field: 'tags', path: '/3' },
	]);
	expect(tags.conforming).not.toHaveProperty('tags');
	// The validator joins keys unescaped, so `/a/b/1` names nothing here.
	const extra = check(
		checked,
		{
			...conforming,
			extra: { 'a/b': [1, 'x'] },
		},
		'read',
	);
	expect(extra.issues).toHaveLength(1);
	expect(extra.issues[0]).not.toHaveProperty('path');
	// A whole-value failure carries no pointer.
	expect(
		check(checked, { ...conforming, tags: 'a' }, 'read').issues[0],
	).toEqual({
		field: 'tags',
		message: expect.stringContaining('tags'),
	});
});

test('supplied values are refused when undeclared or nonconforming, and a complete row when a field is absent', () => {
	expect(check(checked, { title: 'Milk' }, 'patch').issues).toEqual([]);
	expect(
		check(checked, { title: 3, other: 1 }, 'patch').issues.map(
			(issue) => issue.field,
		),
	).toEqual(['title', 'other']);
	expect(
		check(checked, { title: 'Milk', due: null }, 'input').issues.map(
			(issue) => issue.field,
		),
	).toEqual(['parent', 'tags', 'extra']);
	expect(check(checked, conforming, 'input').issues).toEqual([]);
	const { title: _title, ...withoutTitle } = conforming;
	expect(check(checked, withoutTitle, 'input').issues).toEqual([
		{ field: 'title', message: 'title is missing' },
	]);
});

// ============================================================================
// Absence: required, optional, and the three check modes
// ============================================================================

const MODES = ['read', 'input', 'patch'] as const;

test('the three modes differ only in undeclared keys and absent required fields', () => {
	const fields = rowFields({
		title: field.string(),
		note: field.optional(field.string()),
	});
	const verdict = (values: Record<string, unknown>) =>
		Object.fromEntries(
			MODES.map((mode) => [mode, check(fields, values, mode).issues]),
		);
	const missing = { field: 'title', message: 'title is missing' };
	const undeclared = { field: 'other', message: 'other is not declared' };

	// An undeclared key: ignored by a read, an issue in a write.
	expect(verdict({ title: 't', other: 1 })).toEqual({
		read: [],
		input: [undeclared],
		patch: [undeclared],
	});
	expect(check(fields, { title: 't', other: 1 }, 'read').conforming).toEqual({
		title: 't',
	});
	// An absent required field: an issue except in a patch.
	expect(verdict({})).toEqual({ read: [missing], input: [missing], patch: [] });
	expect(verdict({ other: 1 })).toEqual({
		read: [missing],
		input: [missing, undeclared],
		patch: [undeclared],
	});
	// A present value is checked the same way in every mode.
	for (const mode of MODES)
		expect(check(fields, { title: 1, note: 't' }, mode)).toEqual({
			conforming: { note: 't' },
			issues: [
				{ field: 'title', message: 'title does not conform: must be string' },
			],
		});
});

test('a key holding undefined is absent in every mode, declared or not', () => {
	const fields = rowFields({
		title: field.string(),
		note: field.optional(field.string()),
	});
	const values = { title: undefined, note: undefined, other: undefined };
	expect(check(fields, values, 'read')).toEqual({
		conforming: {},
		issues: [{ field: 'title', message: 'title is missing' }],
	});
	expect(check(fields, values, 'input')).toEqual({
		conforming: {},
		issues: [{ field: 'title', message: 'title is missing' }],
	});
	expect(check(fields, values, 'patch')).toEqual({
		conforming: {},
		issues: [],
	});
	// The same as leaving the keys out, in every mode.
	for (const mode of MODES)
		expect(check(fields, values, mode)).toEqual(check(fields, {}, mode));
	// `undefined` is never a value a field admits, even one that admits anything.
	expect(admits(rowFields({ any: Type.Any() }), 'any', undefined)).toBe(false);
});

test('field.optional lets a row leave a field out and still checks it when present', () => {
	const fields = rowFields({
		title: field.string(),
		note: field.optional(field.string({ minLength: 2 })),
		raw: Type.Optional(Type.Integer()),
	});
	expect(isOptional(fieldOf(fields, 'note'))).toBe(true);
	expect(isOptional(fieldOf(fields, 'raw'))).toBe(true);
	expect(isOptional(fieldOf(fields, 'title'))).toBe(false);
	// Absent conforms in a read and in a whole-row write.
	for (const mode of ['read', 'input'] as const)
		expect(check(fields, { title: 't' }, mode)).toEqual({
			conforming: { title: 't' },
			issues: [],
		});
	// Present but wrong still fails, with the inner schema's own error.
	expect(check(fields, { title: 't', note: 'x', raw: 1.5 }, 'input')).toEqual({
		conforming: { title: 't' },
		issues: [
			expect.objectContaining({ field: 'note' }),
			expect.objectContaining({ field: 'raw' }),
		],
	});
	expect(admits(fields, 'note', 'xy')).toBe(true);
	// It changes nothing about its siblings: an absent required field is missing.
	expect(check(fields, { note: 'xy' }, 'input').issues).toEqual([
		{ field: 'title', message: 'title is missing' },
	]);
	// Optional is not nullable.
	expect(admits(fields, 'note', null)).toBe(false);
	// The editor reads through it.
	expect(editorOf(fields, 'note')).toEqual({ kind: 'string', nullable: false });
});

test('optional and nullable compose one way: absent and null stay distinct', () => {
	const fields = rowFields({
		title: field.string(),
		note: field.optional(field.nullable(field.select(['a', 'b']))),
		due: field.nullable(field.instant()),
	});
	expect(isOptional(fieldOf(fields, 'note'))).toBe(true);
	expect(isOptional(fieldOf(fields, 'due'))).toBe(false);
	expect(editorOf(fields, 'note')).toEqual({
		kind: 'select',
		nullable: true,
		options: ['a', 'b'],
	});
	// The optional nullable field may be absent or null.
	expect(check(fields, { title: 't', due: null }, 'input').issues).toEqual([]);
	expect(
		check(fields, { title: 't', note: null, due: null }, 'input').issues,
	).toEqual([]);
	expect(admits(fields, 'note', 'c')).toBe(false);
	// A nullable field admits null, and absence is still missing.
	expect(check(fields, { title: 't' }, 'input').issues).toEqual([
		{ field: 'due', message: 'due is missing' },
	]);
	// The other order is refused where it is written.
	expect(() => field.nullable(field.optional(field.string()))).toThrow(
		'field.optional(field.nullable(inner))',
	);
	expect(() => field.nullable(Type.Optional(Type.String()))).toThrow(TypeError);
});

test('field.optional copies the schema it is given', () => {
	const inner = field.string({ minLength: 2 });
	const optional = field.optional(inner);
	expect(optional).not.toBe(inner);
	expect(isOptional(optional)).toBe(true);
	expect(isOptional(inner)).toBe(false);
	expect(JSON.stringify(optional)).toBe(JSON.stringify(inner));
	expect(() => field.optional('string' as never)).toThrow('needs a schema');
});

test('every KV field is optional once prepared, and the declaration is left as written', () => {
	const declared = {
		theme: field.select(['light', 'dark']),
		width: Type.Integer(),
		note: field.optional(field.string()),
	};
	const kv = expectOk(prepareKv(declared)).kv;
	for (const name of Object.keys(declared))
		expect(isOptional(fieldOf(kv, name))).toBe(true);
	expect(isOptional(declared.theme)).toBe(false);
	// An unset key is the application's default, never an issue.
	for (const mode of MODES)
		expect(check(kv, {}, mode)).toEqual({ conforming: {}, issues: [] });
	// A set key is still checked, and an undeclared one is still a write issue.
	expect(check(kv, { theme: 'blue', other: 1 }, 'input').issues).toEqual([
		expect.objectContaining({ field: 'theme' }),
		{ field: 'other', message: 'other is not declared' },
	]);
	expect(check(kv, { width: 3 }, 'read').conforming).toEqual({ width: 3 });
	// The same schema in a table stays required there.
	const fields = rowFields(declared);
	expect(isOptional(fieldOf(fields, 'theme'))).toBe(false);
	expect(isOptional(fieldOf(fields, 'note'))).toBe(true);
});

test('a schema JSON would rewrite, data with ~ keys, and draft-7 dependencies are judged as a file holds them', () => {
	const refusal = (schema: object) =>
		expectErr(prepareKv({ value: schema as TSchema & object })).message;
	expect(refusal({ enum: ['a', undefined] })).toContain(
		'$.enum.1 is undefined',
	);
	expect(refusal({ const: undefined })).toContain('$.const is undefined');
	expect(
		refusal({
			dependencies: {
				a: { properties: { b: { type: 'string', format: 'bogus' } } },
			},
		}),
	).toContain("not a portable format: 'bogus'");
	expect(refusal({ type: 'string', '~a': 1 })).toContain(
		'is not a JSON Schema keyword',
	);
	const kv = expectOk(
		prepareKv({
			value: { type: 'object', default: { '~a': 1 }, const: { '~a': 1 } },
		}),
	).kv;
	expect(accepts(kv.value, { '~a': 1 })).toBe(true);
});

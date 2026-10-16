/**
 * Shape containment tests (ADR-0538).
 *
 * A declaration contains a shape when every value it admits for a field the
 * shape reads is one the shape accepts. The check is conservative: a pair it
 * cannot decide is refused with a reason, never accepted.
 */
import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import type { DataSchema, FieldMap } from './declaration.js';
import { defineTable } from './define.js';
import { field } from './field/index.js';
import { prepareSchema } from './prepare.js';
import {
	requiredOutsideShape,
	schemaContainment,
	shapeProblems,
} from './shape.js';

/** Whether the shape field accepts every value the declared field admits. */
function fits(shape: TSchema & object, declared: TSchema & object): boolean {
	return schemaContainment(shape, declared) === undefined;
}

function prepared(schema: DataSchema): DataSchema {
	const { data, error } = prepareSchema(schema);
	if (error !== null) throw new Error(error.message);
	return data;
}

function schemaOf(
	tables: Record<string, FieldMap>,
	closed: readonly string[] = [],
): DataSchema {
	return prepared({
		tables: Object.fromEntries(
			Object.entries(tables).map(([name, fields]) => [
				name,
				defineTable(
					closed.includes(name)
						? { fields, additionalProperties: false }
						: { fields },
				),
			]),
		),
	});
}

describe('field schemas', () => {
	test('a string accepts any string, a select of strings, and a formatted string', () => {
		for (const declared of [
			field.string(),
			field.select(['a', 'b']),
			field.date(),
			field.instant(),
			field.url(),
			field.reference('pages'),
			Type.Literal('only'),
		])
			expect(fits(field.string(), declared)).toBe(true);
		expect(fits(field.string(), field.number())).toBe(false);
		expect(fits(field.string(), field.tags())).toBe(false);
	});

	test('a select accepts a select of a subset, and refuses more options or free text', () => {
		const shape = field.select(['todo', 'done', 'later']);
		expect(fits(shape, field.select(['todo', 'done']))).toBe(true);
		expect(fits(shape, field.select(['todo', 'done', 'later']))).toBe(true);
		expect(schemaContainment(shape, field.select(['todo', 'blocked']))).toBe(
			'the folder admits "blocked", which the shape refuses',
		);
		expect(schemaContainment(shape, field.string())).toBe(
			"the folder's values are not limited to the shape's options",
		);
	});

	test('a number accepts an integer, and an integer refuses a number', () => {
		expect(fits(field.number(), field.integer())).toBe(true);
		expect(fits(field.number(), field.number())).toBe(true);
		expect(schemaContainment(field.integer(), field.number())).toBe(
			"the folder's value is a number, not an integer",
		);
		expect(fits(field.integer(), field.integer())).toBe(true);
	});

	test('numeric bounds hold when the folder is at least as tight', () => {
		const rating = field.integer({ minimum: 1, maximum: 5 });
		expect(fits(rating, field.integer({ minimum: 2, maximum: 4 }))).toBe(true);
		expect(fits(rating, field.integer({ minimum: 0, maximum: 4 }))).toBe(false);
		expect(fits(rating, field.integer())).toBe(false);
		expect(
			fits(Type.Number({ minimum: 0 }), Type.Number({ exclusiveMinimum: 0 })),
		).toBe(true);
		expect(
			fits(Type.Number({ exclusiveMinimum: 0 }), Type.Number({ minimum: 0 })),
		).toBe(false);
		expect(fits(Type.Number({ multipleOf: 1 }), field.integer())).toBe(true);
		expect(
			fits(Type.Number({ multipleOf: 2 }), Type.Number({ multipleOf: 4 })),
		).toBe(true);
		expect(fits(Type.Number({ multipleOf: 4 }), Type.Number())).toBe(false);
	});

	test('a boolean accepts a boolean only', () => {
		expect(fits(field.boolean(), field.boolean())).toBe(true);
		expect(fits(field.boolean(), field.string())).toBe(false);
	});

	test('date, datetime, and instant follow their formats and the instant pattern', () => {
		expect(fits(field.date(), field.date())).toBe(true);
		expect(fits(field.datetime(), field.instant())).toBe(true);
		expect(schemaContainment(field.instant(), field.datetime())).toMatch(
			/pattern/,
		);
		expect(schemaContainment(field.date(), field.string())).toBe(
			"the shape requires format 'date', and the folder's format is absent",
		);
		expect(fits(field.date(), field.datetime())).toBe(false);
	});

	test('string lengths and a reference hold when the folder is at least as strict', () => {
		expect(fits(field.reference('pages'), field.reference('people'))).toBe(
			true,
		);
		expect(fits(field.reference('pages'), field.string())).toBe(false);
		expect(
			fits(field.string({ maxLength: 10 }), field.string({ maxLength: 5 })),
		).toBe(true);
		expect(fits(field.string({ maxLength: 10 }), field.string())).toBe(false);
		expect(
			fits(field.string({ pattern: '^a' }), field.string({ pattern: '^b' })),
		).toBe(false);
	});

	test('arrays compare their items, bounds, and uniqueness', () => {
		expect(fits(field.tags(), field.tags())).toBe(true);
		expect(fits(field.tags(), field.multiSelect(['a', 'b']))).toBe(true);
		expect(
			fits(field.multiSelect(['a', 'b', 'c']), field.multiSelect(['a', 'b'])),
		).toBe(true);
		expect(fits(field.multiSelect(['a']), field.tags())).toBe(false);
		expect(fits(field.tags(), Type.Array(Type.Number()))).toBe(false);
		expect(fits(field.tags({ uniqueItems: true }), field.tags())).toBe(false);
		expect(fits(field.tags({ maxItems: 3 }), field.tags({ maxItems: 2 }))).toBe(
			true,
		);
		expect(fits(field.tags(), field.string())).toBe(false);
	});

	test('nullable: a nullable shape accepts both, a plain shape refuses null', () => {
		const nullable = field.nullable(field.string());
		expect(fits(nullable, field.string())).toBe(true);
		expect(fits(nullable, nullable)).toBe(true);
		expect(fits(nullable, field.nullable(field.select(['a'])))).toBe(true);
		expect(fits(nullable, Type.Null())).toBe(true);
		expect(schemaContainment(field.string(), nullable)).toBe(
			"the folder's value is a null, not a string",
		);
	});

	test('objects compare properties, required keys, and closure', () => {
		const shape = Type.Object({ hours: Type.Number() });
		expect(
			fits(shape, Type.Object({ hours: Type.Integer(), note: Type.String() })),
		).toBe(true);
		expect(
			fits(shape, Type.Object({ hours: Type.Optional(Type.Number()) })),
		).toBe(false);
		expect(fits(shape, Type.Object({ minutes: Type.Number() }))).toBe(false);
		const closed = Type.Object(
			{ hours: Type.Number() },
			{ additionalProperties: false },
		);
		expect(fits(closed, shape)).toBe(false);
		expect(
			fits(
				closed,
				Type.Object({ hours: Type.Integer() }, { additionalProperties: false }),
			),
		).toBe(true);
	});

	test('a shape that constrains nothing accepts everything, and a folder that constrains nothing fits only it', () => {
		expect(fits(Type.Any(), field.string())).toBe(true);
		expect(fits(field.json(Type.Any()), Type.Object({}))).toBe(true);
		expect(schemaContainment(field.string(), Type.Any())).toBe(
			'the folder admits any value',
		);
	});

	test('a pair it cannot decide is refused with the reason', () => {
		expect(
			schemaContainment(
				Type.Unsafe({ not: { type: 'string' } }),
				Type.Number(),
			),
		).toMatch(/cannot decide/);
		expect(
			schemaContainment(
				Type.String({ contentMediaType: 'text/plain' }),
				Type.String(),
			),
		).toMatch(/cannot decide.*contentMediaType/);
		// The same schema always fits, whatever it says.
		const exotic = Type.String({ contentMediaType: 'text/plain' });
		expect(fits(exotic, exotic)).toBe(true);
		// So does a whole field with a reference; a reference inside one is
		// read against a field around it, and is not compared.
		const named = Type.Unsafe({
			$defs: { name: { type: 'string' } },
			$ref: '#/$defs/name',
		});
		expect(fits(named, named)).toBe(true);
		expect(
			schemaContainment(Type.Array(named), Type.Array(named, { maxItems: 3 })),
		).toMatch(/cannot decide/);
	});

	test('annotations and editor hints never decide containment', () => {
		expect(
			fits(
				field.string({ title: 'Name' }),
				field.json(Type.String({ description: 'x' })),
			),
		).toBe(true);
	});
});

describe('shapes of whole schemas', () => {
	const declared = schemaOf({
		todos: {
			title: field.string(),
			status: field.select(['todo', 'done']),
			priority: field.integer(),
			note: field.optional(field.string()),
		},
		projects: { name: field.string() },
		settings: {
			theme: field.optional(field.select(['light', 'dark'])),
			density: field.optional(field.number()),
		},
	});

	test('a shape that reads a subset of tables and fields fits', () => {
		const shape = schemaOf({
			todos: { title: field.string(), status: field.string() },
			settings: { theme: field.optional(field.string()) },
		});
		expect(shapeProblems(declared, shape)).toEqual([]);
	});

	test('an optional shape field fits a required one, and a required one needs one', () => {
		expect(
			shapeProblems(
				declared,
				schemaOf({ todos: { priority: field.optional(field.number()) } }),
			),
		).toEqual([]);
		expect(
			shapeProblems(declared, schemaOf({ todos: { note: field.string() } })),
		).toEqual([
			{
				kind: 'incompatibleField',
				table: 'todos',
				field: 'note',
				reason: 'the shape requires it, and the folder lets a row leave it out',
				message:
					"The folder's field 'todos.note' does not fit: the shape requires it, and the folder lets a row leave it out",
			},
		]);
	});

	test('every problem is listed: a missing table, a missing field, and an incompatible field', () => {
		const problems = shapeProblems(
			declared,
			schemaOf({
				todos: { title: field.number(), due: field.date() },
				events: { title: field.string() },
				settings: { accent: field.optional(field.string()) },
			}),
		);
		expect(
			problems.map(({ kind, table, ...rest }) => [
				kind,
				table,
				'field' in rest ? rest.field : undefined,
			]),
		).toEqual([
			['incompatibleField', 'todos', 'title'],
			['missingField', 'todos', 'due'],
			['missingTable', 'events', undefined],
			['missingField', 'settings', 'accent'],
		]);
		expect(problems.map(({ message }) => message)).toContain(
			"The folder declares no field 'settings.accent'",
		);
	});

	test('a closed folder table fits a shape that reads a subset of it', () => {
		const closed = schemaOf(
			{ pages: { title: field.string(), tags: field.tags() } },
			['pages'],
		);
		expect(
			shapeProblems(closed, schemaOf({ pages: { title: field.string() } })),
		).toEqual([]);
	});

	test('a closed shape table needs a closed folder table with no other field', () => {
		const shape = schemaOf({ pages: { title: field.string() } }, ['pages']);
		const open = schemaOf({ pages: { title: field.string() } });
		const wider = schemaOf(
			{ pages: { title: field.string(), tags: field.tags() } },
			['pages'],
		);
		const same = schemaOf({ pages: { title: field.string() } }, ['pages']);
		expect(shapeProblems(open, shape)).toMatchObject([
			{ kind: 'incompatibleTable', table: 'pages' },
		]);
		expect(shapeProblems(wider, shape)).toMatchObject([
			{ kind: 'incompatibleTable', table: 'pages' },
		]);
		expect(shapeProblems(same, shape)).toEqual([]);
	});

	test('the fields a shape cannot supply when it adds a row', () => {
		const shape = schemaOf({ todos: { title: field.string() } });
		expect(
			requiredOutsideShape(declared.tables.todos!, shape.tables.todos!),
		).toEqual(['status', 'priority']);
		const full = schemaOf({
			todos: {
				title: field.string(),
				status: field.string(),
				priority: field.number(),
			},
		});
		expect(
			requiredOutsideShape(declared.tables.todos!, full.tables.todos!),
		).toEqual([]);
	});
});

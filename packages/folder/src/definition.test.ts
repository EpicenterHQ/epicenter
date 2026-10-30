/**
 * Folder Definition Tests
 *
 * `defineFolder` returns the prepared definition, in the shape it was declared
 * in: the grammar of the root `epicenter.json` the CLI's `check` and `query`
 * read after serialization (ADR-0632).
 *
 * Key behaviors:
 * - `defineFolder` returns an owned, frozen definition of the declared shape,
 *   and preparing it again returns it
 * - A key other than `title` and `tables` is refused, not
 *   dropped
 * - A definition names no folder: an `id` is refused as any other key is
 * - A schema edited after `defineFolder` does not change what that
 *   definition accepts, and a second definition reusing it reads the edit
 * - A table publishes as one JSON Schema, so two fields defining one `$id`
 *   and a `#` reference outside any `$id` are refused
 *
 * See also:
 * - `packages/definition/src/prepare.test.ts` for preparation itself
 */
import { expect, test } from 'bun:test';
import { defineTable, field } from '@epicenter/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { formatDefinition, parseDeclaration } from './declaration.js';
import { defineFolder, prepareFolderDefinition } from './definition.js';
import { parseDeclaredRow } from './row-text.js';

test('defineFolder returns the prepared definition in the declared shape', () => {
	const declared = {
		title: 'Definition',
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	};
	const definition = defineFolder(declared);

	expect(Object.keys(definition)).toEqual(['title', 'tables']);
	expect(Object.keys(definition.tables)).toEqual(['todos']);
	expect(Object.keys(definition.tables.todos)).toEqual(['fields']);
	expect(Object.keys(definition.tables.todos.fields)).toEqual([
		'title',
		'done',
	]);
	// A field is the native schema, hint included, and a snapshot of it.
	const { title } = definition.tables.todos.fields;
	expect(title).toEqual(field.string());
	expect(title).not.toBe(declared.tables.todos.fields.title);
	for (const owned of [
		definition,
		title,
		definition.tables,
		definition.tables.todos,
		definition.tables.todos.fields,
	])
		expect(Object.isFrozen(owned)).toBe(true);
	expect(Object.isFrozen(declared.tables.todos.fields.title)).toBe(false);

	// An opener handed this definition gets it back and prepares nothing.
	expect(expectOk(prepareFolderDefinition(definition))).toBe(definition);
	expect(expectOk(prepareFolderDefinition(declared))).not.toBe(definition);
	expect(
		expectErr(
			prepareFolderDefinition({
				...declared,
				tables: { todos: { fields: { id: field.string() } } },
			} as never),
		).reason,
	).toContain("field name 'todos.id' is not usable");
});

test('an untyped definition with a key other than title and tables is refused, not dropped', () => {
	expect(() => defineFolder({ tables: {}, titel: 'Typo' } as never)).toThrow(
		"also declares 'titel'",
	);
});

test('a settings table is written with only optional fields, and a published one that requires a setting still opens', () => {
	// Where a definition is written, a required setting is refused: a row of
	// one concern holds only that concern's settings.
	expect(() =>
		defineFolder({
			tables: {
				settings: defineTable({ fields: { theme: field.string() } }),
			},
		} as never),
	).toThrow("'theme' is a setting, which may be unset");
	// A declaration already published that requires one is read as written,
	// so the folder still opens and a row missing it is one to repair.
	expectOk(
		prepareFolderDefinition({
			tables: { settings: { fields: { theme: field.string() } } },
		} as never),
	);
});

test('a definition names no folder: an id is refused where it is written and where it is prepared', () => {
	const declared = { tables: {} };
	expect(() =>
		defineFolder({ ...declared, id: 'so.epicenter.named' } as never),
	).toThrow("also declares 'id'");
	expect(
		expectErr(
			prepareFolderDefinition({
				...declared,
				id: 'so.epicenter.named',
			} as never),
		).reason,
	).toContain("declares 'id'");
});

test('a schema edited after defineFolder changes nothing that definition accepts, and a later definition reads the edit', () => {
	const title = field.string({ maxLength: 4 });
	const table = defineTable({ fields: { title } });
	const first = defineFolder({
		tables: { todos: table },
	});
	// The author still holds an ordinary mutable schema, and declares it again.
	Object.assign(title, { maxLength: 9 });
	const second = defineFolder({
		tables: { todos: table },
	});
	expect(first.tables.todos.fields.title).not.toBe(
		second.tables.todos.fields.title,
	);

	const source = '---\ntitle: Longer\n---\n';
	const firstTable = expectOk(parseDeclaration(formatDefinition(first))).tables!
		.todos!;
	const secondTable = expectOk(parseDeclaration(formatDefinition(second)))
		.tables!.todos!;
	expect(expectOk(parseDeclaredRow(secondTable, source)).fields).toEqual({
		title: 'Longer',
	});
	expectErr(parseDeclaredRow(firstTable, source));
});

test('a table is one JSON Schema in epicenter.json, so its fields cannot reuse an $id or point at the table root', () => {
	// What `Type.Cyclic({ [name]: ... }, name)` declares, as a file holds it.
	const cyclic = (name: string) => ({
		$defs: {
			[name]: {
				$id: name,
				type: 'object',
				properties: {
					value: { type: 'number' },
					next: { anyOf: [{ $ref: name }, { type: 'null' }] },
				},
				required: ['value', 'next'],
			},
		},
		$ref: name,
	});
	const tableOf = (fields: Record<string, object>) => ({
		tables: { chains: defineTable({ fields: fields as never }) },
	});

	// Two fields that each define `Node` publish two schemas with one `$id`,
	// which a JSON Schema validator refuses for the whole table.
	expect(
		expectErr(
			prepareFolderDefinition(
				tableOf({ a: cyclic('Node'), b: cyclic('Node') }),
			),
		).reason,
	).toBe(
		"Fields 'chains.a' and 'chains.b' both define the $id 'Node'. epicenter.json holds a table as one JSON Schema, where an $id names one schema; rename one of them.",
	);
	// A `#` pointer outside any `$id` is the field's root in memory and the
	// table's root in the file.
	expect(
		expectErr(
			prepareFolderDefinition(
				tableOf({
					text: { $defs: { t: { type: 'string' } }, $ref: '#/$defs/t' },
				}),
			),
		).reason,
	).toBe(
		"Field 'chains.text' refers to '#/$defs/t' outside any $id. In epicenter.json '#' is the whole table, not the field; give the field an $id.",
	);

	// Distinct names, the same name in two tables, and a pointer under an
	// `$id` all publish as standalone schemas.
	expectOk(
		prepareFolderDefinition(tableOf({ a: cyclic('Node'), b: cyclic('Other') })),
	);
	expectOk(
		prepareFolderDefinition({
			tables: {
				one: defineTable({ fields: { chain: cyclic('Node') } }),
				two: defineTable({ fields: { chain: cyclic('Node') } }),
			},
		}),
	);
	expectOk(
		prepareFolderDefinition(
			tableOf({
				text: {
					$id: 'text',
					$defs: { t: { type: 'string' } },
					$ref: '#/$defs/t',
				},
				// A `$ref` or `$id` held as data is a value.
				data: { const: { $id: 'Node', $ref: '#/nowhere' } },
				chain: cyclic('Node'),
			}),
		),
	);
});

test('a closed table reports an undeclared key at its line, and epicenter.json keeps it closed', () => {
	const fields = { title: field.string() };
	const definition = defineFolder({
		tables: {
			open: defineTable({ fields }),
			closed: defineTable({ fields, additionalProperties: false }),
		},
	});
	const text = '---\ntitle: Launch\nsubtitel: A typo\n---\n';

	// An open table keeps the undeclared key on the row, outside its type.
	const tables = expectOk(parseDeclaration(formatDefinition(definition)))
		.tables!;
	const kept = expectOk(parseDeclaredRow(tables.open!, text)).fields;
	expect(kept).toEqual({ title: 'Launch', subtitel: 'A typo' });
	expect(expectErr(parseDeclaredRow(tables.closed!, text))).toEqual([
		{ message: 'subtitel is not declared', line: 3, field: 'subtitel' },
	]);

	const declaration = formatDefinition(definition);
	expect(JSON.parse(declaration).tables.closed.additionalProperties).toBe(
		false,
	);
	expect(JSON.parse(declaration).tables.open).not.toHaveProperty(
		'additionalProperties',
	);
	const reread = expectOk(parseDeclaration(declaration));
	expect(reread.tables?.closed?.additionalProperties).toBe(false);
	// A schema-valued additionalProperties is ordinary JSON Schema, retained whole.
	expect(
		expectOk(
			parseDeclaration(
				JSON.stringify({
					tables: {
						notes: {
							type: 'object',
							properties: {},
							additionalProperties: { type: 'string' },
						},
					},
				}),
			),
		).tables?.notes?.additionalProperties,
	).toEqual({ type: 'string' });
});

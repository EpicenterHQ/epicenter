/**
 * Compile-time checks for reserved names, complete body codecs, value-only
 * rows, and inferred creation inputs. Runtime checks live in compile.test.ts
 * and body-boundary.test.ts.
 */
import { defineStore } from '@epicenter/app';

import { plainText } from './body.js';
import type { CreateRowOf, RowOf } from './declaration.js';

import { defineTable, field } from './index.js';

defineTable({
	fields: {},
	// @ts-expect-error the body option accepts a codec, not a field schema
	body: field.string(),
});

const fieldsOnly = defineTable({
	fields: { name: field.string(), sql: field.string() },
});
declare const fieldsOnlyRow: RowOf<typeof fieldsOnly>;
const rowName: string = fieldsOnlyRow.name;
const rowSql: string = fieldsOnlyRow.sql;
// @ts-expect-error live bodies are not part of value snapshots
fieldsOnlyRow.body;
const newRow: CreateRowOf<typeof fieldsOnly> = {
	name: 'Inbox',
	sql: 'SELECT 1',
};
void [rowName, rowSql, newRow];
// @ts-expect-error omission does not widen the exact field keys
fieldsOnlyRow.unknown;
// @ts-expect-error SQL remains required
const incomplete: CreateRowOf<typeof fieldsOnly> = { name: 'Inbox' };
defineTable({ fields: {}, body: undefined });
defineTable({
	fields: {},
	// @ts-expect-error a supplied codec requires rewrite
	body: { encode: plainText().encode, decode: plainText().decode },
});
defineTable({
	fields: {
		// @ts-expect-error reserved keys also fail without a codec
		ID: field.string(),
	},
});

defineTable({
	fields: {
		// @ts-expect-error 'id' is reserved: every row already has one
		id: field.string(),
	},
	body: plainText(),
});

/**
 * A declared default is refused where it is authored, not at first open.
 *
 * `compileData` refuses one at runtime too (`DeclarationDefault`), and this is
 * the compile-time half of that rule, for both buckets a definition has.
 *
 * Through `defineTable` rather than a table literal handed to `defineStore`. A
 * literal is refused for having no brand, and that refusal fires FIRST: the
 * table half of this pin used to sit on a bare literal, and it passed with the
 * default removed entirely, so it was testing the door rather than the
 * default. The kv half below is genuine, because `kv` takes a bare field map.
 *
 * The default has to be spread in rather than passed to the builder. Every
 * builder returns a fixed schema type (`field.string(opts)` is `TString`
 * whatever `opts` says), so an annotation handed to one is erased before this
 * check can see it. Only a schema whose OWN type carries `default` is caught
 * here; the rest is `compileData`'s to refuse.
 */
defineTable({
	fields: {
		// @ts-expect-error a default belongs to the application, not the schema
		title: { ...field.string(), default: 'untitled' },
	},
	body: plainText(),
});

/**
 * A table has one door, and a bare literal is not it.
 *
 * `defineTable` brands its return and `DataDefinition` requires the brand, so a
 * structurally-correct literal handed straight to `defineStore` is refused. That
 * is what lets every table rule live on `defineTable`'s parameter alone: there
 * is no second authoring path left to re-check, which is what `ValidateTable`
 * and `ValidateDefinition` used to be for.
 *
 * It also fixed the message. On the old `defineStore` path the refusal was
 * carried through `TData & ValidateDefinition<TData>`, and the intersection
 * collapsed the offending element to `never`, taking the explanation with it.
 * A collision now reports the same sentence wherever it is written.
 */
defineStore({
	id: 'so.epicenter.bare-literal',
	kv: {},
	tables: {
		// @ts-expect-error a table is authored with `defineTable`
		notes: { title: field.string() },
	},
});

defineStore({
	id: 'so.epicenter.declaration-default',
	kv: {
		// @ts-expect-error a default belongs to the application, not the schema
		theme: { ...field.string(), default: 'light' },
	},
	tables: {
		items: defineTable({
			fields: {
				title: field.string(),
			},
			body: plainText(),
		}),
	},
});

// Body storage consumes no field name.
const ordinaryNames = defineTable({
	fields: {
		content: field.string(),
		'!status': field.string(),
		Body: field.string(),
		body: field.string(),
	},
});
const ordinaryInput: CreateRowOf<typeof ordinaryNames> = {
	content: 'value',
	'!status': 'draft',
	Body: 'capitalized',
	body: 'ordinary metadata',
};
void ordinaryInput;
declare const ordinaryRow: RowOf<typeof ordinaryNames>;
const bodyValue: string = ordinaryRow.body;
void bodyValue;
defineTable({
	fields: {
		body: field.string(),
	},
});

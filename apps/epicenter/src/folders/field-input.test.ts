/**
 * Field Input Tests
 *
 * Which editor each declared field gets in the Folders window, and the value
 * an editor's text saves.
 *
 * Key behaviors:
 * - Columns keep declared order and follow each field's hint
 * - A field whose hint does not fit its schema gets the JSON editor
 * - Clearing an optional field removes it; clearing a required number saves nothing
 * - Numbers, tags, and JSON parse their text, and say plainly when they cannot
 */
import { expect, test } from 'bun:test';
import { defineFolder, defineTable, field } from '@epicenter/folder';
import { columnsOf, commitText, textOf } from './field-input';

const definition = defineFolder({
	kv: {},
	tables: {
		items: defineTable({
			fields: {
				title: field.string(),
				count: field.integer(),
				price: field.optional(field.number()),
				done: field.boolean(),
				due: field.date(),
				at: field.instant(),
				status: field.select(['open', 'closed']),
				labels: field.multiSelect(['red', 'blue']),
				tags: field.tags(),
				owner: field.reference('people'),
				extra: field.json(field.number()),
			},
		}),
	},
});
const columns = columnsOf(definition.tables.items);
const column = (name: string) => {
	const found = columns.find((c) => c.name === name);
	if (found === undefined) throw new Error(`no column ${name}`);
	return found;
};

test('columns keep declared order and follow each hint', () => {
	expect(columns.map((c) => [c.name, c.editor.kind])).toEqual([
		['title', 'string'],
		['count', 'integer'],
		['price', 'number'],
		['done', 'boolean'],
		['due', 'date'],
		['at', 'instant'],
		['status', 'select'],
		['labels', 'multiSelect'],
		['tags', 'tags'],
		['owner', 'reference'],
		['extra', 'json'],
	]);
	expect(column('status').editor).toEqual({
		kind: 'select',
		options: ['open', 'closed'],
	});
	expect(column('price').optional).toBe(true);
	expect(column('count').optional).toBe(false);
});

test('clearing an optional field removes it; a required number saves nothing', () => {
	expect(commitText(column('price'), '  ')).toEqual({ kind: 'remove' });
	expect(commitText(column('count'), '')).toEqual({ kind: 'unchanged' });
	expect(commitText(column('title'), '')).toEqual({ kind: 'set', value: '' });
});

test('numbers, tags, and JSON parse their text', () => {
	expect(commitText(column('count'), '42')).toEqual({ kind: 'set', value: 42 });
	expect(commitText(column('count'), '4.5')).toMatchObject({ kind: 'invalid' });
	expect(commitText(column('price'), 'abc')).toMatchObject({ kind: 'invalid' });
	expect(commitText(column('tags'), 'a, b,, a ')).toEqual({
		kind: 'set',
		value: ['a', 'b'],
	});
	expect(commitText(column('extra'), '{"a": [1]}')).toEqual({
		kind: 'set',
		value: { a: [1] },
	});
	expect(commitText(column('extra'), '{')).toMatchObject({ kind: 'invalid' });
	expect(textOf('tags', ['a', 'b'])).toBe('a, b');
	expect(textOf('integer', 3)).toBe('3');
	expect(textOf('string', undefined)).toBe('');
});

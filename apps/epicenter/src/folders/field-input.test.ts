/**
 * Field Input Tests
 *
 * Which editor each declared field gets in the Folders window, and the value
 * an editor's text saves.
 *
 * Key behaviors:
 * - Columns keep declared order and follow each field's hint
 * - A field whose hint does not fit its schema gets the JSON editor
 * - A field with no hint gets the editor its plain JSON Schema type implies;
 *   a hint that is present still wins
 * - Clearing an optional field removes it; clearing a required number saves nothing
 * - Numbers, tags, and JSON parse their text, and say plainly when they cannot
 * - A change sends an update that sets the field, any name as an own key, or
 *   unsets it
 * - A write that failed says why in words a person reads
 */
import { expect, test } from 'bun:test';
import {
	defineFolder,
	defineTable,
	field,
	parseDeclaration,
} from '@epicenter/folder';
import { expectOk } from 'wellcrafted/testing';
import {
	columnsOf,
	commitText,
	editorOf,
	failureText,
	fieldSet,
	textOf,
} from './field-input';

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

test('a plain JSON Schema declaration gets editors by type', () => {
	// The demo's books: a hand-written declaration with no x-field hints.
	const declared = expectOk(
		parseDeclaration(
			JSON.stringify({
				kv: { type: 'object', properties: {} },
				tables: {
					books: {
						type: 'object',
						properties: {
							title: { type: 'string' },
							read: { type: 'boolean' },
							rating: { type: 'integer' },
							price: { type: 'number' },
							shelf: { type: 'string', enum: ['home', 'office'] },
							started: { type: 'string', format: 'date' },
							finished: { type: 'string', format: 'date-time' },
							link: { type: 'string', format: 'uri' },
							moods: {
								type: 'array',
								items: { type: 'string', enum: ['calm', 'tense'] },
							},
							tags: { type: 'array', items: { type: 'string' } },
							note: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
							meta: { type: 'object' },
						},
						required: ['title', 'read'],
					},
				},
			}),
		),
	);
	const books = declared.tables.books;
	if (books === undefined) throw new Error('no books table');
	expect(
		Object.entries(books.fields).map(([name, schema]) => [
			name,
			editorOf(schema),
		]),
	).toEqual([
		['title', { kind: 'string' }],
		['read', { kind: 'boolean' }],
		['rating', { kind: 'integer' }],
		['price', { kind: 'number' }],
		['shelf', { kind: 'select', options: ['home', 'office'] }],
		['started', { kind: 'date' }],
		['finished', { kind: 'datetime' }],
		['link', { kind: 'url' }],
		['moods', { kind: 'multiSelect', options: ['calm', 'tense'] }],
		['tags', { kind: 'tags' }],
		['note', { kind: 'boolean' }],
		['meta', { kind: 'json' }],
	]);
});

test('a hint that is present wins over the plain type, even a JSON one', () => {
	expect(editorOf(field.json(field.boolean()))).toEqual({ kind: 'json' });
	expect(
		editorOf({ type: 'string', 'x-field': { kind: 'date' } } as never),
	).toEqual({ kind: 'date' });
	// A malformed hint is still a hint: the JSON editor, not a guess.
	expect(editorOf({ type: 'boolean', 'x-field': 'checkbox' } as never)).toEqual(
		{
			kind: 'json',
		},
	);
	// An enum of other than strings has no menu.
	expect(editorOf({ enum: [1, 2] } as never)).toEqual({ kind: 'json' });
});

test('a change sets the field, any name as an own key, or removes it', () => {
	expect(fieldSet('title', { kind: 'set', value: 'Milk' })).toEqual({
		title: 'Milk',
	});
	const proto = fieldSet('__proto__', { kind: 'set', value: 1 });
	expect(Object.hasOwn(proto, '__proto__')).toBe(true);
	const removed = fieldSet('price', { kind: 'remove' });
	expect(Object.hasOwn(removed, 'price')).toBe(true);
	expect(removed.price).toBeUndefined();
});

test('a write that failed says why in words a person reads', () => {
	expect(
		failureText({
			name: 'KeptChanging',
			message: 'kept changing',
			path: 'notes/a.md',
			attempts: 3,
		}),
	).toBe('This row kept changing in another window, so your edit was not saved.');
	expect(
		failureText({
			name: 'InvalidValues',
			message: 'bad',
			issues: [{ message: 'title must be text' }],
		}),
	).toBe('Not saved: title must be text');
	expect(failureText(new Error('host went away'))).toBe(
		'Not saved: host went away',
	);
	expect(failureText('odd')).toBe('Not saved: odd');
});

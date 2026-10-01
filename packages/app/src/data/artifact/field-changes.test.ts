/** Field diffs preserve raw values, enforce permissions, and distinguish KV deletion from null. */
import { expect, test } from 'bun:test';
import { editField } from '@epicenter/matter-core/serialize';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { fieldChanges, kvChanges } from './field-changes.js';
import { parseRowFile, rowFile } from './frontmatter.js';

test('clearing the final field in Matter preserves the artifact body', () => {
	for (const body of ['', 'Body']) {
		const parsed = parseRowFile(
			editField(rowFile({ folder: 'x' }, body), 'folder', undefined),
		)!;
		expect(parsed).toEqual({ fields: {}, body });
		expect(
			expectOk(fieldChanges(['folder'], { folder: 'x' }, parsed.fields)),
		).toEqual({ folder: null });
	}
});

test('prototype names are read and written as own field values', () => {
	const patch = expectOk(
		fieldChanges(['constructor'], { constructor: 'x' }, {}),
	);
	expect(Object.hasOwn(patch, 'constructor')).toBe(true);
	expect(patch.constructor).toBeNull();
	expect(
		expectErr(fieldChanges([], {}, JSON.parse('{"__proto__": {}}'))),
	).toMatchObject({
		fields: [{ field: '__proto__', reason: 'not-permitted' }],
	});
});

test('only the edited Matter field is submitted, independent of current store values', () => {
	const base = {
		title: 'Before',
		folder: null,
		count: 3,
		payload: { a: 1, b: 2 },
		transcript: 'line one\nline two',
	};
	const file = parseRowFile(
		editField(rowFile(base, 'body'), 'title', 'After'),
	)!;
	expect(expectOk(fieldChanges(['title'], base, file.fields))).toEqual({
		title: 'After',
	});
	expect(
		expectOk(
			fieldChanges(['title'], base, {
				...base,
				payload: { b: 2, a: 1 },
			}),
		),
	).toEqual({});
});

test('nullable spellings are equal and removing a populated nullable field clears it', () => {
	expect(expectOk(fieldChanges(['folder'], { folder: null }, {}))).toEqual({});
	expect(expectOk(fieldChanges(['folder'], {}, { folder: null }))).toEqual({});
	expect(expectOk(fieldChanges(['folder'], { folder: 'x' }, {}))).toEqual({
		folder: null,
	});
});

test('preflight refuses forbidden edits independently of value conformance', () => {
	expect(
		expectErr(
			fieldChanges(
				['title', 'payload'],
				{ title: 'x', payload: {} },
				{ payload: null, unknown: 1, count: 4 },
			),
		),
	).toMatchObject({
		fields: [
			{ field: 'unknown', reason: 'not-permitted' },
			{ field: 'count', reason: 'not-permitted' },
		],
	});
	expect(
		expectOk(
			fieldChanges(
				['title'],
				{ title: 'x', count: 'old invalid value' },
				{ title: 'y', count: 'old invalid value' },
			),
		),
	).toEqual({ title: 'y' });
});

test('permitted edits accept nonconforming and undeclared values', () => {
	expect(
		expectOk(
			fieldChanges(
				['title', 'extra'],
				{ title: 'x' },
				{ title: 42, extra: true },
			),
		),
	).toEqual({ title: 42, extra: true });
	expect(expectOk(fieldChanges(['title'], { title: 'x' }, {}))).toEqual({
		title: null,
	});
});

test('KV distinguishes deletion, stored null, and unchanged absence', () => {
	expect(
		expectOk(
			kvChanges(
				['removed', 'empty', 'new'],
				{ removed: null, empty: 'before', untouched: 1 },
				{ empty: null, new: { any: 'value' }, untouched: 1 },
			),
		),
	).toEqual({
		set: { empty: null, new: { any: 'value' } },
		delete: ['removed'],
	});
	expect(expectOk(kvChanges(['remoteOnly'], {}, {}))).toEqual({
		set: {},
		delete: [],
	});
	expect(expectErr(kvChanges([], { protected: 1 }, {})).fields).toEqual([
		{ field: 'protected', reason: 'not-permitted' },
	]);
});

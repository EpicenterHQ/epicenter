/** Saved views compose into current text without owning storage or publication. */
import { expect, test } from 'bun:test';
import { Check } from 'typebox/value';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readSavedViews } from './declaration.js';
import { type SavedView, SavedViewSchema } from './declaration-schema.js';
import { changeSavedView } from './declaration-write.js';

const grid = {
	type: 'grid',
	table: 'notes',
	title: 'Notes',
} satisfies SavedView;
const board = {
	type: 'board',
	table: 'notes',
	title: 'Status',
	groupBy: 'status',
} satisfies SavedView;
const sql = {
	type: 'sql',
	title: 'Recent',
	sql: 'select * from notes',
} satisfies SavedView;

test('view readers preserve valid siblings beside unsupported views and unrelated metadata', () => {
	const reading = expectOk(
		readSavedViews(
			JSON.stringify({
				tables: 42,
				title: null,
				futureMetadata: { enabled: true },
				views: {
					grid,
					board,
					sql,
					broken: null,
					future: { type: 'calendar' },
					invalid: { ...grid, table: 'notes/nested' },
				},
			}),
		),
	);
	expect(reading.views).toEqual({ grid, board, sql });
	expect(reading.diagnostics.map(({ key, kind }) => ({ key, kind }))).toEqual([
		{ key: 'broken', kind: 'invalid' },
		{ key: 'future', kind: 'unsupported' },
		{ key: 'invalid', kind: 'invalid' },
	]);
	expect(Check(SavedViewSchema, board)).toBe(true);
});

test('missing view sections are empty and malformed JSON or view containers remain errors', () => {
	expect(expectOk(readSavedViews('{"tables":false}'))).toEqual({
		views: {},
		diagnostics: [],
	});
	for (const source of [
		'{"views":null}',
		'{"views":[]}',
		'{broken',
		'{"views":{},"views":{}}',
	]) {
		expectErr(readSavedViews(source));
		expectErr(changeSavedView(source, { key: 'mine', value: grid }));
	}
});

test('view changes preserve current unrelated JSON and unsupported siblings', () => {
	const source = {
		$schema: 'future',
		tables: 42,
		futureMetadata: { nested: [1, 2] },
		views: { mine: grid, future: { type: 'calendar', config: [1, 2] } },
	};
	const desired = { ...grid, title: 'Typed notes', columns: ['title'] };
	const text = expectOk(
		changeSavedView(JSON.stringify(source), { key: 'mine', value: desired }),
	);
	expect(JSON.parse(text)).toEqual({
		...source,
		views: { ...source.views, mine: desired },
	});
	const composed = expectOk(
		changeSavedView(text, { key: 'recent', value: sql }),
	);
	expect(JSON.parse(composed).views).toEqual({
		...source.views,
		mine: desired,
		recent: sql,
	});
});

test('assignments replace the current target directly and deletion creates no missing entry', () => {
	const original = JSON.stringify({ views: { mine: board, keep: sql } });
	const replaced = expectOk(
		changeSavedView(original, { key: 'mine', value: grid }),
	);
	expect(JSON.parse(replaced).views).toEqual({ mine: grid, keep: sql });
	const deleted = expectOk(
		changeSavedView(replaced, { key: 'mine', value: undefined }),
	);
	expect(JSON.parse(deleted).views).toEqual({ keep: sql });
	expect(
		expectOk(changeSavedView('{}', { key: 'absent', value: undefined })),
	).toBe('{}');
	const repaired = expectOk(
		changeSavedView('{"views":{"mine":null}}', { key: 'mine', value: grid }),
	);
	expect(JSON.parse(repaired).views.mine).toEqual(grid);
});

test('prototype-looking view names remain own JSON entries', () => {
	const text = expectOk(
		changeSavedView('{}', { key: '__proto__', value: grid }),
	);
	const views = expectOk(readSavedViews(text)).views;
	expect(Object.hasOwn(views, '__proto__')).toBe(true);
	expect(Reflect.get(views, '__proto__')).toEqual(grid);
	expect(Object.getPrototypeOf(views)).toBeNull();
	expect(
		JSON.parse(
			expectOk(changeSavedView(text, { key: '__proto__', value: undefined })),
		),
	).toEqual({ views: {} });
});

test('invalid submitted views and lossy JSON cannot replace the held source', () => {
	for (const value of [
		{ ...grid, table: 'notes/nested' },
		{ ...grid, type: 'future' },
		null,
	])
		expectErr(changeSavedView('{}', { key: 'mine', value: value as never }));
	for (const source of [
		'{"future":9007199254740993}',
		'{"future":-0}',
		'{"future":1,"future":2}',
	])
		expectErr(changeSavedView(source, { key: 'mine', value: grid }));
	expectErr(changeSavedView('{}', { key: '', value: grid }));
});

test('saved grid and board scopes allow ordinary directory names and refuse temporary browsing scopes', () => {
	for (const table of ['My Notes', 'my-notes', 'order', '123']) {
		for (const view of [
			{ ...grid, table },
			{ ...board, table },
		]) {
			const text = expectOk(
				changeSavedView('{}', { key: 'ordinary', value: view }),
			);
			expect(expectOk(readSavedViews(text)).views.ordinary).toEqual(view);
		}
	}
	for (const table of [
		'',
		'.',
		'..',
		'*',
		'notes/nested',
		'notes\\nested',
		'notes\0nested',
	])
		expectErr(
			changeSavedView('{}', { key: 'invalid', value: { ...grid, table } }),
		);
});

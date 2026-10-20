/**
 * Saved views are independent named metadata, changed with entry-level intent.
 * Real CAS outcomes expose sibling preservation, same-entry conflicts, ambiguous
 * acknowledgements, and the difference between an absent entry and JSON null.
 */
import { expect, test } from 'bun:test';
import { Check } from 'typebox/value';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import { readSavedViews } from './declaration.js';
import { type SavedView, SavedViewSchema } from './declaration-schema.js';
import { changeSavedView } from './declaration-write.js';
import { FileError } from './errors.js';
import { hashBytes } from './hash.js';

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

function setup(
	source: string | null,
	concurrent?: () => string,
	unconfirmed = false,
) {
	let current = source;
	let puts = 0;
	const storage: Pick<FolderStorage, 'read' | 'put'> = {
		async read(path) {
			if (current === null) return FileError.NotFound({ path });
			const bytes = new TextEncoder().encode(current);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		async put(path, bytes, ifMatch) {
			puts++;
			if (puts === 1 && concurrent !== undefined) current = concurrent();
			const hash =
				current === null
					? null
					: await hashBytes(new TextEncoder().encode(current));
			if (hash !== ifMatch) return Ok('stale');
			current = bytes === null ? null : new TextDecoder().decode(bytes);
			return unconfirmed
				? FileError.Unconfirmed({
						path,
						operation: 'write',
						cause: 'lost reply',
					})
				: Ok('landed');
		},
	};
	return { storage, source: () => current, puts: () => puts };
}

test('valid saved views survive invalid siblings and unrelated broken declaration sections', () => {
	const reading = expectOk(
		readSavedViews(
			JSON.stringify({
				tables: 42,
				local: false,
				title: null,
				views: {
					grid,
					board,
					sql,
					broken: null,
					future: { type: 'calendar', title: 'Later' },
					invalid: { ...grid, table: 'notes/nested' },
				},
			}),
		),
	);
	expect<unknown>(reading.views).toEqual({ grid, board, sql });
	expect(reading.diagnostics.map(({ key, kind }) => ({ key, kind }))).toEqual([
		{ key: 'broken', kind: 'invalid' },
		{ key: 'future', kind: 'unsupported' },
		{ key: 'invalid', kind: 'invalid' },
	]);
	expect(Check(SavedViewSchema, board)).toBe(true);
});

test('missing views are empty while malformed containers and source remain visible errors', () => {
	expect(expectOk(readSavedViews('{"tables":false}'))).toEqual({
		views: {},
		diagnostics: [],
	});
	for (const source of [
		'{"views":null}',
		'{"views":[]}',
		'{broken',
		'{"views":{},"views":{}}',
	])
		expectErr(readSavedViews(source));
});

test('the first named view creates only its declaration and deleting an absent view creates nothing', async () => {
	const missing = setup(null);
	expect(
		expectOk(
			await changeSavedView(missing.storage, {
				key: 'missing',
				base: undefined,
				value: undefined,
			}),
		),
	).toEqual({ written: false });
	expect(missing.puts()).toBe(0);
	expect(missing.source()).toBeNull();
	expect(
		expectOk(
			await changeSavedView(missing.storage, {
				key: 'notes',
				base: undefined,
				value: grid,
			}),
		),
	).toEqual({ written: true });
	expect(JSON.parse(missing.source()!)).toEqual({ views: { notes: grid } });
});

test('an entry save preserves concurrent siblings, schemas, local rules and unsupported views', async () => {
	const original = {
		local: ['audio/'],
		tables: 42,
		views: { mine: grid, future: { type: 'calendar', config: [1, 2] } },
	};
	const concurrent = {
		...original,
		local: ['audio/', 'private/'],
		views: { ...original.views, added: sql },
	};
	const fixture = setup(JSON.stringify(original), () =>
		JSON.stringify(concurrent),
	);
	const desired = { ...grid, title: 'My notes', columns: ['title'] };
	expectOk(
		await changeSavedView(fixture.storage, {
			key: 'mine',
			base: grid,
			value: desired,
		}),
	);
	expect(fixture.puts()).toBe(2);
	expect(JSON.parse(fixture.source()!)).toEqual({
		...concurrent,
		views: { ...concurrent.views, mine: desired },
	});
});

test('a same-entry concurrent change refuses rather than replacing a newer view', async () => {
	const concurrent = JSON.stringify({ views: { mine: board, keep: sql } });
	const fixture = setup(
		JSON.stringify({ views: { mine: grid } }),
		() => concurrent,
	);
	expect(
		expectErr(
			await changeSavedView(fixture.storage, {
				key: 'mine',
				base: grid,
				value: { ...grid, title: 'Edited' },
			}),
		).reason,
	).toContain('changed since');
	expect(fixture.puts()).toBe(1);
	expect(fixture.source()).toBe(concurrent);
});

test('already-achieved edits and deletes succeed before checking an obsolete base', async () => {
	const source = JSON.stringify({ views: { mine: grid, keep: sql } });
	const fixture = setup(source);
	expect(
		expectOk(
			await changeSavedView(fixture.storage, {
				key: 'mine',
				base: board,
				value: grid,
			}),
		),
	).toEqual({ written: false });
	expect(
		expectOk(
			await changeSavedView(fixture.storage, {
				key: 'missing',
				base: board,
				value: undefined,
			}),
		),
	).toEqual({ written: false });
	expect(fixture.puts()).toBe(0);
	expect(fixture.source()).toBe(source);
	const concurrent = setup(
		JSON.stringify({ views: { mine: board } }),
		() => source,
	);
	expectOk(
		await changeSavedView(concurrent.storage, {
			key: 'mine',
			base: board,
			value: grid,
		}),
	);
	expect(concurrent.puts()).toBe(1);
	expect(concurrent.source()).toBe(source);
});

test('null is an existing entry and an explicit matching base can repair or delete it', async () => {
	const fixture = setup('{"views":{"mine":null,"keep":{"type":"future"}}}');
	expectErr(
		await changeSavedView(fixture.storage, {
			key: 'mine',
			base: undefined,
			value: grid,
		}),
	);
	expect(fixture.puts()).toBe(0);
	expectOk(
		await changeSavedView(fixture.storage, {
			key: 'mine',
			base: null,
			value: grid,
		}),
	);
	expectOk(
		await changeSavedView(fixture.storage, {
			key: 'mine',
			base: grid,
			value: undefined,
		}),
	);
	expect(JSON.parse(fixture.source()!)).toEqual({
		views: { keep: { type: 'future' } },
	});
});

test('a rejected or malformed target changes no source and unrelated entries are not validated', async () => {
	for (const source of ['{"views":null}', '{"views":[]}', '{"views":false}']) {
		const fixture = setup(source);
		expectErr(
			await changeSavedView(fixture.storage, {
				key: 'mine',
				base: undefined,
				value: grid,
			}),
		);
		expect(fixture.puts()).toBe(0);
		expect(fixture.source()).toBe(source);
	}
	for (const value of [
		{ ...grid, table: 'nested/notes' },
		{ ...grid, type: 'future' },
		null,
	]) {
		const fixture = setup('{}');
		expectErr(
			await changeSavedView(fixture.storage, {
				key: 'mine',
				base: undefined,
				value: value as never,
			}),
		);
		expect(fixture.puts()).toBe(0);
	}
});

test('lost write replies are confirmed and prototype-looking keys remain ordinary view names', async () => {
	const fixture = setup('{"views":{}}', undefined, true);
	expectOk(
		await changeSavedView(fixture.storage, {
			key: '__proto__',
			base: undefined,
			value: grid,
		}),
	);
	expect(fixture.puts()).toBe(1);
	const reading = expectOk(readSavedViews(fixture.source()!));
	expect(Object.hasOwn(reading.views, '__proto__')).toBe(true);
	expect(Reflect.get(reading.views, '__proto__')).toEqual(grid);
	expect(Object.getPrototypeOf(reading.views)).toBeNull();
	expectOk(
		await changeSavedView(fixture.storage, {
			key: '__proto__',
			base: grid,
			value: undefined,
		}),
	);
	expect(JSON.parse(fixture.source()!)).toEqual({ views: {} });
});

test('an in-flight change owns its baseline and desired metadata while the form keeps editing', async () => {
	const base = { ...grid };
	const desired = { ...grid, title: 'Sent title' };
	const fixture = setup(JSON.stringify({ views: { mine: base } }));
	const saving = changeSavedView(fixture.storage, {
		key: 'mine',
		base,
		value: desired,
	});
	base.title = 'Changed original';
	desired.title = 'Later typing';
	expectOk(await saving);
	expect(JSON.parse(fixture.source()!).views.mine.title).toBe('Sent title');
});

test('saved grid and board scopes accept ordinary directory names without requiring SQL identifiers', async () => {
	for (const table of ['My Notes', 'my-notes', 'order', '123']) {
		for (const view of [
			{ ...grid, table },
			{ ...board, table },
		]) {
			const reading = expectOk(
				readSavedViews(JSON.stringify({ views: { ordinary: view } })),
			);
			expect(reading.diagnostics).toEqual([]);
			expect(reading.views.ordinary).toMatchObject({ table });
			const fixture = setup('{}');
			expectOk(
				await changeSavedView(fixture.storage, {
					key: 'ordinary',
					base: undefined,
					value: view,
				}),
			);
			expect(JSON.parse(fixture.source()!).views.ordinary.table).toBe(table);
		}
	}
});

test('saved table scopes refuse nested paths and temporary all-files or root selections', async () => {
	for (const table of [
		'',
		'.',
		'..',
		'*',
		'notes/nested',
		'notes\\nested',
		'notes\0nested',
	]) {
		const value = { ...grid, table };
		const reading = expectOk(
			readSavedViews(JSON.stringify({ views: { invalid: value, keep: sql } })),
		);
		expect(Object.keys(reading.views)).toEqual(['keep']);
		expect(reading.diagnostics[0]?.key).toBe('invalid');
		const fixture = setup('{}');
		expectErr(
			await changeSavedView(fixture.storage, {
				key: 'invalid',
				base: undefined,
				value,
			}),
		);
		expect(fixture.puts()).toBe(0);
	}
});

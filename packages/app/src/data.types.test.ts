/**
 * Data declaration types retain field inference for each key's handle.
 * Negative cases keep ids mandatory and field types exact. A ref to a key
 * that is not declared is refused when defineData runs (data.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { ActionError, defineData, field, Ok } from './index.ts';
import { assertType, type Equal, tempFolder } from './library.test-support.ts';

const { folder } = await tempFolder();
const data = defineData(folder, {
	notes: {
		description: 'note',
		fields: {
			title: field.text(),
			note: field.text({ optional: true }),
			n: field.integer(),
			done: field.boolean({ optional: true }),
			tags: field.list(field.text(), { optional: true }),
			choice: field.select(['yes', 'no']),
			raw: Type.Number(),
			created: field.datetime(),
		},
	},
	settings: {
		description: 'settings record',
		fields: { level: field.integer() },
	},
	watches: { description: 'watch', fields: {} },
	checks: {
		description: 'check',
		fields: {
			watch: field.ref('watches'),
			many: field.list(field.ref('watches')),
			maybe: field.ref('watches', { optional: true }),
		},
	},
});
type Note = NonNullable<Awaited<ReturnType<typeof data.notes.get>>['data']>;
type Settings = NonNullable<
	Awaited<ReturnType<typeof data.settings.get>>['data']
>;

test('record and method types retain the exact declared fields', () => {
	assertType<
		Equal<
			Note,
			{
				path: string;
				id: string;
				body: string;
				title: string;
				note?: string;
				n: number;
				done?: boolean;
				tags?: string[];
				choice: 'yes' | 'no';
				raw: number;
				created: string;
			}
		>
	>();
	assertType<
		Equal<Settings, { path: string; id: string; body: string; level: number }>
	>();
	assertType<Equal<Parameters<typeof data.notes.get>, [id: string]>>();
	type Check = NonNullable<Awaited<ReturnType<typeof data.checks.get>>['data']>;
	assertType<Equal<Check['watch'], string>>();
	assertType<Equal<Check['many'], string[]>>();
	assertType<Equal<Check['maybe'], string | undefined>>();
});

test('computed changes retain field types and callback errors', async () => {
	expect(
		expectOk(
			await data.settings.edit('settings', (record) => {
				assertType<Equal<typeof record, Settings | undefined>>();
				return Ok({ level: record?.level ?? 1 });
			}),
		).level,
	).toBe(1);
	const result = await data.notes.edit('a', () =>
		ActionError.Refused({ message: 'stop' }),
	);
	expect(expectErr(result).message).toBe('stop');
});

test('a computed edit answers Misfit, Changed, or its own error', () => {
	type Names<T> = T extends () => Promise<infer R>
		? R extends { error: infer E }
			? E extends { name: infer N }
				? N
				: never
			: never
		: never;
	const computed = () =>
		data.notes.edit('a', () => ActionError.Unreachable({ message: 'x' }));
	assertType<
		Equal<Names<typeof computed>, 'Changed' | 'Misfit' | 'Unreachable'>
	>();
});

describe('type errors', () => {
	test('handles require an id and the declared field types', () => {
		// @ts-expect-error a record needs an id
		() => data.notes.get();
		// @ts-expect-error numbers stay numbers
		() => data.notes.patch('a', { n: 'bad' });
		// @ts-expect-error required fields cannot be removed
		() => data.notes.patch('a', { title: null });
		// @ts-expect-error patch accepts an object, not a callback
		() => data.notes.patch('a', () => Ok({ title: 'x' }));
		// @ts-expect-error a computed edit returns a Result
		() => data.notes.edit('a', () => ({ title: 'x' }));
		// @ts-expect-error edit takes a function, never fields
		() => data.notes.edit('a', { title: 'x' });
		// @ts-expect-error edit takes a function, never a passage; the edit action takes one
		() => data.notes.edit('a', { old: 'x', new: 'y' });
		// @ts-expect-error create needs the required fields, including read-only fields
		() => data.notes.create('a', { title: 'only title' });
		// @ts-expect-error undeclared fields cannot be written
		() => data.notes.patch('a', { missing: 'x' });
	});
});

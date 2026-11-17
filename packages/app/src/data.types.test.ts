/**
 * Data declaration types retain field inference and select handles by the key suffix.
 * Negative cases keep ids mandatory for folders and refs confined to public folder keys.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	ActionError,
	createMemoryContext,
	defineData,
	field,
	inRun,
	Ok,
} from './index.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;
const data = defineData({
	notes: {
		fields: {
			title: field.text(),
			note: field.text({ optional: true }),
			n: field.integer(),
			done: field.boolean(),
			tags: field.list(field.text()),
			choice: field.select(['yes', 'no']),
			raw: Type.Number(),
			created: field.datetime(),
		},
	},
	'settings.md': { fields: { level: field.integer() } },
	watches: { fields: {} },
	checks: {
		fields: {
			watch: field.ref('watches'),
			many: field.list(field.ref('watches')),
			maybe: field.ref('watches', { optional: true }),
		},
	},
	'secret.local': { fields: {} },
});
type Note = NonNullable<Awaited<ReturnType<typeof data.notes.get>>['data']>;
type Settings = NonNullable<
	Awaited<ReturnType<(typeof data)['settings.md']['get']>>['data']
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
				done: boolean;
				tags: string[];
				choice: 'yes' | 'no';
				raw: number;
				created: string;
			}
		>
	>();
	assertType<Equal<Settings, { path: string; body: string; level: number }>>();
	assertType<Equal<Parameters<typeof data.notes.get>, [id: string]>>();
	assertType<Equal<Parameters<(typeof data)['settings.md']['get']>, []>>();
	type Check = NonNullable<Awaited<ReturnType<typeof data.checks.get>>['data']>;
	assertType<Equal<Check['watch'], string>>();
	assertType<Equal<Check['many'], string[]>>();
	assertType<Equal<Check['maybe'], string | undefined>>();
	expect(data.notes).toHaveProperty('list');
	expect(data['settings.md']).not.toHaveProperty('list');
});

test('computed changes retain field types and callback errors', async () => {
	await inRun(createMemoryContext(), async () => {
		expect(
			expectOk(
				await data['settings.md'].update((record) => {
					assertType<Equal<typeof record, Settings | undefined>>();
					return Ok({ level: record?.level ?? 1 });
				}),
			).level,
		).toBe(1);
		const result = await data.notes.update('a', () =>
			ActionError.Refused({ message: 'stop' }),
		);
		expect(expectErr(result).message).toBe('stop');
	});
});

describe('type errors', () => {
	test('folder and one-file handles require different arguments and verbs', () => {
		// @ts-expect-error a folder record needs an id
		() => data.notes.get();
		// @ts-expect-error one-file keys have no list
		() => data['settings.md'].list();
		// @ts-expect-error one-file keys have no add
		() => data['settings.md'].add('id', {});
		// @ts-expect-error one-file reads take no id
		() => data['settings.md'].get('id');
		// @ts-expect-error numbers stay numbers
		() => data.notes.set('a', { n: 'bad' });
		// @ts-expect-error required fields cannot be removed
		() => data.notes.set('a', { title: null });
		// @ts-expect-error set accepts an object, not a callback
		() => data.notes.set('a', () => Ok({ title: 'x' }));
		// @ts-expect-error update returns a Result
		() => data.notes.update('a', () => ({ title: 'x' }));
		// @ts-expect-error add needs the required fields, including read-only fields
		() => data.notes.add('a', { title: 'only title' });
		// @ts-expect-error undeclared fields cannot be written
		() => data.notes.set('a', { missing: 'x' });
	});
	test('refs reject missing, one-file, and local targets on the field', () => {
		() =>
			defineData({
				notes: {
					fields: {
						// @ts-expect-error target must exist in this declaration
						target: field.ref('missing'),
					},
				},
			});
		() =>
			defineData({
				'settings.md': { fields: {} },
				notes: {
					fields: {
						// @ts-expect-error a one-file key is not a ref target
						target: field.ref('settings.md'),
					},
				},
			});
		() =>
			defineData({
				'secret.local': { fields: {} },
				notes: {
					fields: {
						// @ts-expect-error a local key is not a ref target
						target: field.ref('secret.local'),
					},
				},
			});
		() =>
			defineData({
				notes: {
					fields: {
						// @ts-expect-error list items retain the missing ref target
						targets: field.list(field.ref('missing')),
					},
				},
			});
		() =>
			defineData({
				notes: {
					fields: {
						// @ts-expect-error optional refs retain the missing target
						target: field.ref('missing', { optional: true }),
					},
				},
			});
	});
});

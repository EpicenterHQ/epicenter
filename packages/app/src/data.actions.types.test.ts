/**
 * Generated action types preserve exactly the selected verbs and declared fields.
 * Checks caller inputs, precise Result outputs, filled fields, and key-specific verbs.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import type { ActionUpdate, DataRecord, Result } from './index.ts';
import { defineData, field } from './index.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

const data = defineData({
	words: {
		fields: {
			meaning: field.text(),
			note: field.text({ optional: true }),
			rank: field.integer(),
			done: field.boolean(),
			tags: field.list(field.text()),
			choice: field.select(['yes', 'no']),
			raw: Type.Number(),
		},
	},
	'settings.md': {
		fields: { level: field.integer(), note: field.text({ optional: true }) },
	},
});
const actions = data.words.actions('list', 'get', 'add', 'set', 'delete');
const settings = data['settings.md'].actions('get', 'set', 'delete');
type Word = DataRecord<'words', typeof data.words>;
type Settings = DataRecord<'settings.md', (typeof data)['settings.md']>;

test('returned keys are exactly the requested verbs and actions send no updates', () => {
	const selected = data.words.actions('get', 'set');
	assertType<Equal<keyof typeof selected, 'get' | 'set'>>();
	assertType<Equal<keyof typeof settings, 'get' | 'set' | 'delete'>>();
	assertType<Equal<ActionUpdate<typeof actions.add>, never>>();
	expect(Object.keys(selected)).toEqual(['get', 'set']);
});

test('action inputs retain required add fields and optional nullable patches', () => {
	assertType<
		Equal<Parameters<typeof actions.list>[0], Record<string, never>>
	>();
	assertType<Equal<Parameters<typeof actions.get>[0], { id: string }>>();
	assertType<Equal<Parameters<typeof actions.delete>[0], { id: string }>>();
	assertType<
		Equal<
			Parameters<typeof actions.add>[0],
			{
				id: string;
				meaning: string;
				note?: string;
				rank: number;
				done?: boolean;
				tags?: string[];
				choice: 'yes' | 'no';
				raw: number;
				body?: string;
			}
		>
	>();
	assertType<
		Equal<
			Parameters<typeof actions.set>[0],
			{
				id: string;
				meaning?: string;
				note?: string | null;
				rank?: number;
				done?: boolean | null;
				tags?: string[] | null;
				choice?: 'yes' | 'no';
				raw?: number;
				body?: string;
				edit?: { old: string; new: string };
			}
		>
	>();
	assertType<
		Equal<Parameters<typeof settings.get>[0], Record<string, never>>
	>();
	assertType<
		Equal<Parameters<typeof settings.delete>[0], Record<string, never>>
	>();
	assertType<
		Equal<
			Parameters<typeof settings.set>[0],
			{
				level?: number;
				note?: string | null;
				body?: string;
				edit?: { old: string; new: string };
			}
		>
	>();
});

test('action answers retain precise record, absence, and error types', () => {
	type Answer<TAction extends (...args: never[]) => unknown> = Awaited<
		ReturnType<TAction>
	>;
	assertType<Equal<Answer<typeof actions.get>['data'], Word | null>>();
	assertType<
		Equal<Answer<typeof settings.get>['data'], Settings | undefined | null>
	>();
	assertType<Equal<Answer<typeof actions.add>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.set>['data'], Word | null>>();
	assertType<Equal<Answer<typeof settings.set>['data'], Settings | null>>();
	assertType<Equal<Answer<typeof actions.delete>['data'], boolean | null>>();
	assertType<Equal<Answer<typeof settings.delete>, Result<boolean, never>>>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.get>['error']>['name'],
			'Missing' | 'Misfit' | 'Refused'
		>
	>();
	assertType<
		Equal<NonNullable<Answer<typeof settings.get>['error']>['name'], 'Misfit'>
	>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.add>['error']>['name'],
			'Changed' | 'Refused'
		>
	>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.set>['error']>['name'],
			'Changed' | 'Refused' | 'Misfit' | 'Missing'
		>
	>();
	assertType<
		Equal<
			NonNullable<Answer<typeof settings.set>['error']>['name'],
			'Changed' | 'Refused' | 'Misfit'
		>
	>();
	type Listed = NonNullable<Answer<typeof actions.list>['data']>[number];
	assertType<Equal<Listed['data'], Word | null>>();
	assertType<Equal<NonNullable<Listed['error']>['name'], 'Misfit'>>();
	assertType<
		Equal<
			NonNullable<
				Answer<typeof actions.get>['error'] & { name: 'Misfit' }
			>['record'],
			| {
					path: string;
					id: string;
					body: string;
					meaning?: string;
					note?: string;
					rank?: number;
					done?: boolean;
					tags?: string[];
					choice?: 'yes' | 'no';
					raw?: number;
			  }
			| undefined
		>
	>();
});

describe('type errors', () => {
	test('verbs must be explicitly named and offered by the key', () => {
		// @ts-expect-error a verb is required
		() => data.words.actions();
		// @ts-expect-error a verb is required for one-file keys too
		() => data['settings.md'].actions();
		// @ts-expect-error one-file keys have no list
		() => data['settings.md'].actions('list');
		// @ts-expect-error one-file keys have no add
		() => data['settings.md'].actions('get', 'add');
		// @ts-expect-error update is only on the handle
		() => data.words.actions('update');
		// @ts-expect-error an unselected verb is absent
		() => data.words.actions('get').add;
	});

	test('calling an action rejects the wrong input shape', () => {
		// @ts-expect-error folder get needs id
		() => actions.get({});
		// @ts-expect-error id must be text
		() => actions.get({ id: 1 });
		// @ts-expect-error folder delete needs id
		() => actions.delete({});
		// @ts-expect-error list takes no fields
		() => actions.list({ id: 'a' });
		// @ts-expect-error add requires all required fields
		() => actions.add({ id: 'a', meaning: 'a' });
		// @ts-expect-error add requires id even when every field is supplied
		() => actions.add({ meaning: 'a', rank: 1, choice: 'yes', raw: 2 });
		// @ts-expect-error required numbers stay numbers
		() => actions.set({ id: 'a', rank: 'one' });
		// @ts-expect-error required fields cannot be removed
		() => actions.set({ id: 'a', meaning: null });
		// @ts-expect-error body cannot be removed
		() => actions.set({ id: 'a', body: null });
		// @ts-expect-error edits need old and new
		() => actions.set({ id: 'a', edit: { old: 'x' } });
		// @ts-expect-error set has no was guard
		() => actions.set({ id: 'a', was: {} });
		// @ts-expect-error one-file reads take no id
		() => settings.get({ id: 'a' });
		// @ts-expect-error one-file deletes take no id
		() => settings.delete({ id: 'a' });
		// @ts-expect-error one-file changes take no id
		() => settings.set({ id: 'a', level: 2 });
		// @ts-expect-error one-file fields retain their declared types
		() => settings.set({ level: 'two' });
	});
});

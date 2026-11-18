/**
 * Generated action types preserve exactly the selected verbs and declared fields.
 * Checks caller inputs, precise Result outputs, filled fields, and key-specific verbs.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import type { ActionUpdate, DataRecord, Result } from './index.ts';
import { defineData, field } from './index.ts';
import {
	assertType,
	type Equal,
	unusedFolder,
} from './library.test-support.ts';

// Only types are checked here, so the folder is never used.
const data = defineData(unusedFolder, {
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
const actions = data.words.actions(
	'list',
	'get',
	'create',
	'patch',
	'edit',
	'delete',
);
const settings = data['settings.md'].actions('get', 'patch', 'edit', 'delete');
type Word = DataRecord<'words', typeof data.words>;
type Settings = DataRecord<'settings.md', (typeof data)['settings.md']>;

test('returned keys are exactly the requested verbs and actions send no updates', () => {
	const selected = data.words.actions('get', 'patch');
	assertType<Equal<keyof typeof selected, 'get' | 'patch'>>();
	assertType<
		Equal<keyof typeof settings, 'get' | 'patch' | 'edit' | 'delete'>
	>();
	assertType<Equal<ActionUpdate<typeof actions.create>, never>>();
	expect(Object.keys(selected)).toEqual(['get', 'patch']);
});

test('action inputs retain required create fields, optional nullable patches, and a bare passage edit', () => {
	assertType<
		Equal<Parameters<typeof actions.list>[0], Record<string, never>>
	>();
	assertType<Equal<Parameters<typeof actions.get>[0], { id: string }>>();
	assertType<Equal<Parameters<typeof actions.delete>[0], { id: string }>>();
	assertType<
		Equal<
			Parameters<typeof actions.create>[0],
			{
				id?: string;
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
			Parameters<typeof actions.patch>[0],
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
			}
		>
	>();
	assertType<
		Equal<
			Parameters<typeof actions.edit>[0],
			{ id: string; old: string; new: string }
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
			Parameters<typeof settings.patch>[0],
			{ level?: number; note?: string | null; body?: string }
		>
	>();
	assertType<
		Equal<Parameters<typeof settings.edit>[0], { old: string; new: string }>
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
	assertType<Equal<Answer<typeof actions.create>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.patch>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.edit>['data'], Word | null>>();
	assertType<Equal<Answer<typeof settings.patch>['data'], Settings | null>>();
	assertType<Equal<Answer<typeof settings.edit>['data'], Settings | null>>();
	assertType<Equal<Answer<typeof actions.delete>['data'], boolean | null>>();
	assertType<Equal<Answer<typeof settings.delete>, Result<boolean, never>>>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.get>['error']>['name'],
			'Missing' | 'Misfit'
		>
	>();
	assertType<
		Equal<NonNullable<Answer<typeof settings.get>['error']>['name'], 'Misfit'>
	>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.create>['error']>['name'],
			'Changed' | 'Misfit'
		>
	>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.patch>['error']>['name'],
			'Changed' | 'Misfit' | 'Missing'
		>
	>();
	assertType<
		Equal<
			NonNullable<Answer<typeof settings.patch>['error']>['name'],
			'Changed' | 'Misfit'
		>
	>();
	// A passage edit of an absent file is Missing for both key shapes.
	for (const edit of [actions.edit, settings.edit])
		assertType<
			Equal<
				NonNullable<Answer<typeof edit>['error']>['name'],
				'Changed' | 'Misfit' | 'Missing'
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
		// @ts-expect-error one-file keys have no create
		() => data['settings.md'].actions('get', 'create');
		// @ts-expect-error the old verbs are gone
		() => data.words.actions('set');
		// @ts-expect-error an unselected verb is absent
		() => data.words.actions('get').create;
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
		// @ts-expect-error create requires all required fields
		() => actions.create({ id: 'a', meaning: 'a' });
		// @ts-expect-error required numbers stay numbers
		() => actions.patch({ id: 'a', rank: 'one' });
		// @ts-expect-error required fields cannot be removed
		() => actions.patch({ id: 'a', meaning: null });
		// @ts-expect-error body cannot be removed
		() => actions.patch({ id: 'a', body: null });
		// @ts-expect-error patch takes no passage
		() => actions.patch({ id: 'a', edit: { old: 'x', new: 'y' } });
		// @ts-expect-error edits need old and new
		() => actions.edit({ id: 'a', old: 'x' });
		// @ts-expect-error a passage edit carries no fields
		() => actions.edit({ id: 'a', old: 'x', new: 'y', rank: 2 });
		// @ts-expect-error one-file edits take no id
		() => settings.edit({ id: 'a', old: 'x', new: 'y' });
		// @ts-expect-error patch has no was guard
		() => actions.patch({ id: 'a', was: {} });
		// @ts-expect-error one-file reads take no id
		() => settings.get({ id: 'a' });
		// @ts-expect-error one-file deletes take no id
		() => settings.delete({ id: 'a' });
		// @ts-expect-error one-file changes take no id
		() => settings.patch({ id: 'a', level: 2 });
		// @ts-expect-error one-file fields retain their declared types
		() => settings.patch({ level: 'two' });
	});
});

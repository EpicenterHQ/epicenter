/**
 * Generated action types preserve exactly the selected verbs and declared fields.
 * Checks caller inputs, precise Result outputs, and optional fields.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import type { ActionUpdate, DataRecord } from './index.ts';
import { defineData, field } from './index.ts';
import {
	assertType,
	type Equal,
	unusedFolder,
} from './library.test-support.ts';

// Only types are checked here, so the folder is never used.
const data = defineData(unusedFolder, {
	words: {
		description: 'word',
		fields: {
			meaning: field.text(),
			note: field.text({ optional: true }),
			rank: field.integer(),
			done: field.boolean({ optional: true }),
			tags: field.list(field.text(), { optional: true }),
			choice: field.select(['yes', 'no']),
			raw: Type.Number(),
		},
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
type Word = DataRecord<typeof data.words>;

test('returned keys are exactly the requested verbs and actions send no updates', () => {
	const selected = data.words.actions('get', 'patch');
	assertType<Equal<keyof typeof selected, 'get' | 'patch'>>();
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
});

test('action answers retain precise record, absence, and error types', () => {
	type Answer<TAction extends (...args: never[]) => unknown> = Awaited<
		ReturnType<TAction>
	>;
	assertType<Equal<Answer<typeof actions.get>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.create>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.patch>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.edit>['data'], Word | null>>();
	assertType<Equal<Answer<typeof actions.delete>['data'], boolean | null>>();
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.get>['error']>['name'],
			'Missing' | 'Misfit'
		>
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
	// A passage edit of an absent file is Missing.
	assertType<
		Equal<
			NonNullable<Answer<typeof actions.edit>['error']>['name'],
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
	test('verbs must be explicitly named', () => {
		// @ts-expect-error a verb is required
		() => data.words.actions();
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
		// @ts-expect-error patch has no was guard
		() => actions.patch({ id: 'a', was: {} });
	});
});

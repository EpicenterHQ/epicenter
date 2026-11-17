/**
 * Collection contracts checked by TypeScript: fitting records, partial Misfits,
 * Result callbacks, keyed and single methods, and generated verb inputs.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { defineAction } from './action.ts';
import {
	defineCollection,
	type MisfitOf,
	type RecordOf,
	type Row,
} from './collection.ts';
import { inRun } from './context.ts';
import type { ActionError } from './errors.ts';
import { field } from './field.ts';
import { createMemoryContext } from './memory.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;
type In<A> = A extends (input: infer I) => unknown ? I : never;
type Out<A> = A extends (input: never) => infer O ? Awaited<O> : never;
type Missing = Extract<ActionError, { name: 'Missing' }>;
type Refused = Extract<ActionError, { name: 'Refused' }>;
type Changed = Extract<ActionError, { name: 'Changed' }>;
const tasks = defineCollection({
	path: 'data/tasks/{id}.md',
	fields: {
		title: field.text(),
		note: field.text({ optional: true }),
		done: field.boolean(),
		tags: field.list(field.text()),
	},
});
const settings = defineCollection({
	path: 'data/settings.md',
	fields: { dailyGoal: field.integer({ optional: true }) },
});
const words = defineCollection({
	path: 'data/words/{word}.md',
	fields: {
		meaning: field.text({ optional: true }),
		createdAt: field.datetime({ readOnly: true }),
		due: field.datetime({ optional: true, readOnly: true }),
	},
});
type Task = RecordOf<typeof tasks>;
type TaskMisfit = MisfitOf<typeof tasks>;
type Settings = RecordOf<typeof settings>;
type SettingsMisfit = MisfitOf<typeof settings>;
type SetErrors = Missing | TaskMisfit | Refused | Changed;

test('a collection is what it was defined with, plus Result methods', () => {
	assertType<Equal<typeof tasks.path, 'data/tasks/{id}.md'>>();
	assertType<Equal<Parameters<typeof tasks.get>, [keys: { id: string }]>>();
	assertType<Equal<Parameters<typeof settings.get>, []>>();
	assertType<
		Equal<
			ReturnType<typeof tasks.get>,
			Promise<Result<Task | undefined, TaskMisfit | Refused>>
		>
	>();
	assertType<
		Equal<ReturnType<typeof tasks.list>, Promise<Result<Task, TaskMisfit>[]>>
	>();
	assertType<
		Equal<
			ReturnType<typeof tasks.add>,
			Promise<Result<Task, Refused | Changed>>
		>
	>();
	assertType<Equal<ReturnType<typeof tasks.delete>, Promise<boolean>>>();
	assertType<Equal<ReturnType<typeof tasks.pathOf>, string>>();
	assertType<
		Equal<
			ReturnType<typeof settings.get>,
			Promise<Result<Settings, SettingsMisfit>>
		>
	>();
	assertType<
		Equal<
			ReturnType<typeof settings.list>,
			Promise<Result<Settings, SettingsMisfit>[]>
		>
	>();
	assertType<Equal<ReturnType<typeof settings.delete>, Promise<boolean>>>();
	expect(tasks.path).toBe('data/tasks/{id}.md');
});

test('a record has required fields and no problems; Misfit holds a partial record', () => {
	assertType<
		Equal<
			Task,
			{
				path: string;
				id: string;
				title: string;
				note?: string;
				done: boolean;
				tags: string[];
				body: string;
			}
		>
	>();
	assertType<
		Equal<
			NonNullable<TaskMisfit['record']>,
			{
				path: string;
				id: string;
				title?: string;
				note?: string;
				done?: boolean;
				tags?: string[];
				body: string;
			}
		>
	>();
	assertType<Equal<Extract<keyof Task, 'problems'>, never>>();
	assertType<
		Equal<
			TaskMisfit extends Extract<ActionError, { name: 'Misfit' }>
				? true
				: false,
			true
		>
	>();
	expect('need' in tasks).toBe(false);
	// @ts-expect-error need was removed
	() => tasks.need;
});

test('set and update accept only Result callbacks and preserve custom errors', () => {
	const Declined = defineErrors({
		Later: () => ({ message: 'later', after: 1 }),
	});
	() =>
		inRun(createMemoryContext(), async () => {
			const plain = tasks.set({ id: 'a' }, { title: 'next' });
			assertType<Equal<typeof plain, Promise<Result<Task, SetErrors>>>>();
			const set = tasks.set({ id: 'a' }, (record) => {
				assertType<Equal<typeof record, Task>>();
				return Ok({ title: record.title });
			});
			assertType<Equal<typeof set, Promise<Result<Task, SetErrors>>>>();
			const update = tasks.update({ id: 'a' }, (record) => {
				assertType<Equal<typeof record, Task | undefined>>();
				return Ok({ title: record?.title ?? 'new' });
			});
			assertType<
				Equal<
					typeof update,
					Promise<Result<Task, TaskMisfit | Refused | Changed>>
				>
			>();
			const custom = tasks.set({ id: 'a' }, () => Declined.Later());
			assertType<
				Equal<
					typeof custom,
					Promise<
						Result<Task, SetErrors | ReturnType<typeof Declined.Later>['error']>
					>
				>
			>();
			const customUpdate = tasks.update({ id: 'a' }, () => Declined.Later());
			assertType<
				Equal<
					typeof customUpdate,
					Promise<
						Result<
							Task,
							| TaskMisfit
							| Refused
							| Changed
							| ReturnType<typeof Declined.Later>['error']
						>
					>
				>
			>();
			const singlePlain = settings.set({ dailyGoal: 2 });
			assertType<
				Equal<
					typeof singlePlain,
					Promise<Result<Settings, SettingsMisfit | Refused | Changed>>
				>
			>();
			const single = settings.set((record) => {
				assertType<Equal<typeof record, Settings>>();
				return Ok({ dailyGoal: 1 });
			});
			assertType<
				Equal<
					typeof single,
					Promise<Result<Settings, SettingsMisfit | Refused | Changed>>
				>
			>();
			const singleUpdate = settings.update((record) => {
				assertType<Equal<typeof record, Settings>>();
				return Ok({ dailyGoal: record.dailyGoal ?? 1 });
			});
			assertType<
				Equal<
					typeof singleUpdate,
					Promise<Result<Settings, SettingsMisfit | Refused | Changed>>
				>
			>();
			// @ts-expect-error a callback must return a Result
			tasks.set({ id: 'a' }, () => ({ title: 'plain' }));
			// @ts-expect-error update also requires a Result
			tasks.update({ id: 'a' }, () => ({ title: 'plain' }));
			// @ts-expect-error single files have no add
			settings.add({});
			// @ts-expect-error keys do not name single files
			settings.get({ id: 'a' });
			// @ts-expect-error required title cannot be removed
			tasks.set({ id: 'a' }, { title: null });
		});
	expect(typeof tasks.update).toBe('function');
});

test('a required readOnly field leaves add out, and delete comes only when named', () => {
	const verbs = words.actions();
	assertType<Equal<keyof typeof verbs, 'list' | 'get' | 'set'>>();
	const deletion = words.actions('delete');
	assertType<Equal<keyof typeof deletion, 'delete'>>();
	// @ts-expect-error required app-owned fields prevent exposing add
	() => words.actions('add');
	expect(Object.keys(verbs)).toEqual(['list', 'get', 'set']);
});

test('verbs have precise inputs and Result outputs for keyed and single collections', () => {
	const verbs = words.actions();
	const single = settings.actions();
	const deletion = words.actions('delete');
	type Word = RecordOf<typeof words>;
	assertType<
		Equal<
			Out<typeof verbs.get>,
			Result<Word, MisfitOf<typeof words> | Missing | Refused>
		>
	>();
	assertType<
		Equal<
			Out<typeof verbs.list>,
			Result<
				Result<Row<typeof words>, MisfitOf<typeof words, unknown>>[],
				never
			>
		>
	>();
	assertType<
		Equal<
			Out<typeof verbs.set>,
			Result<Word, MisfitOf<typeof words> | Missing | Refused | Changed>
		>
	>();
	assertType<Equal<Out<typeof deletion.delete>, Result<boolean, Refused>>>();
	assertType<Equal<Out<typeof single.get>, Result<Settings, SettingsMisfit>>>();
	assertType<
		Equal<
			Out<typeof single.list>,
			Result<
				Result<Row<typeof settings>, MisfitOf<typeof settings, unknown>>[],
				never
			>
		>
	>();
	assertType<
		Equal<
			Out<typeof single.set>,
			Result<Settings, SettingsMisfit | Refused | Changed>
		>
	>();
	assertType<
		Equal<
			Out<ReturnType<typeof settings.actions<'delete'>>['delete']>,
			Result<boolean, never>
		>
	>();
	assertType<Equal<In<typeof verbs.get>, { word: string }>>();
	assertType<Equal<In<typeof single.get>, Record<string, never>>>();
	assertType<
		Equal<
			In<typeof verbs.set>,
			{
				word: string;
				meaning?: string | null;
				was?: {
					meaning?: string | null;
					createdAt?: string | null;
					due?: string | null;
				};
				edit?: { old: string; new: string };
			}
		>
	>();
	assertType<
		Equal<
			In<typeof single.set>,
			{
				dailyGoal?: number | null;
				was?: { dailyGoal?: number | null };
				edit?: { old: string; new: string };
			}
		>
	>();
	assertType<Equal<keyof typeof single, 'list' | 'get' | 'set'>>();
	// @ts-expect-error a single file has no add verb
	() => settings.actions('add');
	expect(Object.keys(single)).toEqual(['list', 'get', 'set']);
});

test('a list reads as an array, is optional to write, and a reference is text', () => {
	const shelves = defineCollection({
		path: 'data/shelves/{shelf}.md',
		fields: {},
	});
	const books = defineCollection({
		path: 'data/books/{book}.md',
		fields: {
			platforms: field.list(field.select(['x', 'threads'])),
			ratings: field.list(field.integer(), { readOnly: true }),
			shelf: field.ref(shelves),
			shelves: field.list(field.ref(shelves)),
			people: field.list(Type.Object({ name: Type.String() })),
		},
	});
	assertType<
		Equal<
			RecordOf<typeof books>,
			{
				path: string;
				book: string;
				platforms: ('x' | 'threads')[];
				ratings: number[];
				shelf: string;
				shelves: string[];
				people: { name: string }[];
				body: string;
			}
		>
	>();
	const { add } = books.actions('add');
	assertType<
		Equal<
			In<typeof add>,
			{
				book: string;
				platforms?: ('x' | 'threads')[];
				shelf: string;
				shelves?: string[];
				people?: { name: string }[];
				body?: string;
			}
		>
	>();
	assertType<
		Equal<Out<typeof add>, Result<RecordOf<typeof books>, Refused | Changed>>
	>();
	const shelve = defineAction({
		description: 'Shelve',
		input: {
			shelves: field.list(field.ref(shelves)),
			shelf: field.ref(shelves, { optional: true }),
		},
		run: ({ shelves, shelf }) => {
			assertType<Equal<typeof shelves, string[]>>();
			assertType<Equal<typeof shelf, string | undefined>>();
			return Ok(shelves.length);
		},
	});
	assertType<
		Equal<In<typeof shelve>, { shelves?: string[]; shelf?: string }>
	>();
	expect(add.input.shelf).toBeDefined();
});

test('a list with min is required in add and in a fitting read', () => {
	const trips = defineCollection({
		path: 'data/trips/{trip}.md',
		fields: { airports: field.list(field.text(), { min: 1 }) },
	});
	assertType<Equal<RecordOf<typeof trips>['airports'], string[]>>();
	const verbs = trips.actions();
	assertType<
		Equal<
			In<typeof verbs.add>,
			{ trip: string; airports: string[]; body?: string }
		>
	>();
	assertType<
		Equal<
			In<typeof verbs.set>,
			{
				trip: string;
				airports?: string[];
				was?: { airports?: string[] | null };
				edit?: { old: string; new: string };
			}
		>
	>();
	expect(verbs.add.input.airports).toBeDefined();
});

test('add takes every placeholder but time and a collection has one path', () => {
	const notes = defineCollection({
		path: 'data/notes/{year}/{time}.md',
		fields: { title: field.text() },
	});
	assertType<
		Equal<
			Parameters<typeof notes.add>[0],
			{ year: string; title: string; body?: string }
		>
	>();
	() =>
		defineCollection({
			// @ts-expect-error a collection has one path
			path: ['data/a/{id}.md', 'data/b/{id}.md'],
			fields: {},
		});
	expect(notes.path).toBe('data/notes/{year}/{time}.md');
});

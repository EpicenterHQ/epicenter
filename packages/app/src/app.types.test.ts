/**
 * What an app author's editor shows: each check is a compile-time assertion,
 * run by `tsc`; the test bodies only keep `bun test` from skipping the file.
 */
import { describe, test } from 'bun:test';
import { Type } from 'typebox';
import type { ActionInput, ActionOutput, AppClient } from './client.ts';
import type { JsonValue } from './front-matter.ts';
import {
	createMemoryContext,
	defineAction,
	defineApp,
	defineCollection,
	field,
	inRun,
} from './index.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

const words = defineCollection({
	path: 'words/{word}.md',
	fields: {
		meaning: field.text({ optional: true }),
		createdAt: field.datetime({ readOnly: true }),
		due: field.datetime({ optional: true, readOnly: true }),
	},
});

const settings = defineCollection({
	path: 'settings.md',
	fields: { dailyGoal: field.integer({ optional: true }) },
});

const learn = defineAction({
	description: 'Learn a word, due now',
	input: { word: field.text(), meaning: field.text({ optional: true }) },
	positional: ['word', 'meaning'],
	run: async ({ word, meaning }) => {
		assertType<Equal<typeof word, string>>();
		assertType<Equal<typeof meaning, string | undefined>>();
		const goal = (await settings.get()).dailyGoal;
		assertType<Equal<typeof goal, number | undefined>>();
		// The handle writes readOnly fields; the exposed add and set do not take them.
		return words.add({ word, meaning, createdAt: '2026-11-10T00:00:00Z' });
	},
});

const review = defineAction({
	description: 'Schedule a word',
	input: { path: field.text() },
	run: async ({ path }) => {
		const found = await words.get({ path });
		assertType<
			Equal<NonNullable<typeof found>['meaning'], string | undefined>
		>();
		await words.set({ path, due: '2026-11-11T04:00:00Z' });
		// @ts-expect-error a collection of many files has no get without a path
		await words.get();
		return found?.meaning;
	},
});

const vocab = defineApp({
	description: 'Words I am learning',
	collections: { words, settings },
	actions: {
		words: { ...words.actions(), add: learn },
		settings: settings.actions(),
		review,
	},
});

type Actions = typeof vocab.actions;
type In<A> = A extends (input: infer I) => unknown ? I : never;
type Out<A> = A extends (input: never) => infer O ? Awaited<O> : never;

describe('an app author', () => {
	test('gets every action under its words, with exact inputs and outputs', () => {
		assertType<Equal<keyof Actions, 'words' | 'settings' | 'review'>>();
		assertType<
			Equal<
				keyof Actions['words'],
				'list' | 'get' | 'add' | 'set' | 'edit' | 'delete'
			>
		>();
		assertType<Equal<keyof Actions['settings'], 'get' | 'set' | 'edit'>>();
		assertType<
			Equal<
				In<Actions['words']['set']>,
				{ path: string; meaning?: string | null | undefined }
			>
		>();
		assertType<
			Equal<
				Out<Actions['words']['list']>[number],
				{
					path: string;
					word: string;
					meaning?: string;
					createdAt?: string;
					due?: string;
					problems?: string[];
				}
			>
		>();
		assertType<
			Equal<
				In<Actions['settings']['set']>,
				{ dailyGoal?: number | null | undefined }
			>
		>();
		assertType<
			Equal<In<Actions['words']['add']>, { word: string; meaning?: string }>
		>();
		assertType<Equal<Out<Actions['review']>, string | undefined>>();
	});

	test('an action is called as a function, inside a run', async () => {
		await inRun(createMemoryContext(), () =>
			vocab.actions.words.add({ word: '你好' }),
		);
	});

	test('a collection is what it was defined with, plus its methods', () => {
		assertType<Equal<typeof words.path, 'words/{word}.md'>>();
		assertType<Equal<typeof settings.holds, (path: string) => boolean>>();
	});

	test('a read has a defaulted field always, every other field maybe, and placeholders every path has', () => {
		const tasks = defineCollection({
			path: ['tasks/{id}.md', 'tasks/done/{id}.md', 'tasks/{year}/{id}.md'],
			fields: {
				title: field.text(),
				done: field.boolean(),
				tags: field.tags(),
			},
		});
		type Read = Awaited<ReturnType<typeof tasks.list>>[number];
		assertType<
			Equal<
				Read,
				{
					path: string;
					id: string;
					year?: string;
					title?: string;
					done: boolean;
					tags: string[];
					problems?: string[];
				}
			>
		>();
		assertType<Equal<Parameters<typeof tasks.pathOf>[0], { id: string }>>();
		assertType<Equal<Parameters<typeof words.pathOf>[0], { word: string }>>();
	});

	test('a required readOnly field without a default leaves add out', () => {
		assertType<
			Equal<
				keyof ReturnType<typeof words.actions>,
				'list' | 'get' | 'set' | 'edit' | 'delete'
			>
		>();
		// @ts-expect-error words has a required readOnly createdAt, so no add
		() => words.actions('add');
		const flags = defineCollection({
			path: 'flags/{id}.md',
			fields: {
				pinned: field.boolean({ readOnly: true }),
				labels: field.tags({ readOnly: true }),
			},
		});
		type SetIn = In<ReturnType<typeof flags.actions<'set'>>['set']>;
		assertType<Equal<SetIn, { path: string }>>();
	});

	test('a caller may leave out a defaulted field, and run receives it', () => {
		const tag = defineAction({
			description: 'Tag',
			input: { tags: field.tags(), done: field.boolean() },
			run: ({ tags, done }) => {
				assertType<Equal<typeof tags, string[]>>();
				assertType<Equal<typeof done, boolean>>();
				return { count: tags.length, at: done ? 'now' : undefined };
			},
		});
		assertType<
			Equal<ActionInput<typeof tag>, { tags?: string[]; done?: boolean }>
		>();
		assertType<
			Equal<ActionOutput<typeof tag>, { count: number; at?: string }>
		>();
		const nothing = defineAction({ description: 'n', input: {}, run() {} });
		assertType<Equal<ActionOutput<typeof nothing>, null>>();
		defineAction({
			description: 'Now',
			input: {},
			// @ts-expect-error a Date is not a value JSON carries
			run: () => ({ at: new Date() }),
		});
	});

	test('a one-file collection has no list, add, or delete', () => {
		// @ts-expect-error settings.md is one file
		() => settings.actions('list');
		// @ts-expect-error settings.md is one file
		() => settings.delete;
	});

	test('add takes every placeholder but {time}', () => {
		const notes = defineCollection({
			path: 'notes/{year}/{time}.md',
			fields: { title: field.text() },
		});
		type AddIn = In<ReturnType<typeof notes.actions<'add'>>['add']>;
		assertType<Equal<AddIn, { year: string; title: string; body?: string }>>();
	});

	test('a collection in several places adds to the first', () => {
		const entries = defineCollection({
			path: ['entries/{time}.md', 'entries/archive/{slug}.md'],
			fields: { text: field.text() },
		});
		type AddIn = In<ReturnType<typeof entries.actions<'add'>>['add']>;
		assertType<Equal<AddIn, { text: string; body?: string }>>();
	});

	test('raw TypeBox sits beside fields', () => {
		defineAction({
			description: 'Log minutes',
			input: { minutes: Type.Number({ minimum: 0 }) },
			run: ({ minutes }) => {
				assertType<Equal<typeof minutes, number>>();
			},
		});
	});

	test('a UI calls under the same words, typed by the app', () => {
		const vocabUi = {} as AppClient<Actions>;
		const call = () => vocabUi.words.set({ path: 'words/a.md', meaning: 'x' });
		assertType<
			Equal<
				Awaited<ReturnType<typeof call>>,
				{
					path: string;
					word: string;
					meaning?: string;
					createdAt?: string;
					due?: string;
					body: string;
					problems?: string[];
					other?: Record<string, JsonValue>;
				}
			>
		>();
		// @ts-expect-error due is written only by Vocab's own actions
		() => vocabUi.words.set({ path: 'words/a.md', due: 'x' });
		// @ts-expect-error settings has no list
		() => vocabUi.settings.list();
		() => vocabUi.words.list();
		() => vocabUi.review({ path: 'words/a.md' });
		// @ts-expect-error no action is named then
		() => vocabUi.then;
	});
});

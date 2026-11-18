/**
 * What an app author's editor shows: each check is a compile-time assertion,
 * run by `tsc`; the test bodies only keep `bun test` from skipping the file.
 */
import { describe, test } from 'bun:test';
import { Type } from 'typebox';
import { type Err, Ok, type Result } from 'wellcrafted/result';
import type { ActionUpdate, Update } from './action.ts';
import type {
	ActionError,
	ActionInput,
	ActionOutput,
	AppClient,
} from './client.ts';
import { connect } from './client.ts';
import {
	defineAction,
	defineApp,
	defineData,
	type Folder,
	field,
} from './index.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

const vocab = defineApp(({ folder }) => {
	const data = defineData(folder, {
		words: { fields: { meaning: field.text({ optional: true }) } },
		'settings.md': { fields: { dailyGoal: field.integer({ optional: true }) } },
	});

	const learn = defineAction({
		description: 'Learn a word',
		input: { word: field.text(), meaning: field.text({ optional: true }) },
		run: async ({ word, meaning }) => {
			assertType<Equal<typeof word, string>>();
			assertType<Equal<typeof meaning, string | undefined>>();
			const setting = await data['settings.md'].get();
			if (setting.error) return setting;
			const goal = setting.data?.dailyGoal;
			assertType<Equal<typeof goal, number | undefined>>();
			return data.words.create(word, { meaning });
		},
	});

	const review = defineAction({
		description: 'Review a word',
		input: { word: field.text() },
		run: async ({ word }) => {
			const read = await data.words.get(word);
			if (read.error) return read;
			const found = read.data;
			assertType<
				Equal<NonNullable<typeof found>['meaning'], string | undefined>
			>();
			const changed = await data.words.patch(word, { meaning: null });
			if (changed.error) return changed;
			// A row names its own record by its id.
			for (const row of await data.words.list()) {
				if (row.error) return row;
				await data.words.delete(row.data.id);
			}
			// @ts-expect-error a folder key names its record by its id
			await data.words.get();
			// @ts-expect-error which record, then the change: two arguments
			await data.words.patch({ meaning: 'x' });
			return Ok(found?.meaning);
		},
	});

	return {
		description: 'Words I am learning',
		data,
		actions: {
			words: {
				...data.words.actions('list', 'get', 'patch', 'edit'),
				create: learn,
			},
			settings: data['settings.md'].actions('get', 'patch'),
			review,
		},
	};
});

/** The app as its folder makes it. */
declare const made: ReturnType<typeof vocab>;
type Actions = typeof made.actions;
type In<A> = A extends (input: infer I) => unknown ? I : never;
type Out<A> = A extends (input: never) => infer O ? Awaited<O> : never;

describe('an app author', () => {
	test('gets every action under its words, with exact inputs and outputs', () => {
		assertType<Equal<keyof Actions, 'words' | 'settings' | 'review'>>();
		assertType<
			Equal<
				keyof Actions['words'],
				'list' | 'get' | 'create' | 'patch' | 'edit'
			>
		>();
		assertType<Equal<keyof Actions['settings'], 'get' | 'patch'>>();
		assertType<
			Equal<
				In<Actions['words']['patch']>,
				{ id: string; meaning?: string | null | undefined; body?: string }
			>
		>();
		assertType<
			Equal<
				In<Actions['words']['edit']>,
				{ id: string; old: string; new: string }
			>
		>();
		// @ts-expect-error an edit names both old and new
		() => made.actions.words.edit({ id: 'a', old: 'x' });
		assertType<Equal<In<Actions['words']['get']>, { id: string }>>();
		assertType<Equal<In<Actions['settings']['get']>, Record<string, never>>>();
		type Item = NonNullable<Out<Actions['words']['list']>['data']>[number];
		assertType<
			Equal<
				Extract<Item, Ok<unknown>>['data'],
				{
					path: string;
					id: string;
					body: string;
					meaning?: string;
				}
			>
		>();
		assertType<Equal<Extract<Item, Err<unknown>>['error']['name'], 'Misfit'>>();
		assertType<
			Equal<
				In<Actions['settings']['patch']>,
				{ dailyGoal?: number | null | undefined; body?: string }
			>
		>();
		assertType<
			Equal<In<Actions['words']['create']>, { word: string; meaning?: string }>
		>();
		assertType<
			Equal<
				Extract<Out<Actions['review']>, Ok<unknown>>['data'],
				string | undefined
			>
		>();
	});

	test('an app is a function of its folder, and its actions are functions of their input', () => {
		assertType<Equal<Parameters<typeof vocab>, [{ folder: Folder }]>>();
		() =>
			vocab({ folder: {} as Folder }).actions.words.create({ word: '你好' });
		// @ts-expect-error an app is called with its folder
		() => vocab();
	});

	test('a list with min is required, to give and in a read, and never always filled', () => {
		const route = defineAction({
			description: 'Save a route',
			input: {
				airports: field.list(field.text(), { min: 1 }),
				stops: field.list(field.text(), { min: 0 }),
			},
			run: ({ airports, stops }) => {
				assertType<Equal<typeof airports, string[]>>();
				assertType<Equal<typeof stops, string[]>>();
				return Ok(airports.length + stops.length);
			},
		});
		assertType<
			Equal<ActionInput<typeof route>, { airports: string[]; stops?: string[] }>
		>();
	});

	test('a caller may leave out a defaulted field, and run receives it', () => {
		const tag = defineAction({
			description: 'Tag',
			input: { tags: field.list(field.text()), done: field.boolean() },
			run: ({ tags, done }) => {
				assertType<Equal<typeof tags, string[]>>();
				assertType<Equal<typeof done, boolean>>();
				return Ok({ count: tags.length, at: done ? 'now' : undefined });
			},
		});
		assertType<
			Equal<ActionInput<typeof tag>, { tags?: string[]; done?: boolean }>
		>();
		assertType<
			Equal<ActionOutput<typeof tag>, { count: number; at?: string }>
		>();
		const nothing = defineAction({
			description: 'n',
			input: {},
			run: () => Ok(undefined),
		});
		assertType<Equal<ActionOutput<typeof nothing>, null>>();
		defineAction({
			description: 'Now',
			input: {},
			// @ts-expect-error a Date is not a value JSON carries
			run: () => Ok({ at: new Date() }),
		});
		const say = defineAction({
			description: 'Say',
			input: { message: field.text() },
			async run({ message }, update: Update<string | { step: number }>) {
				update(message);
				update({ step: 1 });
				return Ok({ reply: message });
			},
		});
		defineAction({
			description: 'Forgot',
			input: {},
			run(_input, update) {
				// @ts-expect-error an update argument with no annotation takes nothing
				update('x');
				return Ok(null);
			},
		});
		assertType<Equal<ActionInput<typeof say>, { message: string }>>();
		assertType<Equal<ActionOutput<typeof say>, { reply: string }>>();
		assertType<Equal<ActionUpdate<typeof say>, string | { step: number }>>();
		assertType<Equal<ActionUpdate<typeof tag>, never>>();
		assertType<Equal<ActionUpdate<Actions['words']['patch']>, never>>();
		const chat = defineApp(() => ({ description: 'Chat', actions: { say } }));
		type ChatActions = ReturnType<typeof chat>['actions'];
		assertType<
			Equal<ActionUpdate<ChatActions['say']>, string | { step: number }>
		>();
		const chatUi = connect<typeof chat>({ app: 'chat' });
		() =>
			chatUi.say(
				{ message: 'hi' },
				{
					onUpdate: (value) => {
						assertType<Equal<typeof value, string | { step: number }>>();
					},
				},
			);
		const vocabUi = {} as AppClient<Actions>;
		// @ts-expect-error an action that only returns takes no onUpdate
		() => vocabUi.review({ word: 'a' }, { onUpdate: () => {} });
		// The same two arguments call it in the Epicenter.
		() => say({ message: 'hi' }, { onUpdate: (value) => void value });
		// @ts-expect-error in the Epicenter too
		() => tag({ word: 'a' }, { onUpdate: () => {} });
	});

	test('raw TypeBox sits beside fields', () => {
		defineAction({
			description: 'Log minutes',
			input: { minutes: Type.Number({ minimum: 0 }) },
			run: ({ minutes }) => {
				assertType<Equal<typeof minutes, number>>();
				return Ok(undefined);
			},
		});
	});

	test('a UI calls under the same words, typed by the app, and gets a Result', () => {
		const vocabUi = connect<typeof vocab>({ app: 'vocab' });
		assertType<Equal<typeof vocabUi, AppClient<Actions>>>();
		const call = () => vocabUi.words.patch({ id: 'a', meaning: 'x' });
		type Answer = Awaited<ReturnType<typeof call>>;
		assertType<
			Equal<
				Extract<Answer, Ok<unknown>>['data'],
				{
					path: string;
					id: string;
					body: string;
					meaning?: string;
				}
			>
		>();
		assertType<Answer extends Result<unknown, ActionError> ? true : false>();
		// @ts-expect-error a field the data key does not declare
		() => vocabUi.words.patch({ id: 'a', due: 'x' });
		// @ts-expect-error a verb takes the id, not a path
		() => vocabUi.words.get({ path: 'data/words/a.md' });
		() => vocabUi.settings.get();
		() => vocabUi.words.list();
		() => vocabUi.review({ word: 'a' });
		// @ts-expect-error no action is named then
		() => vocabUi.then;
	});
});

describe('type errors', () => {
	test('an action takes no positional, and its run is not a generator', () => {
		() => {
			defineAction({
				description: 'Read',
				input: { value: field.text() },
				// @ts-expect-error the command line takes the input as one JSON object
				positional: ['value'],
				run: () => Ok(true),
			});
			defineAction({
				description: 'Read',
				input: { value: field.text() },
				// @ts-expect-error an action reports by calling update, not by yielding
				async *run() {
					yield true;
					return Ok(true);
				},
			});
		};
	});
});

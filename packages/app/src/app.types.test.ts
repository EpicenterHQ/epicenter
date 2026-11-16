/**
 * What an app author's editor shows: each check is a compile-time assertion,
 * run by `tsc`; the test bodies only keep `bun test` from skipping the file.
 */
import { describe, test } from 'bun:test';
import { Type } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { ActionYield } from './action.ts';
import type {
	ActionError,
	ActionInput,
	ActionOutput,
	AppClient,
} from './client.ts';
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
	path: 'data/words/{word}.md',
	fields: {
		meaning: field.text({ optional: true }),
		createdAt: field.datetime({ readOnly: true }),
		due: field.datetime({ optional: true, readOnly: true }),
	},
});

const settings = defineCollection({
	path: 'data/settings.md',
	fields: { dailyGoal: field.integer({ optional: true }) },
});

const learn = defineAction({
	description: 'Learn a word, due now',
	input: { word: field.text(), meaning: field.text({ optional: true }) },
	run: async ({ word, meaning }) => {
		assertType<Equal<typeof word, string>>();
		assertType<Equal<typeof meaning, string | undefined>>();
		const goal = (await settings.get())?.dailyGoal;
		assertType<Equal<typeof goal, number | undefined>>();
		// The handle writes readOnly fields; the exposed add and set do not take them.
		return words.add({ word, meaning, createdAt: '2026-11-10T00:00:00Z' });
	},
});

const review = defineAction({
	description: 'Schedule a word',
	input: { word: field.text() },
	run: async ({ word }) => {
		const found = await words.get({ word });
		assertType<
			Equal<NonNullable<typeof found>['meaning'], string | undefined>
		>();
		await words.set({ word }, { due: '2026-11-11T04:00:00Z' });
		// A row names its own record.
		for (const row of await words.list()) await words.delete(row);
		// @ts-expect-error a collection with a placeholder names its record by its keys
		await words.get();
		// @ts-expect-error a record is named by its keys, not its path
		await words.get({ path: 'data/words/a.md' });
		// @ts-expect-error which record, then the change: two arguments
		await words.set({ word, meaning: 'x' });
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
		assertType<Equal<keyof Actions['words'], 'list' | 'get' | 'add' | 'set'>>();
		assertType<
			Equal<keyof Actions['settings'], 'list' | 'get' | 'add' | 'set'>
		>();
		assertType<
			Equal<
				In<Actions['words']['set']>,
				| {
						word: string;
						meaning?: string | null | undefined;
						was?: {
							meaning?: string | null;
							createdAt?: string | null;
							due?: string | null;
						};
						old?: never;
						new?: never;
				  }
				| {
						word: string;
						meaning?: string | null | undefined;
						was?: {
							meaning?: string | null;
							createdAt?: string | null;
							due?: string | null;
						};
						old: string;
						new: string;
				  }
			>
		>();
		// @ts-expect-error old and new come together
		() => vocab.actions.words.set({ word: 'a', old: 'x' });
		assertType<Equal<In<Actions['words']['get']>, { word: string }>>();
		assertType<Equal<In<Actions['settings']['get']>, Record<string, never>>>();
		assertType<
			Equal<
				Out<Actions['words']['list']>[number],
				| {
						path: string;
						word: string;
						meaning?: string;
						createdAt: string;
						due?: string;
						problems?: undefined;
				  }
				| {
						path: string;
						word: string;
						meaning?: string;
						createdAt?: string;
						due?: string;
						problems: string[];
				  }
			>
		>();
		assertType<
			Equal<
				In<Actions['settings']['set']>,
				| {
						dailyGoal?: number | null | undefined;
						was?: { dailyGoal?: number | null };
						old?: never;
						new?: never;
				  }
				| {
						dailyGoal?: number | null | undefined;
						was?: { dailyGoal?: number | null };
						old: string;
						new: string;
				  }
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
		assertType<Equal<typeof words.path, 'data/words/{word}.md'>>();
		assertType<Equal<Parameters<typeof words.get>, [keys: { word: string }]>>();
		assertType<Equal<Parameters<typeof settings.get>, []>>();
		assertType<Equal<Parameters<typeof settings.pathOf>, []>>();
	});

	test('a record without problems has its required fields, a switch, and a list; one with problems may lack any field', () => {
		const tasks = defineCollection({
			path: 'data/tasks/{year}/{id}.md',
			fields: {
				title: field.text(),
				note: field.text({ optional: true }),
				done: field.boolean(),
				tags: field.list(field.text()),
			},
		});
		// A read gives no `other`: front matter no field declares is kept, not read.
		type Found = Awaited<ReturnType<typeof tasks.list>>[number];
		assertType<
			Equal<
				Found,
				| {
						path: string;
						year: string;
						id: string;
						title: string;
						note?: string;
						done: boolean;
						tags: string[];
						body: string;
						problems?: undefined;
				  }
				| {
						path: string;
						year: string;
						id: string;
						title?: string;
						note?: string;
						done?: boolean;
						tags?: string[];
						body: string;
						problems: string[];
				  }
			>
		>();
		assertType<
			Equal<Parameters<typeof tasks.pathOf>[0], { year: string; id: string }>
		>();
		assertType<Equal<Parameters<typeof words.pathOf>[0], { word: string }>>();
		const titles = (records: Found[]) =>
			records
				.filter((record) => !record.problems)
				.map((record) => record.title);
		assertType<Equal<ReturnType<typeof titles>, string[]>>();
		(record: Found) => {
			if (!record.problems) assertType<Equal<typeof record.tags, string[]>>();
			// @ts-expect-error a record with problems may lack its list
			return record.tags.length;
		};
		// A set function sees the record as get does, so it must handle a missing list.
		() =>
			tasks.set({ year: '2026', id: 'a' }, (now) => ({
				tags: [...(now.tags ?? []), 'new'],
				body: `${now.body}More.\n`,
			}));
	});

	test('a required readOnly field leaves add out, and delete comes only when named', () => {
		const given = () => words.actions();
		assertType<Equal<keyof ReturnType<typeof given>, 'list' | 'get' | 'set'>>();
		assertType<
			Equal<keyof ReturnType<typeof words.actions<'delete'>>, 'delete'>
		>();
		// @ts-expect-error words has a required readOnly createdAt, so no add
		() => words.actions('add');
		// @ts-expect-error set takes old and new, so there is no edit
		() => words.actions('edit');
		const flags = defineCollection({
			path: 'data/flags/{id}.md',
			fields: {
				pinned: field.boolean({ readOnly: true }),
				labels: field.list(field.text(), { readOnly: true }),
			},
		});
		type SetIn = In<ReturnType<typeof flags.actions<'set'>>['set']>;
		assertType<
			Equal<
				SetIn,
				| {
						id: string;
						was?: { pinned?: boolean | null; labels?: string[] | null };
						old?: never;
						new?: never;
				  }
				| {
						id: string;
						was?: { pinned?: boolean | null; labels?: string[] | null };
						old: string;
						new: string;
				  }
			>
		>();
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
		type Fits = Exclude<
			Awaited<ReturnType<typeof books.list>>[number],
			{ problems: string[] }
		>;
		assertType<
			Equal<
				Fits,
				{
					path: string;
					book: string;
					platforms: ('x' | 'threads')[];
					ratings: number[];
					shelf: string;
					shelves: string[];
					people: { name: string }[];
					body: string;
					problems?: undefined;
				}
			>
		>();
		type AddIn = In<ReturnType<typeof books.actions<'add'>>['add']>;
		assertType<
			Equal<
				AddIn,
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
		const shelve = defineAction({
			description: 'Shelve',
			input: {
				shelves: field.list(field.ref(shelves)),
				shelf: field.ref(shelves, { optional: true }),
			},
			run: ({ shelves, shelf }) => {
				assertType<Equal<typeof shelves, string[]>>();
				assertType<Equal<typeof shelf, string | undefined>>();
				return shelves.length;
			},
		});
		assertType<
			Equal<ActionInput<typeof shelve>, { shelves?: string[]; shelf?: string }>
		>();
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
				return airports.length + stops.length;
			},
		});
		assertType<
			Equal<ActionInput<typeof route>, { airports: string[]; stops?: string[] }>
		>();
		const trips = defineCollection({
			path: 'data/trips/{trip}.md',
			fields: { airports: field.list(field.text(), { min: 1 }) },
		});
		type Found = Awaited<ReturnType<typeof trips.list>>[number];
		(record: Found) => {
			if (!record.problems)
				assertType<Equal<typeof record.airports, string[]>>();
			// @ts-expect-error a record with problems may lack it
			return record.airports.length;
		};
		type AddIn = In<ReturnType<typeof trips.actions<'add'>>['add']>;
		assertType<
			Equal<AddIn, { trip: string; airports: string[]; body?: string }>
		>();
		type SetIn = Extract<
			In<ReturnType<typeof trips.actions<'set'>>['set']>,
			{ old?: never }
		>;
		// A required list cannot be removed with null.
		assertType<
			Equal<
				SetIn,
				{
					trip: string;
					airports?: string[];
					was?: { airports?: string[] | null };
					old?: never;
					new?: never;
				}
			>
		>();
	});

	test('a caller may leave out a defaulted field, and run receives it', () => {
		const tag = defineAction({
			description: 'Tag',
			input: { tags: field.list(field.text()), done: field.boolean() },
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
		// @ts-expect-error a Date is not a value JSON carries
		defineAction({
			description: 'Now',
			input: {},
			run: () => ({ at: new Date() }),
		});
		const say = defineAction({
			description: 'Say',
			privateInput: true,
			input: { message: field.text() },
			async *run({ message }) {
				yield message;
				yield { step: 1 };
				return { reply: message };
			},
		});
		assertType<Equal<ActionInput<typeof say>, { message: string }>>();
		assertType<Equal<ActionOutput<typeof say>, { reply: string }>>();
		assertType<Equal<ActionYield<typeof say>, string | { step: number }>>();
		assertType<Equal<ActionYield<typeof tag>, never>>();
		assertType<Equal<ActionYield<Actions['words']['set']>, never>>();
		const chat = defineApp({
			description: 'Chat',
			collections: {},
			actions: { say },
		});
		assertType<
			Equal<ActionYield<typeof chat.actions.say>, string | { step: number }>
		>();
		const chatUi = {} as AppClient<typeof chat.actions>;
		() =>
			chatUi.say(
				{ message: 'hi' },
				{
					onYield: (value) => {
						assertType<Equal<typeof value, string | { step: number }>>();
					},
				},
			);
		const vocabUi = {} as AppClient<Actions>;
		// @ts-expect-error an action that only returns takes no onYield
		() => vocabUi.review({ word: 'a' }, { onYield: () => {} });
	});

	test('set takes the fields to change, or a function of the record as get gives it', () => {
		type Found = NonNullable<Awaited<ReturnType<typeof words.get>>>;
		() =>
			words.set({ word: 'a' }, (word) => {
				assertType<Equal<typeof word, Found>>();
				return { meaning: word.meaning ?? 'x', due: null };
			});
		() => words.set({ word: 'a' }, { meaning: null });
		() =>
			// @ts-expect-error createdAt is required, so it cannot be removed
			words.set({ word: 'a' }, () => ({ createdAt: null }));
		() => settings.set((now) => ({ dailyGoal: (now.dailyGoal ?? 0) + 1 }));
	});

	test('update gives the record as get does, undefined when there is none, and takes what set takes, with body', () => {
		type Revise = Parameters<typeof words.update>[1];
		type Given = Parameters<Revise>[0];
		type Found = NonNullable<Awaited<ReturnType<typeof words.get>>>;
		assertType<Equal<Given, Found | undefined>>();
		assertType<
			Equal<
				ReturnType<Revise>,
				{
					meaning?: string | null;
					createdAt?: string;
					due?: string | null;
					body?: string;
				}
			>
		>();
		assertType<Equal<ReturnType<typeof words.update>, Promise<Found>>>();
		() =>
			words.update({ word: 'a' }, (word) => ({
				due: word?.due ?? null,
				body: `${word?.body ?? ''}more\n`,
			}));
		() =>
			// @ts-expect-error createdAt is required, so it cannot be removed
			words.update({ word: 'a' }, () => ({ createdAt: null }));
		// @ts-expect-error a key is not a field
		() => words.update({ word: 'a' }, () => ({ word: 'b' }));
		// @ts-expect-error a collection with a placeholder updates the record its keys name
		() => words.update(() => ({ meaning: 'x' }));
		() =>
			settings.update((file) => ({ dailyGoal: (file?.dailyGoal ?? 0) + 1 }));
		// @ts-expect-error update is a method, not a verb
		() => settings.actions('update');
	});

	test('a collection with no placeholder has every method and verb, without the keys', () => {
		() => settings.actions('list', 'add', 'delete');
		() => settings.add({ dailyGoal: 1 });
		() => settings.delete();
		assertType<
			Equal<
				Awaited<ReturnType<typeof settings.get>>,
				| {
						path: string;
						dailyGoal?: number;
						body: string;
						problems?: undefined;
				  }
				| {
						path: string;
						dailyGoal?: number;
						body: string;
						problems: string[];
				  }
				| undefined
			>
		>();
		// @ts-expect-error it is one file, so it takes no keys
		() => settings.get({ path: 'data/settings.md' });
		// @ts-expect-error it is one file, so set takes only the change
		() => settings.set({}, { dailyGoal: 1 });
	});

	test('add takes every placeholder but {time}', () => {
		const notes = defineCollection({
			path: 'data/notes/{year}/{time}.md',
			fields: { title: field.text() },
		});
		type AddIn = In<ReturnType<typeof notes.actions<'add'>>['add']>;
		assertType<Equal<AddIn, { year: string; title: string; body?: string }>>();
	});

	test('a collection has one path, not a list', () => {
		// Never called: the definition would throw; only its type is checked.
		() =>
			defineCollection({
				// @ts-expect-error a second layout is a second collection
				path: ['data/entries/{time}.md', 'data/entries/archive/{slug}.md'],
				fields: {},
			});
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

	test('a UI calls under the same words, typed by the app, and gets a Result', () => {
		const vocabUi = {} as AppClient<Actions>;
		const call = () => vocabUi.words.set({ word: 'a', meaning: 'x' });
		assertType<
			Equal<
				Awaited<ReturnType<typeof call>>,
				Result<
					| {
							path: string;
							word: string;
							meaning?: string;
							createdAt: string;
							due?: string;
							body: string;
							problems?: undefined;
					  }
					| {
							path: string;
							word: string;
							meaning?: string;
							createdAt?: string;
							due?: string;
							body: string;
							problems: string[];
					  },
					ActionError
				>
			>
		>();
		// @ts-expect-error due is written only by Vocab's own actions
		() => vocabUi.words.set({ word: 'a', due: 'x' });
		// @ts-expect-error a verb takes the keys, not a path
		() => vocabUi.words.get({ path: 'data/words/a.md' });
		() => vocabUi.settings.get();
		() => vocabUi.words.list();
		() => vocabUi.review({ word: 'a' });
		// @ts-expect-error no action is named then
		() => vocabUi.then;
	});
});

describe('type errors', () => {
	test('ordinary and yielding actions take no positional', () => {
		() => {
			// @ts-expect-error the command line takes the input as one JSON object
			defineAction({
				description: 'Read',
				input: { value: field.text() },
				positional: ['value'],
				run: () => true,
			});
			// @ts-expect-error a yielding action takes no positional either
			defineAction({
				description: 'Read',
				input: { value: field.text() },
				positional: ['value'],
				async *run() {
					yield true;
					return true;
				},
			});
		};
	});
});

import { describe, test } from 'bun:test';
import { Type } from 'typebox';
import { defineApp, field } from './index.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

const reading = defineApp({
	name: 'reading',
	description: 'How much I read each week',
	actions: {
		log: {
			description: 'Record minutes read today',
			input: {
				minutes: field.number({ positional: true }),
				book: field.text({ optional: true }),
				kind: field.select(['paper', 'ebook']),
				day: field.date({ optional: true }),
				reread: field.boolean(),
				tags: field.tags(),
				note: Type.Optional(Type.String()),
			},
			run: async (input, { folder }) => {
				assertType<
					Equal<
						typeof input,
						{
							minutes: number;
							book?: string;
							kind: 'paper' | 'ebook';
							day?: string;
							reread: boolean;
							tags: string[];
							note?: string;
						}
					>
				>();
				await folder.write('2026.csv', `${input.minutes}\n`);
				return { minutes: input.minutes, kind: input.kind };
			},
		},
		'week show': {
			description: 'Minutes read this week',
			input: {},
			readOnly: true,
			run: () => 210,
		},
	},
});

type Output<K extends keyof (typeof reading)['actions']> = Awaited<
	ReturnType<(typeof reading)['actions'][K]['run']>
>;

describe('defineApp', () => {
	test("run's return value stays typed", () => {
		assertType<
			Equal<Output<'log'>, { minutes: number; kind: 'paper' | 'ebook' }>
		>();
		assertType<Equal<Output<'week show'>, number>>();
	});
});

describe('type errors', () => {
	test('a run that disagrees with its fields is refused', () => {
		defineApp({
			name: 'wrong',
			description: 'Wrong',
			actions: {
				log: {
					description: 'Log',
					input: { minutes: field.number() },
					// @ts-expect-error — minutes is a number, not a string
					run: ({ minutes }: { minutes: string }) => minutes,
				},
			},
		});
	});

	test('a field without optional is required', () => {
		defineApp({
			name: 'required',
			description: 'Required',
			actions: {
				log: {
					description: 'Log',
					input: { book: field.text() },
					run: ({ book }) => {
						const title: string = book;
						// @ts-expect-error — book is always there, so it is never undefined
						const missing: undefined = book;
						return [title, missing];
					},
				},
			},
		});
	});

	test('an action needs a description', () => {
		defineApp({
			name: 'bare',
			description: 'Bare',
			actions: {
				// @ts-expect-error — description is missing
				log: { input: {}, run: () => 0 },
			},
		});
	});
});

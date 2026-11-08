import { describe, test } from 'bun:test';
import { Type } from 'typebox';
import { defineApp, field } from './index.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

/** A declaration as TypeScript reads an imported epicenter.json without epicenter.d.json.ts: widened. */
const widened: {
	$schema: string;
	name: string;
	description: string;
	collections: {
		books: {
			path: string;
			fields: { type: string; properties: { title: { type: string } } };
		};
	};
} = {
	$schema: 'https://epicenter.so/epicenter.schema.json',
	name: 'reading',
	description: 'How much I read each week',
	collections: {
		books: {
			path: 'books/{slug}.md',
			fields: { type: 'object', properties: { title: { type: 'string' } } },
		},
	},
};

const reading = defineApp(widened, {
	actions: {
		log: {
			description: 'Record minutes read today',
			input: {
				minutes: field.number(),
				book: field.text({ optional: true }),
				kind: field.select(['paper', 'ebook']),
				day: field.date({ optional: true }),
				reread: field.boolean(),
				tags: field.tags(),
				note: Type.Optional(Type.String()),
			},
			positional: ['minutes', 'tags'],
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
			annotations: { readOnlyHint: true },
			run: () => 210,
		},
	},
});

type Output<K extends keyof (typeof reading)['actions']> = Awaited<
	ReturnType<(typeof reading)['actions'][K]['run']>
>;

describe('defineApp', () => {
	test("run's return value stays typed, and the declaration keeps its type", () => {
		assertType<
			Equal<Output<'log'>, { minutes: number; kind: 'paper' | 'ebook' }>
		>();
		assertType<Equal<Output<'week show'>, number>>();
		assertType<Equal<(typeof reading)['declaration']['name'], string>>();
	});

	test('an exact declaration, as epicenter.d.json.ts gives it, keeps its literals', () => {
		const exact = defineApp({ name: 'vocab', description: 'Words' } as const, {
			actions: {},
		});
		assertType<Equal<(typeof exact)['declaration']['name'], 'vocab'>>();
	});
});

describe('type errors', () => {
	test('a run that disagrees with its fields is refused', () => {
		defineApp(widened, {
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
		defineApp(widened, {
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

	test('a positional names one of its fields', () => {
		defineApp(widened, {
			actions: {
				log: {
					description: 'Log',
					input: { minutes: field.number() },
					// @ts-expect-error — "hours" is not a field
					positional: ['hours'],
					run: () => 0,
				},
			},
		});
	});

	test('an action needs a description', () => {
		defineApp(widened, {
			actions: {
				// @ts-expect-error — description is missing
				log: { input: {}, run: () => 0 },
			},
		});
	});

	test('a declaration needs a name', () => {
		// @ts-expect-error — name is missing
		defineApp({ description: 'Nameless' }, { actions: {} });
	});
});

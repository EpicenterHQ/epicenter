/**
 * App composition and action declarations. An app is a function of its
 * folder (ADR-0960): a test calls it with a folder on a temporary directory.
 * `defineApp` refuses the old object form and anything its types cannot
 * check; `defineAction` refuses malformed metadata. Data declarations are in
 * `data.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type TSchema, Type } from 'typebox';
import {
	type App,
	defineAction,
	defineApp,
	defineData,
	field,
	Ok,
	type Update,
} from './index.ts';
import { tempFolder, unusedFolder } from './library.test-support.ts';

const reading = defineApp(({ folder }) => {
	const data = defineData(folder, {
		books: { fields: { title: field.text() } },
	});
	const log = defineAction({
		description: 'Record minutes read today',
		input: { minutes: field.number() },
		run: async ({ minutes }) => {
			await folder.edit('data/2026.csv', (before = 'minutes\n') =>
				Ok({ text: `${before}${minutes}\n` }),
			);
			return Ok({ minutes });
		},
	});
	const total = defineAction({
		description: 'Minutes read so far',
		input: {},
		annotations: { readOnlyHint: true },
		run: async () => {
			const file = Bun.file(join(folder.path, 'data/2026.csv'));
			const text = (await file.exists()) ? await file.text() : 'minutes\n';
			const lines = text.trim().split('\n').slice(1);
			return Ok(lines.reduce((sum, line) => sum + Number(line), 0));
		},
	});
	return {
		description: 'How much I read each week',
		data,
		actions: {
			books: data.books.actions('list', 'get', 'create', 'patch'),
			log,
			total,
		},
	};
});

describe('an app', () => {
	test('is called with a folder, and its actions change files in that folder', async () => {
		const { folder, read } = await tempFolder({
			'data/2026.csv': 'minutes\n10\n',
		});
		const app = reading({ folder });
		expect(await app.actions.log({ minutes: 30 })).toEqual(Ok({ minutes: 30 }));
		expect(await read('data/2026.csv')).toBe('minutes\n10\n30\n');
		expect(await app.actions.total({})).toEqual(Ok(40));
	});

	test('two calls with two folders do not share files', async () => {
		const one = await tempFolder();
		const two = await tempFolder();
		await reading({ folder: one.folder }).actions.log({ minutes: 5 });
		expect(await one.read('data/2026.csv')).toBe('minutes\n5\n');
		expect(await two.read('data/2026.csv')).toBeUndefined();
	});
});

const noop = defineAction({
	description: 'n',
	input: {},
	run: () => Ok(undefined),
});

const shown = defineAction({
	description: 's',
	input: {},
	run: () => Ok('shown'),
});

/** What `defineApp` makes of an app that returns `app`. These apps only declare. */
function made<const T extends App>(app: T): T {
	return defineApp(() => app)({ folder: unusedFolder });
}

/** What `make` throws, one problem a line. */
function problems(make: () => unknown): string[] {
	try {
		make();
	} catch (error) {
		return (error as Error).message.split('\n');
	}
	return [];
}

describe('defineApp', () => {
	test('returns a function that answers what the app returned, with its actions nested under their words', async () => {
		const { folder } = await tempFolder();
		const given = { description: 'Same', actions: { noop } };
		expect(defineApp(() => given)({ folder })).toBe(given);
		const app = reading({ folder });
		expect(Object.keys(app.actions)).toEqual(['books', 'log', 'total']);
		expect(Object.keys(app.actions.books)).toEqual([
			'list',
			'get',
			'create',
			'patch',
		]);
	});

	test('refuses an argument that is not a function', () => {
		expect(
			problems(() => defineApp({ description: 'Old', actions: {} } as never)),
		).toEqual([
			'An app is a function of its folder: defineApp(({ folder }) => ({ description, data, actions }))',
		]);
	});

	test('needs a description and actions', () => {
		expect(problems(() => made({ description: ' ', actions: {} }))).toEqual([
			'An app needs a description',
		]);
		expect(
			problems(() => made({ description: 'Bare', actions: null } as never)),
		).toEqual([
			'An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		]);
		expect(problems(() => made(undefined as never))).toEqual([
			'An app returns an object: defineApp(({ folder }) => ({ description, data, actions }))',
		]);
	});

	test('keeps the data handles it is given', () => {
		const data = defineData(unusedFolder, {
			notes: { fields: { title: field.text() } },
		});
		const app = made({ description: 'Notes', data, actions: {} });
		expect(app.data.notes).toBe(data.notes);
		expect(app.data.notes.path('one')).toBe('data/notes/one.md');
	});

	test('refuses data that is not what defineData returned, or a data key that is not a name', () => {
		expect(
			problems(() =>
				made({ description: 'Bad', data: null, actions: {} } as never),
			),
		).toEqual(['An app needs data: the value returned by defineData(...)']);
		expect(
			problems(() =>
				made({
					description: 'Bad',
					data: { notes: { fields: {} } },
					actions: {},
				} as never),
			),
		).toEqual(['data.notes is not a handle from defineData(...)']);
		const data = defineData(unusedFolder, { notes: { fields: {} } });
		expect(
			problems(() =>
				made({ description: 'Bad', data: { Notes: data.notes }, actions: {} }),
			),
		).toEqual([
			'data has the key "Notes", which must be a name, optionally followed by .md',
		]);
	});

	test('refuses an action named then at any depth, which a UI could not call', () => {
		expect(
			problems(() =>
				made({
					description: 'Then',
					// biome-ignore lint/suspicious/noThenProperty: the test defines then actions to check defineApp refuses them
					actions: { then: noop, group: { then: noop, inner: { then: noop } } },
				}),
			),
		).toEqual([
			'actions.then is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word',
			'actions.group.then is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word',
			'actions.group.inner.then is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word',
		]);
	});

	test('accepts groups with actions named run, start, and description', () => {
		const app = made({
			description: 'Daily work',
			actions: { daily: { run: noop, start: shown, description: noop } },
		});
		expect(
			Object.keys(app.actions.daily).map((word) => `daily ${word}`),
		).toEqual(['daily run', 'daily start', 'daily description']);
		expect(app.actions.daily.run).toBe(noop);
		expect(app.actions.daily.start).toBe(shown);
	});

	test('refuses an object spread with an action description and plain run function', () => {
		expect(
			problems(() =>
				made({
					description: 'Broken spread',
					actions: {
						daily: { ...noop, description: 'Daily', run() {} },
					} as never,
				}),
			),
		).toEqual([
			'actions.daily is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call',
		]);
	});

	test('names keys that cannot be words, and entries that are not actions', () => {
		expect(
			problems(() =>
				made({
					description: 'Bad',
					actions: {
						'Two Words': noop,
						spread: { ...noop, description: 'Spread' },
						plain: { description: 'p', input: {}, run() {} },
						group: { five: 5 },
					} as never,
				}),
			),
		).toEqual([
			'actions has the key "Two Words" at actions.Two Words, which is not lowercase letters, digits, and dashes, starting with a letter',
			'actions.spread is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call',
			'actions.plain is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call',
			'actions.group.five is neither an action nor a group of them',
		]);
	});
});

describe('defineAction', () => {
	test('rejects a key an action does not take', () => {
		expect(() =>
			defineAction({
				description: 'Connect',
				input: {},
				// @ts-expect-error an action takes description, input, annotations and run
				privateInput: true,
				run: () => Ok(true),
			}),
		).toThrow('has "privateInput", which an action does not take');
	});

	test('keeps the mcp flag it is given and refuses one that is not a boolean', () => {
		const declare = (mcp: boolean) =>
			defineAction({
				description: 'Send',
				input: {},
				mcp,
				run: () => Ok(true),
			});
		expect(declare(false).mcp).toBe(false);
		expect(declare(true).mcp).toBe(true);
		expect(() => declare('no' as never)).toThrow(
			'The action "Send" has an mcp flag that is not a boolean',
		);
	});

	test('rejects cyclic schemas at declaration before they can break discovery', () => {
		const schema: { type: string; properties: Record<string, TSchema> } = {
			type: 'object',
			properties: {},
		};
		schema.properties.self = schema;
		expect(() =>
			defineAction({
				description: 'Read',
				input: { value: schema },
				run: () => Ok(true),
			}),
		).toThrow(TypeError);
	});

	test('accepts finite recursive schemas expressed with references', () => {
		const schema = {
			$defs: {
				node: {
					type: 'object',
					properties: { next: { $ref: '#/$defs/node' } },
				},
			},
			$ref: '#/$defs/node',
		};
		const action = defineAction({
			description: 'Read',
			input: { value: schema },
			run: () => Ok(true),
		});
		expect(action.input.properties.value).toEqual(schema);
	});

	test("refuses another action's input schema where its fields belong, and takes its properties", () => {
		const show = defineAction({
			description: 'Show a day',
			input: { day: field.date(), note: field.text({ optional: true }) },
			run: ({ day }) => Ok(day),
		});
		expect(() =>
			defineAction({
				description: 'Show again',
				// @ts-expect-error an input schema is not a map of fields
				input: show.input,
				run: () => Ok(true),
			}),
		).toThrow(
			"has another action's input schema as its input; write `input: other.input.properties`",
		);
		const again = defineAction({
			description: 'Show again',
			input: show.input.properties,
			run: () => Ok(true),
		});
		expect(again.input).toEqual(show.input);
	});

	test('an action that sends updates resolves with its return, and a caller that listens hears them in order', async () => {
		const { folder, read } = await tempFolder();
		const say = defineAction({
			description: 'Say',
			input: { message: field.text(), loud: field.boolean() },
			async run({ message, loud }, update: Update<string | { loud: boolean }>) {
				update(message);
				update({ loud });
				await folder.write('data/said.md', message);
				return Ok({ said: message });
			},
		});
		expect(await say({ message: 'hi' })).toEqual(Ok({ said: 'hi' }));
		const seen: unknown[] = [];
		const returned = await say(
			{ message: '猫' },
			{ onUpdate: (value) => seen.push(value) },
		);
		expect(seen).toEqual(['猫', { loud: false }]);
		expect(returned).toEqual(Ok({ said: '猫' }));
		expect(await read('data/said.md')).toBe('猫');
	});

	test('a listener cannot slow, stop, or outlive the action', async () => {
		let late: Update<number> = () => {};
		const count = defineAction({
			description: 'Count',
			input: {},
			async run(_input, update: Update<number>) {
				late = update;
				update(1);
				update(2);
				update(3);
				return Ok('done');
			},
		});
		const heard: number[] = [];
		const answer = await count(
			{},
			{
				onUpdate(value) {
					heard.push(value);
					if (value === 1) throw new Error('a listener broke');
					if (value === 2) return Promise.reject(new Error('and again'));
					return new Promise(() => {});
				},
			},
		);
		expect(answer).toEqual(Ok('done'));
		late(4);
		expect(heard).toEqual([1, 2, 3]);
	});

	test('a run that is an async function* is refused where it is defined', () => {
		expect(() =>
			defineAction({
				description: 'Old',
				input: {},
				run: async function* () {
					yield 1;
					return Ok(null);
				},
			} as never),
		).toThrow('reports by calling update, its second argument');
	});

	test('a call fills an absent switch and list, and nothing else', async () => {
		const tag = defineAction({
			description: 'Tag',
			input: {
				tags: field.list(field.text()),
				done: field.boolean(),
				note: field.text({ optional: true }),
			},
			run: (input) => Ok(input),
		});
		const given = {};
		expect(tag(given)).toEqual(Ok({ tags: [], done: false }));
		expect(given).toEqual({});
		expect(tag({ done: true })).toEqual(Ok({ tags: [], done: true }));
	});

	test('refuses a field with a default at any depth, and a field helper an option it does not declare', () => {
		expect(
			problems(() =>
				defineAction({
					description: 'Research',
					input: {
						limit: { type: 'number', default: 50 } as never,
						filter: Type.Object({ on: Type.Boolean({ default: true }) }),
						named: Type.Object({ default: Type.String() }),
					},
					run: () => Ok(undefined),
				}),
			),
		).toEqual([
			'The action "Research" has a default in "limit"; no field has one, so write the default in run, where the value is read, such as `limit ?? 50`',
			'The action "Research" has a default in "filter"; no field has one, so write the default in run, where the value is read, such as `limit ?? 50`',
		]);
		expect(() =>
			// @ts-expect-error no field helper takes a default
			field.integer({ default: 50, min: 1 }),
		).toThrow(
			'field.integer takes no default: no field has one, so write the default in code where the value is read',
		);
		expect(() =>
			// @ts-expect-error a switch takes no optional: it is never required
			field.boolean({ optional: true }),
		).toThrow('field.boolean takes no option "optional"; it takes description');
	});

	test('names each problem its types cannot', () => {
		expect(
			problems(() =>
				defineAction({
					description: 'Show',
					input: {
						a: field.text(),
						// No name is reserved: the command line reads the input as one JSON object.
						json: field.boolean(),
						help: field.text(),
						input: field.text(),
					},
					annotations: { readOnlyHint: true },
					readonly: true,
					run: () => Ok(undefined),
				} as never),
			),
		).toEqual([
			'The action "Show" has "readonly", which an action does not take',
		]);
	});
});

test('a bare return faults on direct and asynchronous action calls', async () => {
	const bare = { input: {}, description: 'Invalid action' };
	// Simulate an untyped app using the old action contract.
	const sync = defineAction({ ...bare, run: () => 'bare' } as never);
	expect(() => sync({})).toThrow('must return Ok(data) or Err(error)');
	const action = defineAction({ ...bare, run: async () => 'bare' } as never);
	await expect(action({})).rejects.toThrow(
		'must return Ok(data) or Err(error)',
	);
});

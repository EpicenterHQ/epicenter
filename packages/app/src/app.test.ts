/**
 * App composition, run context, and action and data declarations.
 * Declarations reject malformed metadata and cyclic schemas before discovery.
 */
import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import {
	createMemoryContext,
	defineAction,
	defineApp,
	defineData,
	field,
	folder,
	inRun,
	normalizePath,
	Ok,
	type Update,
} from './index.ts';

const data = defineData({ books: { fields: { title: field.text() } } });

const log = defineAction({
	description: 'Record minutes read today',
	input: { minutes: field.number() },
	run: async ({ minutes }) => {
		const before = (await folder.read('data/2026.csv')) ?? 'minutes\n';
		await folder.write('data/2026.csv', `${before}${minutes}\n`);
		return Ok({ minutes });
	},
});

const reading = defineApp({
	description: 'How much I read each week',
	data,
	actions: { books: data.books.actions('list', 'get', 'create', 'patch'), log },
});

describe('createMemoryContext', () => {
	test('an action runs against a folder in memory', async () => {
		const context = createMemoryContext({ 'data/2026.csv': 'minutes\n10\n' });
		expect(
			await inRun(context, () => reading.actions.log({ minutes: 30 })),
		).toEqual(Ok({ minutes: 30 }));
		expect(await context.folder.read('data/2026.csv')).toBe(
			'minutes\n10\n30\n',
		);
		expect(await context.folder.list()).toEqual(['data/2026.csv']);
	});

	test('a missing file reads as undefined, and a deleted one is gone', async () => {
		const { folder } = createMemoryContext({ 'a/b.md': 'b' });
		expect(await folder.read('nope.md')).toBeUndefined();
		expect(await folder.list('a')).toEqual(['a/b.md']);
		await folder.delete('a/b.md');
		expect(await folder.list()).toEqual([]);
	});

	test('the ambient folder is read only inside a run', () => {
		expect(() => folder.read('data/2026.csv')).toThrow(
			"An app's data and folder are read only inside an action's run",
		);
	});
});

describe('writes in a run', () => {
	test('refuses every folder write outside data/ and local/ while leaving reads open', async () => {
		const context = createMemoryContext({ 'README.md': 'code' });
		const attempts: (() => Promise<unknown>)[] = [
			() => folder.write('report.md', 'text'),
			() => folder.writeBytes('report.md', new Uint8Array([1])),
			() => folder.update('report.md', () => 'text'),
			() => folder.delete('report.md'),
		];
		for (const attempt of attempts)
			await expect(inRun(context, attempt)).rejects.toThrow(
				'report.md is outside data/ and local/, and an action writes only there',
			);
		await expect(
			inRun(context, () => folder.write('locals/x.md', 'text')),
		).rejects.toThrow('locals/x.md is outside data/ and local/');
		expect(await inRun(context, () => folder.read('README.md'))).toBe('code');
		expect(await context.folder.list()).toEqual(['README.md']);
	});

	test('writes under local/, which stays on this computer', async () => {
		const context = createMemoryContext();
		await inRun(context, async () => {
			await folder.write('local/google.md', 'token');
			await folder.update('local/cache/seen.txt', (text = '') => `${text}a`);
			await folder.delete('local/google.md');
		});
		expect(await context.folder.list()).toEqual(['local/cache/seen.txt']);
	});
});

describe('a run', () => {
	test("a run reaches its folder and the home's .env, and nothing else", () => {
		expect(Object.keys(createMemoryContext())).toEqual(['folder', 'env']);
	});
});

describe('normalizePath', () => {
	test('tidies a relative path', () => {
		expect(normalizePath('./a//b.md')).toBe('a/b.md');
	});

	test.each(['', '/etc/passwd', '../x', 'a/../../x', '.git/config', 'a\\b'])(
		'refuses %p',
		(path) => {
			expect(() => normalizePath(path)).toThrow();
		},
	);
});

const noop = defineAction({
	description: 'n',
	input: {},
	run: () => Ok(undefined),
});

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
	test('returns what it was given, with its actions nested under their words', () => {
		const given = { description: 'Same', data, actions: { log } };
		expect(defineApp(given)).toBe(given);
		expect(reading.data.books).toBe(data.books);
		expect(reading.actions.log).toBe(log);
		expect(Object.keys(reading.actions)).toEqual(['books', 'log']);
		expect(Object.keys(reading.actions.books)).toEqual([
			'list',
			'get',
			'create',
			'patch',
		]);
	});

	test('an action that calls another stays in the same run', async () => {
		const twice = defineAction({
			description: 'Log twice',
			input: { minutes: field.number() },
			run: async ({ minutes }) => {
				await log({ minutes });
				return log({ minutes });
			},
		});
		const context = createMemoryContext();
		await inRun(context, () => twice({ minutes: 5 }));
		expect(await context.folder.read('data/2026.csv')).toBe('minutes\n5\n5\n');
	});

	test('needs a description and actions', () => {
		expect(
			problems(() => defineApp({ description: ' ', actions: {} })),
		).toEqual(['An app needs a description']);
		expect(
			problems(() =>
				defineApp({ description: 'Bare', actions: null } as never),
			),
		).toEqual([
			'An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		]);
		expect(problems(() => defineApp(undefined as never))).toEqual([
			'An app is an object: defineApp({ description, data, actions })',
		]);
	});

	test('refuses an action named then at any depth, which a UI could not call', () => {
		expect(
			problems(() =>
				defineApp({
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
		const app = defineApp({
			description: 'Daily work',
			actions: { daily: { run: noop, start: log, description: noop } },
		});
		expect(
			Object.keys(app.actions.daily).map((word) => `daily ${word}`),
		).toEqual(['daily run', 'daily start', 'daily description']);
		expect(app.actions.daily.run).toBe(noop);
		expect(app.actions.daily.start).toBe(log);
	});

	test('refuses an object spread with an action description and plain run function', () => {
		expect(
			problems(() =>
				defineApp({
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
				defineApp({
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

describe('defineData', () => {
	test('rejects cyclic schemas at declaration before they can break discovery', () => {
		const schema: { type: string; properties: Record<string, TSchema> } = {
			type: 'object',
			properties: {},
		};
		schema.properties.self = schema;
		expect(() =>
			defineData({ records: { fields: { value: schema } } }),
		).toThrow(TypeError);
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
		const context = createMemoryContext();
		expect(await inRun(context, () => say({ message: 'hi' }))).toEqual(
			Ok({ said: 'hi' }),
		);
		const seen: unknown[] = [];
		const returned = await inRun(context, () =>
			say({ message: '猫' }, { onUpdate: (value) => seen.push(value) }),
		);
		expect(seen).toEqual(['猫', { loud: false }]);
		expect(returned).toEqual(Ok({ said: '猫' }));
		expect(await context.folder.read('data/said.md')).toBe('猫');
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

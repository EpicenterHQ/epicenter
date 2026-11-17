/**
 * App composition, run context, and action and collection declarations.
 * Declarations reject malformed metadata and cyclic schemas before discovery.
 */
import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import {
	createMemoryContext,
	defineAction,
	defineApp,
	defineCollection,
	field,
	folder,
	inRun,
	isLocalPath,
	normalizePath,
	Ok,
	type Update,
} from './index.ts';

const books = defineCollection({
	path: 'data/books/{slug}.md',
	fields: { title: field.text() },
});

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
	collections: { books },
	actions: { books: books.actions(), log },
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
			"An app's collections and folder are read only inside an action's run",
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
	test('a run reaches its folder and nothing else', () => {
		expect(Object.keys(createMemoryContext())).toEqual(['folder']);
	});
});

describe('isLocalPath', () => {
	test.each([
		'data/google.local.md',
		'x.local',
		'tokens.local/google.md',
		'a/b.local.json',
		'Token.LOCAL',
		'data/notes/Google.Local.md',
	])('%p stays on this computer', (path) => {
		expect(isLocalPath(path)).toBe(true);
	});

	test.each(['google.md', 'x.localhost.md', 'local.md', 'locals/x.md'])(
		'%p does not',
		(path) => {
			expect(isLocalPath(path)).toBe(false);
		},
	);
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
		const given = {
			description: 'Same',
			collections: { books },
			actions: { log },
		};
		expect(defineApp(given)).toBe(given);
		expect(reading.collections.books).toBe(books);
		expect(reading.actions.log).toBe(log);
		expect(Object.keys(reading.actions)).toEqual(['books', 'log']);
		expect(Object.keys(reading.actions.books)).toEqual([
			'list',
			'get',
			'add',
			'set',
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

	test('needs a description, collections, and actions', () => {
		expect(
			problems(() =>
				defineApp({ description: ' ', collections: {}, actions: {} }),
			),
		).toEqual(['An app needs a description']);
		expect(
			problems(() =>
				defineApp({ description: 'Bare', actions: null } as never),
			),
		).toEqual([
			'An app needs collections: an object of defineCollection(...), {} for none',
			'An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		]);
		expect(problems(() => defineApp(undefined as never))).toEqual([
			'An app is an object: defineApp({ description, collections, actions })',
		]);
	});

	test('refuses an action named then at any depth, which a UI could not call', () => {
		expect(
			problems(() =>
				defineApp({
					description: 'Then',
					collections: {},
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
			collections: {},
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
					collections: {},
					actions: {
						daily: { ...noop, description: 'Daily', run() {} },
					} as never,
				}),
			),
		).toEqual([
			'actions.daily is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call',
		]);
	});

	test('names collections that would hold the same file', () => {
		const at = (path: string) => defineCollection({ path, fields: {} });
		expect(
			problems(() =>
				defineApp({
					description: 'Clash',
					collections: {
						words: at('data/words/{word}.md'),
						quizzes: at('data/words/{word}.md'),
						pinned: at('data/words/pinned.md'),
					},
					actions: {},
				}),
			),
		).toEqual([
			'collections "words" and "quizzes" would both hold data/words/{word}.md',
			'collections "words" and "pinned" would both hold data/words/pinned.md',
			'collections "quizzes" and "pinned" would both hold data/words/pinned.md',
		]);
	});

	test('names keys that cannot be words, and entries that are not actions', () => {
		expect(
			problems(() =>
				defineApp({
					description: 'Bad',
					collections: { Books: books },
					actions: {},
				}),
			),
		).toEqual([
			'collections has the key "Books", which is not lowercase letters, digits, and dashes, starting with a letter',
		]);
		expect(
			problems(() =>
				defineApp({
					description: 'Bad',
					collections: {},
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

describe('defineCollection', () => {
	test('accepts raw writeOnly schema metadata as ordinary collection data', () => {
		const schema = { type: 'string', writeOnly: true };
		const collection = defineCollection({
			path: 'data/records/{id}.md',
			fields: { value: schema },
		});
		expect(collection.fields.value).toEqual(schema);
	});

	test('rejects cyclic schemas at declaration before they can break discovery', () => {
		const schema: { type: string; properties: Record<string, TSchema> } = {
			type: 'object',
			properties: {},
		};
		schema.properties.self = schema;
		expect(() =>
			defineCollection({
				path: 'data/records/{id}.md',
				fields: { value: schema },
			}),
		).toThrow(TypeError);
	});

	test('requires a data/ path and names the accepted path', () => {
		expect(
			problems(() => defineCollection({ path: 'tasks/{time}.md', fields: {} })),
		).toEqual([
			'The collection path "tasks/{time}.md" must start with data/: data/tasks/{time}.md',
		]);
	});

	test('allows names reserved for code when they are under data/', () => {
		for (const path of [
			'data/ui/{page}.md',
			'data/node_modules/{id}.md',
			'data/epicenter.md',
		])
			expect(problems(() => defineCollection({ path, fields: {} }))).toEqual(
				[],
			);
	});

	test.each([
		['data/../x.md', 'data/../x.md has a part that starts with "."'],
		['data/./{id}.md', 'data/./{id}.md has a part that starts with "."'],
		['data/a//{id}.md', 'data/a//{id}.md is not a relative path'],
		['data//abs/{id}.md', 'data//abs/{id}.md is not a relative path'],
		['data/words/', 'data/words/ is not a .md path'],
		['data/photos/{id}.jpg', 'data/photos/{id}.jpg is not a .md path'],
		[
			'data/words/{a}-{b}.md',
			'data/words/{a}-{b}.md has two placeholders in "{a}-{b}.md", so a name could not be split between them',
		],
		['data/a/{a}/{a}.md', 'data/a/{a}/{a}.md has {a} twice'],
		[
			'data/words/{a.md',
			'data/words/{a.md has a brace that is not a placeholder such as {word}',
		],
	])('refuses the path %p', (path, problem) => {
		expect(problems(() => defineCollection({ path, fields: {} }))).toEqual([
			`The collection path ${problem}`,
		]);
	});

	test('names fields a file cannot hold', () => {
		expect(
			problems(() =>
				defineCollection({
					path: 'data/words/{word}.md',
					fields: {
						word: field.text(),
						body: field.text(),
						path: field.text(),
						problems: field.text(),
						edit: field.text(),
						'two words': field.text(),
					},
				}),
			),
		).toEqual([
			'The collection at data/words/{word}.md has a field "word", which its path gives as {word}; the file\'s name holds it',
			'The collection at data/words/{word}.md has a field "body", which is the file\'s text after its front matter',
			'The collection at data/words/{word}.md has a field "path", which is the file\'s address',
			'The collection at data/words/{word}.md has a field "edit", which the set verb takes beside the fields',
			'The collection at data/words/{word}.md has a field "two words", which a front matter line cannot name',
		]);
	});

	test('names placeholders a read or the set verb takes itself', () => {
		const path = 'data/notes/{body}/{path}/{problems}/{edit}/{input}.md';
		expect(problems(() => defineCollection({ path, fields: {} }))).toEqual([
			`The collection at ${path} has the placeholder {body}, which is the file's text after its front matter`,
			`The collection at ${path} has the placeholder {path}, which is the file's address`,
			`The collection at ${path} has the placeholder {edit}, which the set verb takes beside the fields`,
		]);
	});

	test('a keyless collection must be readable before its first write', () => {
		expect(
			problems(() =>
				defineCollection({
					path: 'data/settings.md',
					fields: { voice: field.select(['female', 'male']) },
				}),
			),
		).toEqual([
			'The collection at data/settings.md is one file, read as empty before it exists, so the field "voice" must be optional, a switch, or a list without min',
		]);
	});

	test('a collection has one path, and a list is refused', () => {
		const path = ['data/entries/{time}.md', 'data/entries/archive/{slug}.md'];
		expect(
			problems(() =>
				defineCollection({ path: path as unknown as string, fields: {} }),
			),
		).toEqual([
			'A collection has one path, not a list ("data/entries/{time}.md", "data/entries/archive/{slug}.md"); declare a second collection for a second layout',
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
		expect(action.input.value).toEqual(schema);
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
		).toThrow(
			'field.boolean takes no option "optional"; it takes description, readOnly',
		);
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

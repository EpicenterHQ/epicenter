import { describe, expect, test } from 'bun:test';
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
} from './index.ts';

const books = defineCollection({
	path: 'data/books/{slug}.md',
	fields: { title: field.text() },
});

const log = defineAction({
	description: 'Record minutes read today',
	input: { minutes: field.number() },
	positional: ['minutes'],
	run: async ({ minutes }) => {
		const before = (await folder.read('data/2026.csv')) ?? 'minutes\n';
		await folder.write('data/2026.csv', `${before}${minutes}\n`);
		return { minutes };
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
		).toEqual({ minutes: 30 });
		expect(await context.folder.read('data/2026.csv')).toBe('minutes\n10\n30\n');
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
	test('refuses every folder write outside data/ while leaving reads open', async () => {
		const context = createMemoryContext({ 'README.md': 'code' });
		const attempts = [
			() => folder.write('report.md', 'text'),
			() => folder.writeBytes('report.md', new Uint8Array([1])),
			() => folder.update('report.md', () => 'text'),
			() => folder.delete('report.md'),
		];
		for (const attempt of attempts)
			await expect(inRun(context, attempt)).rejects.toThrow(
				'report.md is outside data/, and an action writes only there',
			);
		expect(await inRun(context, () => folder.read('README.md'))).toBe('code');
		expect(await context.folder.list()).toEqual(['README.md']);
	});

	test('refuses every folder write into a .git* path segment', async () => {
		const context = createMemoryContext();
		for (const path of ['data/.git/hooks/x', 'data/.gitignore', 'data/nested/.gitattributes']) {
			for (const attempt of [
				() => folder.write(path, 'text'),
				() => folder.writeBytes(path, new Uint8Array([1])),
				() => folder.update(path, () => 'text'),
				() => folder.delete(path),
			])
				await expect(inRun(context, attempt)).rejects.toThrow('.git* path segment');
		}
		expect(await context.folder.list()).toEqual([]);
	});
});

describe('a read-only run', () => {
	test('refuses every write through folder and collections before it happens, and still reads', async () => {
		const memory = createMemoryContext({
			'data/2026.csv': 'minutes\n',
			'data/books/dune.md': '---\ntitle: "Dune"\n---\n',
		});
		const context = { ...memory, readOnly: { action: 'week show' } };
		const refused = (doing: string) =>
			`The action "week show" is read-only, so it cannot ${doing}`;
		const tries: [() => Promise<unknown>, string][] = [
			[() => folder.write('data/2026.csv', 'x'), refused('write data/2026.csv')],
			[
				() => folder.writeBytes('data/a.bin', new Uint8Array([1])),
				refused('write data/a.bin'),
			],
			[
				() => folder.update('data/2026.csv', (text) => `${text}x`),
				refused('write data/2026.csv'),
			],
			[() => folder.delete('data/2026.csv'), refused('delete data/2026.csv')],
			[
				() => books.set({ path: 'data/books/dune.md', title: 'Other' }),
				refused('write data/books/dune.md'),
			],
			[
				() => books.delete({ path: 'data/books/dune.md' }),
				refused('delete data/books/dune.md'),
			],
		];
		for (const [attempt, message] of tries)
			await expect(inRun(context, attempt)).rejects.toThrow(message);
		expect(await context.folder.list()).toEqual(['data/2026.csv', 'data/books/dune.md']);
		expect(await context.folder.read('data/2026.csv')).toBe('minutes\n');
		expect(
			await inRun(context, () => books.get({ path: 'data/books/dune.md' })),
		).toMatchObject({ title: 'Dune' });
	});

	test('writes and deletes a .local file, as a token refresh does', async () => {
		const google = defineCollection({
			path: 'data/google.local.md',
			fields: { refreshToken: field.text({ optional: true }) },
		});
		const context = {
			...createMemoryContext({
				'data/google.local.md': '---\nrefreshToken: "old"\n---\n',
			}),
			readOnly: { action: 'mail list' },
		};
		await inRun(context, async () => {
			await google.set({ refreshToken: 'new' });
			await folder.write('data/cache.local', 'x');
			await folder.delete('data/cache.local');
		});
		expect(await context.folder.read('data/google.local.md')).toBe(
			'---\nrefreshToken: "new"\n---\n',
		);
		expect(await context.folder.list()).toEqual(['data/google.local.md']);
	});

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

const noop = defineAction({ description: 'n', input: {}, run() {} });

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
			'edit',
			'delete',
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
					actions: { then: noop, group: { then: noop, inner: { then: noop } } },
				}),
			),
		).toEqual([
			'actions.then is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word',
			'actions.group.then is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word',
			'actions.group.inner.then is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word',
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
	test('requires a data/ path and names the accepted path', () => {
		expect(problems(() => defineCollection({ path: 'tasks/{time}.md', fields: {} }))).toEqual([
			'The collection path "tasks/{time}.md" must start with data/: data/tasks/{time}.md',
		]);
	});

	test('allows names reserved for code when they are under data/', () => {
		for (const path of ['data/ui/{page}.md', 'data/node_modules/{id}.md', 'data/epicenter.md'])
			expect(problems(() => defineCollection({ path, fields: {} }))).toEqual([]);
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
						other: field.text(),
						json: field.text(),
						'two words': field.text(),
					},
				}),
			),
		).toEqual([
			'The collection at data/words/{word}.md has a field "word", which its path gives as {word}; the file\'s name holds it',
			'The collection at data/words/{word}.md has a field "body", which is the file\'s text after its front matter',
			'The collection at data/words/{word}.md has a field "path", which is the file\'s address',
			'The collection at data/words/{word}.md has a field "problems", which a read uses to say what does not fit',
			'The collection at data/words/{word}.md has a field "other", which a read uses for front matter that is not a field',
			'The collection at data/words/{word}.md has a field "json", which epicenter reads itself',
			'The collection at data/words/{word}.md has a field "two words", which a front matter line cannot name',
		]);
	});

	test('names placeholders a read or epicenter gives itself', () => {
		expect(
			problems(() =>
				defineCollection({
					path: 'data/notes/{body}/{path}/{problems}/{other}/{input}.md',
					fields: {},
				}),
			),
		).toEqual([
			"The collection at data/notes/{body}/{path}/{problems}/{other}/{input}.md has the placeholder {body}, which is the file's text after its front matter",
			"The collection at data/notes/{body}/{path}/{problems}/{other}/{input}.md has the placeholder {path}, which is the file's address",
			'The collection at data/notes/{body}/{path}/{problems}/{other}/{input}.md has the placeholder {problems}, which a read uses to say what does not fit',
			'The collection at data/notes/{body}/{path}/{problems}/{other}/{input}.md has the placeholder {other}, which a read uses for front matter that is not a field',
			'The collection at data/notes/{body}/{path}/{problems}/{other}/{input}.md has the placeholder {input}, which epicenter reads itself',
		]);
	});

	test('a one-file collection has no required field without a default', () => {
		expect(
			problems(() =>
				defineCollection({
					path: 'data/settings.md',
					fields: {
						voice: field.select(['female', 'male']),
						goal: field.integer({ optional: true }),
						loud: field.boolean(),
					},
				}),
			),
		).toEqual([
			'The collection at data/settings.md has the required field "voice" with no default; one file reads as its defaults before its first set, so make it optional or give it a default',
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
	test('a direct call fills the defaults a call through the CLI or MCP would', async () => {
		const tag = defineAction({
			description: 'Tag',
			input: {
				tags: field.tags(),
				done: field.boolean(),
				note: field.text({ optional: true }),
			},
			run: (input) => input,
		});
		const given = {};
		expect(tag(given)).toEqual({ tags: [], done: false });
		expect(given).toEqual({});
		expect(tag({ done: true })).toEqual({ tags: [], done: true });
	});

	test('names each problem its types cannot', () => {
		expect(
			problems(() =>
				defineAction({
					description: 'Show',
					input: {
						a: field.text(),
						b: field.tags(),
						json: field.boolean(),
						// Not reserved: `--version` is read only on its own.
						version: field.text(),
					},
					positional: ['b', 'a', 'a', 'nope' as 'a'],
					annotations: { readOnlyHint: true, dangerous: true } as never,
					readonly: true,
					run() {},
				} as never),
			),
		).toEqual([
			'The action "Show" has "readonly", which an action does not take',
			'The action "Show" has the annotation "dangerous", which MCP does not define',
			'The action "Show" has a field named "json", which epicenter reads itself',
			'The action "Show" has the list "b" as a positional before the last, so the ones after it could never be given',
			'The action "Show" lists the positional "a" twice',
			'The action "Show" has the positional "nope", which is not one of its fields',
		]);
	});
});

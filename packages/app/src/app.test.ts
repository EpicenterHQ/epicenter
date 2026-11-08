import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	createMemoryContext,
	declarationJsonSchema,
	defineApp,
	field,
	normalizePath,
	problemsOf,
} from './index.ts';

const declaration = {
	name: 'reading',
	description: 'How much I read each week',
	collections: {
		books: {
			path: 'books/{slug}.md',
			fields: { type: 'object', properties: { title: { type: 'string' } } },
		},
	},
};

const reading = defineApp(declaration, {
	actions: {
		log: {
			description: 'Record minutes read today',
			input: { minutes: field.number() },
			positional: ['minutes'],
			run: async ({ minutes }, { folder }) => {
				const before = (await folder.read('2026.csv')) ?? 'minutes\n';
				await folder.write('2026.csv', `${before}${minutes}\n`);
				return { minutes };
			},
		},
	},
});

describe('createMemoryContext', () => {
	test('an action runs against a folder in memory', async () => {
		const context = createMemoryContext({ '2026.csv': 'minutes\n10\n' });
		expect(await reading.actions.log.run({ minutes: 30 }, context)).toEqual({
			minutes: 30,
		});
		expect(await context.folder.read('2026.csv')).toBe('minutes\n10\n30\n');
		expect(await context.folder.list()).toEqual(['2026.csv']);
	});

	test('a missing file reads as undefined, and a deleted one is gone', async () => {
		const { folder } = createMemoryContext({ 'a/b.md': 'b' });
		expect(await folder.read('nope.md')).toBeUndefined();
		expect(await folder.list('a')).toEqual(['a/b.md']);
		await folder.delete('a/b.md');
		expect(await folder.list()).toEqual([]);
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

describe('problemsOf', () => {
	test('a declaration alone, and a declaration with its code, have none', () => {
		expect(problemsOf(declaration)).toEqual([]);
		expect(problemsOf(declaration, reading)).toEqual([]);
	});

	test('names what the declaration schema refuses, by JSON pointer', () => {
		expect(
			problemsOf({
				name: 'Reading',
				collections: { books: { path: '/abs/{a}/{b}.md', fields: {} } },
				extra: true,
			}),
		).toEqual([
			'epicenter.json at / must have required properties description',
			'epicenter.json at / has "extra", which a declaration does not take',
			'epicenter.json at /name must match pattern "^[a-z][a-z0-9-]*$"',
			'epicenter.json at /collections/books/path is not a path inside the folder with at most one placeholder, such as words/{stem}.md',
			'epicenter.json at /collections/books/fields must have required properties type',
		]);
	});

	test.each([
		'../x.md',
		'a/../{id}.md',
		'./{id}.md',
		'a//{id}.md',
		'words/',
		'{a}/{b}.md',
	])('refuses the collection path %p', (path) => {
		expect(
			problemsOf({
				name: 'vocab',
				description: 'Words',
				collections: { words: { path, fields: { type: 'object' } } },
			}),
		).toEqual([
			'epicenter.json at /collections/words/path is not a path inside the folder with at most one placeholder, such as words/{stem}.md',
		]);
	});

	test('names code that is missing, carries another declaration, or writes fields as JSON Schema', () => {
		const vocab = {
			name: 'vocab',
			description: 'Words',
			collections: {
				words: { path: 'words/{stem}.md', fields: { type: 'object' } },
			},
		};
		expect(problemsOf(vocab, null)).toEqual([
			'epicenter.ts does not export defineApp(...) by default',
		]);
		expect(
			problemsOf(vocab, {
				declaration: { ...vocab, description: 'Other words' },
				collections: {
					quizzes: {
						path: 'words/{stem}.md',
						fields: { type: 'object', properties: {} },
					},
				},
				actions: {},
			}),
		).toEqual([
			"epicenter.ts passes defineApp a declaration that differs from epicenter.json; import it from './epicenter.json'",
			'collections "words" and "quizzes" share the path words/{stem}.md',
			'collection "quizzes" has fields that are not a map of fields, such as { title: field.text() }; JSON Schema belongs in epicenter.json',
		]);
	});

	test('names each problem in the code', () => {
		const problems = problemsOf(
			{
				name: 'serve',
				description: 'Bad',
				collections: {
					words: { path: 'words/{stem}.md', fields: { type: 'object' } },
				},
			},
			{
				collections: {
					words: { path: 'words/{stem}.md', fields: {} },
					settings: { path: 'settings.json', fields: {} },
				},
				actions: {
					calendar: { description: 'c', input: {}, readonly: true, run() {} },
					'calendar show': {
						description: 'Show',
						input: { a: field.text(), b: field.tags(), json: field.boolean() },
						positional: ['b', 'a', 'a', 'nope'],
						annotations: { readOnlyHint: true, dangerous: true },
						run() {},
					},
					'words save': { description: 'Mine', input: {}, run() {} },
					settings: { description: 'Settings', input: {}, run() {} },
					'Bad Name': { description: 'b', input: {}, run() {} },
				},
			},
		);
		expect(problems).toEqual([
			'its name "serve" is an epicenter command',
			'collection "words" is declared in both epicenter.json and epicenter.ts',
			'action "calendar" is the start of action "calendar show", so "calendar show" could not be told apart',
			'action "calendar" has "readonly", which an action does not take',
			'action "calendar show" has the annotation "dangerous", which MCP does not define',
			'action "calendar show" has a field named "json", which epicenter reads itself',
			'action "calendar show" has the list "b" as a positional before the last, so the ones after it could never be given',
			'action "calendar show" lists the positional "a" twice',
			'action "calendar show" has the positional "nope", which is not one of its fields',
			'action "words save" is one collection "words" gives; name it something else',
			'action "settings" is the start of action "settings show", so "settings show" could not be told apart',
			'action "Bad Name" is not words of lowercase letters, digits, and dashes, one space apart',
		]);
	});

	test('code that is not defineApp(...)', () => {
		expect(problemsOf(declaration, undefined)).toEqual([]);
		expect(problemsOf(declaration, null)).toEqual([
			'epicenter.ts does not export defineApp(...) by default',
		]);
	});
});

test('epicenter.schema.json is the declaration schema; run `bun run schema` after changing it', async () => {
	expect(
		await Bun.file(join(import.meta.dir, '../epicenter.schema.json')).text(),
	).toBe(declarationJsonSchema());
});

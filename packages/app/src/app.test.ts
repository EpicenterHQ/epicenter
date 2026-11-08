import { describe, expect, test } from 'bun:test';
import {
	createMemoryContext,
	defineApp,
	field,
	normalizePath,
	problemsOf,
} from './index.ts';

const reading = defineApp({
	name: 'reading',
	description: 'How much I read each week',
	actions: {
		log: {
			description: 'Record minutes read today',
			input: { minutes: field.number({ positional: true }) },
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

	test('a missing file reads as undefined, and a removed one is gone', async () => {
		const { folder } = createMemoryContext({ 'a/b.md': 'b' });
		expect(await folder.read('nope.md')).toBeUndefined();
		expect(await folder.list('a')).toEqual(['a/b.md']);
		await folder.remove('a/b.md');
		expect(await folder.list()).toEqual([]);
	});

	test('the cache clears; the folder has no clear', async () => {
		const context = createMemoryContext();
		await context.cache.write('index.json', '{}');
		await context.cache.clear();
		expect(await context.cache.list()).toEqual([]);
		expect('clear' in context.folder).toBe(false);
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
	test('a well-formed app has none', () => {
		expect(problemsOf(reading)).toEqual([]);
	});

	test('names each problem', () => {
		const problems = problemsOf({
			name: 'sync',
			description: '',
			actions: {
				calendar: { description: 'c', input: {}, readonly: true, run() {} },
				'calendar show': {
					description: 'Show',
					input: {
						a: field.text({ positional: true }),
						b: field.text({ positional: true }),
						json: field.boolean(),
					},
					readOnly: true,
					destructive: true,
					run() {},
				},
				'Bad Name': { description: 'b', input: {}, run() {} },
			},
		});
		expect(problems).toEqual([
			'its name "sync" is an epicenter command',
			'it has no description',
			'action "calendar" is the start of action "calendar show", so "calendar show" could not be told apart',
			'action "calendar" has "readonly", which an action does not take',
			'action "calendar show" is both readOnly and destructive',
			'action "calendar show" has a field named "json", which epicenter reads itself',
			'action "calendar show" has 2 positional fields (a, b); at most one',
			'action "Bad Name" is not words of lowercase letters, digits, and dashes, one space apart',
		]);
	});

	test('something that is not an app', () => {
		expect(problemsOf(undefined)).toEqual([
			'epicenter.ts does not export an app by default',
		]);
	});
});

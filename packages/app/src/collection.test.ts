import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import {
	createMemoryContext,
	defineAction,
	defineApp,
	defineCollection,
	field,
	inRun,
	isAction,
} from './index.ts';

const items = defineCollection({
	path: 'items/{id}.md',
	fields: {
		kind: field.select(['thought', 'link', 'quote']),
		url: Type.Optional(Type.String({ format: 'uri' })),
		added: field.date(),
		done: field.boolean(),
		reviewed: field.date({ optional: true, readOnly: true }),
	},
});

const settings = defineCollection({
	path: 'settings.md',
	fields: {
		dailyGoal: field.integer({ optional: true }),
		voice: Type.Union([Type.Literal('female'), Type.Literal('male')], {
			default: 'female',
		}),
	},
});

const review = defineAction({
	description: 'Mark an item reviewed',
	input: { path: field.text() },
	run: ({ path }) => items.set({ path, reviewed: '2026-11-10' }),
});

const app = defineApp({
	description: 'Things',
	collections: { items, settings },
	actions: {
		items: { ...items.actions(), review },
		settings: settings.actions(),
	},
});

type Context = ReturnType<typeof createMemoryContext>;

/** Run the action at `words` as the runner does: by its words, with input it has not checked. */
function run(words: string, input: object, context: Context): Promise<unknown> {
	const action = words
		.split(' ')
		.reduce<unknown>(
			(at, word) => (at as Record<string, unknown>)?.[word],
			app.actions,
		);
	if (!isAction(action)) throw new Error(`no action ${words}`);
	return Promise.resolve(inRun(context, () => action(input)));
}

describe('a collection of many files', () => {
	test('gives six verbs, each addressed by path', () => {
		expect(Object.keys(app.actions.items)).toEqual([
			'list',
			'get',
			'add',
			'set',
			'edit',
			'delete',
			'review',
		]);
		expect(Object.keys(app.actions.settings)).toEqual(['get', 'set', 'edit']);
		expect(app.actions.items.get.positional).toEqual(['path']);
		expect(app.actions.items.add.positional).toEqual(['id']);
		expect(app.actions.items.list.annotations).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
		});
		expect(app.actions.items.list.description).toBe(
			'Every items/{id}.md file: its path and fields, and the problems of one that does not fit them',
		);
	});

	test('add makes a file as key: <JSON> lines in declared order, with defaults and a body', async () => {
		const context = createMemoryContext();
		const made = await run(
			'items add',
			{
				id: 'dune',
				added: '2026-11-09',
				kind: 'quote',
				body: 'Fear is the mind-killer.\n',
			},
			context,
		);
		expect(await context.folder.read('items/dune.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-09"\ndone: false\n---\nFear is the mind-killer.\n',
		);
		expect(made).toEqual({
			path: 'items/dune.md',
			id: 'dune',
			kind: 'quote',
			added: '2026-11-09',
			done: false,
			body: 'Fear is the mind-killer.\n',
		});
	});

	test('add refuses a file already there, and one without its required fields', async () => {
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\nKept.\n';
		const context = createMemoryContext({ 'items/a.md': text });
		expect(
			run(
				'items add',
				{ id: 'a', kind: 'quote', added: '2026-11-02' },
				context,
			),
		).rejects.toThrow('items/a.md is already there');
		expect(
			run('items add', { id: 'b', kind: 'quote' }, context),
		).rejects.toThrow('items/b.md: added is missing');
		expect(await context.folder.list()).toEqual(['items/a.md']);
		expect(await context.folder.read('items/a.md')).toBe(text);
	});

	test('add names a file by the time when its path holds {time}', async () => {
		const notes = defineCollection({
			path: 'notes/{year}/{time}.md',
			fields: { title: field.text() },
		});
		const { add } = notes.actions('add');
		const context = createMemoryContext();
		const made = await inRun(context, () => add({ year: '2026', title: 'A' }));
		expect(made.path).toMatch(
			/^notes\/2026\/\d{4}-\d\d-\d\dT[\d-]+Z-[a-z0-9]{8}\.md$/,
		);
		expect(
			inRun(context, () => add({ year: '../x', title: 'A' })),
		).rejects.toThrow('cannot name a file');
	});

	test('set changes only the lines it is given, keeping the rest byte for byte', async () => {
		const text =
			'---\nkind: "thought"\nadded:   "2026-11-01"\ndone: true\n---\n\nKeep me.\n';
		const context = createMemoryContext({ 'items/a.md': text });
		await run(
			'items set',
			{ path: 'items/a.md', kind: 'link', url: 'https://example.com' },
			context,
		);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\n\nKeep me.\n',
		);
		await run(
			'items edit',
			{ path: 'items/a.md', old: '\nKeep me.\n', new: 'New.\n' },
			context,
		);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\nNew.\n',
		);
	});

	test('set changes a file that is there and refuses one that is not', async () => {
		const context = createMemoryContext();
		expect(
			run('items set', { path: 'items/nope.md', kind: 'link' }, context),
		).rejects.toThrow('There is no items/nope.md');
		expect(await context.folder.list()).toEqual([]);
	});

	test('set removes a field given as null, and takes null only for one a file may go without', async () => {
		const context = createMemoryContext({
			'items/a.md':
				'---\nkind: "link"\nurl: "https://example.com"\nadded: "2026-11-01"\n---\nKeep me.\n',
		});
		await run('items set', { path: 'items/a.md', url: null }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "link"\nadded: "2026-11-01"\n---\nKeep me.\n',
		);
		expect(
			run('items set', { path: 'items/a.md', kind: null }, context),
		).rejects.toThrow('kind is required, so it cannot be removed');
		const input = app.actions.items.set.input as Record<
			string,
			{ anyOf?: { type?: string }[] }
		>;
		const takesNull = (key: string) =>
			input[key]?.anyOf?.some((choice) => choice.type === 'null') ?? false;
		expect(takesNull('url')).toBe(true);
		expect(takesNull('done')).toBe(true);
		expect(takesNull('kind')).toBe(false);
	});

	test('set given nothing refuses, and writes nothing', async () => {
		const text = '---\nkind: "thought"\n---\nKeep me.\n';
		const context = createMemoryContext({ 'items/a.md': text });
		expect(run('items set', { path: 'items/a.md' }, context)).rejects.toThrow(
			'Nothing to set in items/a.md: give a field',
		);
		expect(await context.folder.read('items/a.md')).toBe(text);
	});

	test("a readOnly field is left out of add and set, and written by the app's own action", async () => {
		expect(Object.keys(app.actions.items.set.input)).not.toContain('reviewed');
		expect(Object.keys(app.actions.items.add.input)).not.toContain('reviewed');
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\n';
		const context = createMemoryContext({ 'items/a.md': text });
		expect(
			run('items set', { path: 'items/a.md', reviewed: '2026-11-10' }, context),
		).rejects.toThrow("reviewed is written only by the app's own actions");
		await run('items review', { path: 'items/a.md' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "thought"\nadded: "2026-11-01"\nreviewed: "2026-11-10"\n---\n',
		);
	});

	test('a path that is not one of its files is refused, naming its path', async () => {
		const context = createMemoryContext({
			'settings.md': '---\nvoice: "female"\n---\n',
		});
		expect(
			run('items set', { path: 'settings.md', kind: 'link' }, context),
		).rejects.toThrow('settings.md is not a file at items/{id}.md');
		expect(
			run('items get', { path: 'elsewhere/a.md' }, context),
		).rejects.toThrow('elsewhere/a.md is not a file at items/{id}.md');
	});

	test('edit replaces one quoted passage of the body, and refuses one it cannot find exactly once', async () => {
		const context = createMemoryContext({
			'items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\n---\nWater the plant.\nWater the cat.\n',
		});
		const at = { path: 'items/a.md' };
		expect(
			await run(
				'items edit',
				{ ...at, old: 'the plant', new: 'both plants' },
				context,
			),
		).toMatchObject({
			kind: 'thought',
			body: 'Water both plants.\nWater the cat.\n',
		});
		expect(
			run('items edit', { ...at, old: 'the plant', new: 'x' }, context),
		).rejects.toMatchObject({
			name: 'Changed',
			message: expect.stringContaining('does not have that text'),
		});
		expect(
			run('items edit', { ...at, old: 'Water', new: 'Feed' }, context),
		).rejects.toThrow('more than once');
		expect(
			run('items edit', { ...at, old: '', new: 'x' }, context),
		).rejects.toMatchObject({ name: 'Changed' });
		expect(
			run('items edit', { path: 'items/nope.md', old: 'a', new: 'b' }, context),
		).rejects.toThrow('There is no items/nope.md');
	});

	test('edit with an empty old fills an empty body, in YAML front matter too', async () => {
		const context = createMemoryContext({
			'items/a.md': '---\nkind: thought\nadded: 2026-11-01\n---\n',
		});
		await run(
			'items edit',
			{ path: 'items/a.md', old: '', new: 'First words.\n' },
			context,
		);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: thought\nadded: 2026-11-01\n---\nFirst words.\n',
		);
	});

	test('set rewrites YAML front matter as key: <JSON> lines and keeps the body', async () => {
		const context = createMemoryContext({
			'items/a.md':
				'---\nkind: thought # a comment\nadded: 2026-11-01\ntags: [x, y]\n---\nBody\n',
		});
		expect(await run('items get', { path: 'items/a.md' }, context)).toEqual({
			path: 'items/a.md',
			id: 'a',
			kind: 'thought',
			added: '2026-11-01',
			done: false,
			body: 'Body\n',
			other: { tags: ['x', 'y'] },
		});
		await run('items set', { path: 'items/a.md', kind: 'quote' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-01"\ntags: ["x", "y"]\n---\nBody\n',
		);
	});

	test('a file without front matter is all body, and set adds front matter above it', async () => {
		const context = createMemoryContext({ 'items/a.md': '# Just text\n' });
		expect(await run('items get', { path: 'items/a.md' }, context)).toEqual({
			path: 'items/a.md',
			id: 'a',
			done: false,
			body: '# Just text\n',
			problems: ['kind is missing', 'added is missing'],
		});
		await run('items set', { path: 'items/a.md', kind: 'thought' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "thought"\n---\n# Just text\n',
		);
	});

	test('front matter that is neither grammar nor YAML is read as body, and set refuses it', async () => {
		const text = '---\nkind: [unclosed\n---\nBody\n';
		const context = createMemoryContext({ 'items/a.md': text });
		expect(await run('items get', { path: 'items/a.md' }, context)).toEqual({
			path: 'items/a.md',
			id: 'a',
			done: false,
			body: text,
			problems: ['its front matter is neither key: <JSON> lines nor YAML'],
		});
		expect(
			run('items set', { path: 'items/a.md', kind: 'quote' }, context),
		).rejects.toThrow(
			'items/a.md has front matter that is neither key: <JSON> lines nor YAML; fix it by hand first',
		);
		expect(await context.folder.read('items/a.md')).toBe(text);
	});

	test('list reads every file a template matches, with its path, without bodies', async () => {
		const context = createMemoryContext({
			'items/b.md': '---\nkind: "link"\n---\nB\n',
			'items/a.md': 'no front matter\n',
			'items/.hidden.md': '---\nkind: "x"\n---\n',
			'items/nested/c.md': '---\nkind: "x"\n---\n',
			'items/notes.txt': 'not a match',
			'other/d.md': '---\nkind: "x"\n---\n',
		});
		expect(await run('items list', {}, context)).toEqual([
			{
				path: 'items/a.md',
				id: 'a',
				done: false,
				problems: ['kind is missing', 'added is missing'],
			},
			{
				path: 'items/b.md',
				id: 'b',
				kind: 'link',
				done: false,
				problems: ['added is missing'],
			},
		]);
	});

	test('a collection in several places lists them all and adds to the first', async () => {
		const entries = defineCollection({
			path: ['entries/{time}.md', 'entries/archive/{slug}.md'],
			fields: { text: field.text({ optional: true }) },
		});
		const context = createMemoryContext({
			'entries/0lnc4n46f9.md': '---\ntext: "a"\n---\n',
			'entries/archive/old.md': '---\ntext: "b"\n---\n',
		});
		const rows = await inRun(context, () => entries.list());
		expect(rows).toEqual([
			{ path: 'entries/0lnc4n46f9.md', time: '0lnc4n46f9', text: 'a' },
			{ path: 'entries/archive/old.md', slug: 'old', text: 'b' },
		]);
		expect(entries.holds('entries/archive/old.md')).toBe(true);
		expect(entries.holds('entries/archive/deeper/old.md')).toBe(false);
		const { add } = entries.actions('add');
		const made = await inRun(context, () => add({ text: 'c' }));
		expect(made.path).toStartWith('entries/2');
		expect(made.path.split('/')).toHaveLength(2);
	});

	test('delete answers whether a file was there', async () => {
		const context = createMemoryContext({ 'items/a.md': 'A\n' });
		expect(await run('items delete', { path: 'items/a.md' }, context)).toBe(
			true,
		);
		expect(await run('items delete', { path: 'items/a.md' }, context)).toBe(
			false,
		);
		expect(await context.folder.list()).toEqual([]);
	});
});

describe('a read', () => {
	test('takes path, placeholders, and body from the file, never from its front matter', async () => {
		const context = createMemoryContext({
			'items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\npath: "items/b.md"\nid: "b"\nbody: "Fake."\n---\nReal.\n',
		});
		expect(
			await inRun(context, () => items.get({ path: 'items/a.md' })),
		).toEqual({
			path: 'items/a.md',
			id: 'a',
			kind: 'thought',
			added: '2026-11-01',
			done: false,
			body: 'Real.\n',
			other: { path: 'items/b.md', id: 'b', body: 'Fake.' },
		});
		expect(await inRun(context, () => items.list())).toEqual([
			{
				path: 'items/a.md',
				id: 'a',
				kind: 'thought',
				added: '2026-11-01',
				done: false,
			},
		]);
	});

	test('leaves out a value that does not fit, or reads its default, and quotes it in problems', async () => {
		const text =
			'---\nkind: "song"\nadded: "next week"\ndone: "yes"\nreviewed: null\n---\n';
		const context = createMemoryContext({ 'items/a.md': text });
		const problems = [
			'kind: "song" is not one of "thought", "link", "quote"',
			'added: "next week" is not a day',
			'done: "yes" is not true or false',
			'reviewed: null is not a day',
		];
		expect(
			await inRun(context, () => items.get({ path: 'items/a.md' })),
		).toEqual({
			path: 'items/a.md',
			id: 'a',
			done: false,
			body: '',
			problems,
			other: { kind: 'song', added: 'next week', done: 'yes', reviewed: null },
		});
		expect(await inRun(context, () => items.list())).toEqual([
			{ path: 'items/a.md', id: 'a', done: false, problems },
		]);
		expect(await inRun(context, () => items.misfits())).toEqual([
			`items/a.md: ${problems.join('; ')}`,
		]);
		await inRun(context, () =>
			items.set({ path: 'items/a.md', kind: 'quote' }),
		);
		expect(await context.folder.read('items/a.md')).toBe(
			text.replace('"song"', '"quote"'),
		);
	});

	test('reads a missing field as its default, without a problem', async () => {
		const context = createMemoryContext({
			'items/a.md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		});
		const [row] = await inRun(context, () => items.list());
		expect(row).toEqual({
			path: 'items/a.md',
			id: 'a',
			kind: 'link',
			added: '2026-11-01',
			done: false,
		});
	});
});

describe('pathOf', () => {
	test('fills the first template as add does, refusing a value that cannot name a file', () => {
		expect(items.pathOf({ id: 'dune' })).toBe('items/dune.md');
		for (const id of ['../x', 'a/b', 'a\\b', '.hidden', ''])
			expect(() => items.pathOf({ id })).toThrow('cannot name a file');
		expect(() => items.pathOf({} as never)).toThrow(
			'A items/{id}.md file is named by its id; give it',
		);
	});
});

describe('a readOnly field that is required and has no default', () => {
	test('leaves add out of the actions, and naming add throws', () => {
		const stamps = defineCollection({
			path: 'stamps/{id}.md',
			fields: { at: field.datetime({ readOnly: true }), note: field.text() },
		});
		expect(Object.keys(stamps.actions())).toEqual([
			'list',
			'get',
			'set',
			'edit',
			'delete',
		]);
		expect(() => stamps.actions('add' as never)).toThrow(
			'stamps/{id}.md has no "add": at is written only by the app\'s own actions, required, and without a default, so an exposed add could never be given it; write the app\'s own add with defineAction',
		);
	});
});

describe('a collection of one file', () => {
	test('reads as its defaults while there is none, and its first set makes it', async () => {
		const context = createMemoryContext();
		expect(await run('settings get', {}, context)).toEqual({
			path: 'settings.md',
			voice: 'female',
			body: '',
		});
		expect(await context.folder.list()).toEqual([]);
		expect(run('settings set', { voice: 'robot' }, context)).rejects.toThrow(
			'settings.md: voice: "robot" is not one of "female", "male"',
		);
		await run('settings set', { dailyGoal: 20 }, context);
		expect(await context.folder.read('settings.md')).toBe(
			'---\ndailyGoal: 20\nvoice: "female"\n---\n',
		);
		await run('settings set', { dailyGoal: null }, context);
		await run('settings edit', { old: '', new: 'Notes.\n' }, context);
		expect(await run('settings get', {}, context)).toEqual({
			path: 'settings.md',
			voice: 'female',
			body: 'Notes.\n',
		});
	});
});

describe('misfits', () => {
	test('names each file whose fields do not fit, by path', async () => {
		const context = createMemoryContext({
			'items/a.md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
			'items/b.md': '---\nkind: "song"\nadded: "2026-11-01"\n---\n',
			'items/c.md': '---\nkind: "thought"\n---\n',
		});
		expect(await inRun(context, () => items.misfits())).toEqual([
			'items/b.md: kind: "song" is not one of "thought", "link", "quote"',
			'items/c.md: added is missing',
		]);
	});
});

describe('outside a run', () => {
	test('a collection throws rather than touch any folder', () => {
		expect(items.list()).rejects.toThrow(
			"An app's collections, folder, and secrets are read only inside an action's run",
		);
	});
});

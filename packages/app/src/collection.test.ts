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
	path: 'data/items/{id}.md',
	fields: {
		kind: field.select(['thought', 'link', 'quote']),
		url: Type.Optional(Type.String({ format: 'uri' })),
		added: field.date(),
		done: field.boolean(),
		reviewed: field.date({ optional: true, readOnly: true }),
	},
});

const settings = defineCollection({
	path: 'data/settings.md',
	fields: {
		dailyGoal: field.integer({ optional: true }),
		voice: Type.Union([Type.Literal('female'), Type.Literal('male')], {
			default: 'female',
		}),
	},
});

const review = defineAction({
	description: 'Mark an item reviewed',
	input: { id: field.text() },
	run: ({ id }) => items.set({ id }, { reviewed: '2026-11-10' }),
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

describe('the verbs', () => {
	test('are six, each taking the keys flat and positional where it names one record', () => {
		expect(Object.keys(app.actions.items)).toEqual([
			'list',
			'get',
			'add',
			'set',
			'edit',
			'delete',
			'review',
		]);
		expect(Object.keys(app.actions.settings)).toEqual([
			'list',
			'get',
			'add',
			'set',
			'edit',
			'delete',
		]);
		for (const verb of ['get', 'add', 'set', 'edit', 'delete'] as const)
			expect(app.actions.items[verb].positional).toEqual(['id']);
		expect(Object.keys(app.actions.items.edit.input)).toEqual([
			'id',
			'old',
			'new',
		]);
		expect(app.actions.settings.get.input).toEqual({});
		expect(app.actions.items.list.annotations).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
		});
		expect(app.actions.items.list.description).toBe(
			'Every data/items/{id}.md file: its path and fields, and the problems of one that does not fit them',
		);
	});

	test('get refuses a record that is not there, naming its path', async () => {
		await expect(
			run('items get', { id: 'nope' }, createMemoryContext()),
		).rejects.toMatchObject({ name: 'Missing', path: 'data/items/nope.md' });
	});
});

describe('add', () => {
	test('makes a file as key: <JSON> lines in declared order, with defaults and a body', async () => {
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
		expect(await context.folder.read('data/items/dune.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-09"\ndone: false\n---\nFear is the mind-killer.\n',
		);
		expect(made).toEqual({
			path: 'data/items/dune.md',
			id: 'dune',
			kind: 'quote',
			added: '2026-11-09',
			done: false,
			body: 'Fear is the mind-killer.\n',
		});
	});

	test('refuses a file already there, and one without its required fields', async () => {
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\nKept.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		expect(
			run(
				'items add',
				{ id: 'a', kind: 'quote', added: '2026-11-02' },
				context,
			),
		).rejects.toThrow('data/items/a.md is already there');
		expect(
			run('items add', { id: 'b', kind: 'quote' }, context),
		).rejects.toThrow('data/items/b.md: added is missing');
		expect(await context.folder.list()).toEqual(['data/items/a.md']);
		expect(await context.folder.read('data/items/a.md')).toBe(text);
	});

	test('names a file by the time when its path holds {time}', async () => {
		const notes = defineCollection({
			path: 'data/notes/{year}/{time}.md',
			fields: { title: field.text() },
		});
		const { add } = notes.actions('add');
		const context = createMemoryContext();
		const made = await inRun(context, () => add({ year: '2026', title: 'A' }));
		expect(made.path).toMatch(
			/^data\/notes\/2026\/\d{4}-\d\d-\d\dT[\d-]+Z-[a-z0-9]{8}\.md$/,
		);
		// The record names itself, {time} included.
		expect(await inRun(context, () => notes.get(made))).toEqual(made);
		expect(
			inRun(context, () => add({ year: '../x', title: 'A' })),
		).rejects.toThrow('cannot name a file');
	});
});

describe('set', () => {
	test('changes only the lines it is given, keeping the rest byte for byte', async () => {
		const text =
			'---\nkind: "thought"\nadded:   "2026-11-01"\ndone: true\n---\n\nKeep me.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		await run(
			'items set',
			{ id: 'a', kind: 'link', url: 'https://example.com' },
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\n\nKeep me.\n',
		);
		await run(
			'items edit',
			{ id: 'a', old: '\nKeep me.\n', new: 'New.\n' },
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\nNew.\n',
		);
	});

	test('throws Missing for a file that is not there, given fields or a function', async () => {
		const context = createMemoryContext();
		await expect(
			run('items set', { id: 'nope', kind: 'link' }, context),
		).rejects.toMatchObject({ name: 'Missing', path: 'data/items/nope.md' });
		let called = false;
		await expect(
			inRun(context, () =>
				items.set({ id: 'nope' }, () => {
					called = true;
					return { kind: 'link' };
				}),
			),
		).rejects.toMatchObject({ name: 'Missing', path: 'data/items/nope.md' });
		expect(called).toBe(false);
		expect(await context.folder.list()).toEqual([]);
	});

	test('given a function, writes the fields it computes from the record, over that record only', async () => {
		const counters = defineCollection({
			path: 'data/counters/{id}.md',
			fields: { n: field.integer({ optional: true }) },
		});
		const context = createMemoryContext({
			'data/counters/a.md': '---\n---\nBody.\n',
		});
		const increment = () =>
			inRun(context, () =>
				counters.set({ id: 'a' }, (now) => ({ n: (now.n ?? 0) + 1 })),
			);
		await Promise.all([increment(), increment()]);
		expect(await context.folder.read('data/counters/a.md')).toBe(
			'---\nn: 2\n---\nBody.\n',
		);
		// What a function returns is the app's own: it is not refused as nothing to set.
		expect(
			await inRun(context, () => counters.set({ id: 'a' }, () => ({}))),
		).toMatchObject({ n: 2 });
	});

	test('removes a field given as null, and takes null only for one a file may go without', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: "link"\nurl: "https://example.com"\nadded: "2026-11-01"\n---\nKeep me.\n',
		});
		await run('items set', { id: 'a', url: null }, context);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "link"\nadded: "2026-11-01"\n---\nKeep me.\n',
		);
		expect(run('items set', { id: 'a', kind: null }, context)).rejects.toThrow(
			'kind is required, so it cannot be removed',
		);
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

	test('given nothing refuses, and writes nothing', async () => {
		const text = '---\nkind: "thought"\n---\nKeep me.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		expect(run('items set', { id: 'a' }, context)).rejects.toThrow(
			'Nothing to set in data/items/a.md: give a field',
		);
		expect(await context.folder.read('data/items/a.md')).toBe(text);
	});

	test("leaves a readOnly field out of the verbs, for the app's own action to write", async () => {
		expect(Object.keys(app.actions.items.set.input)).not.toContain('reviewed');
		expect(Object.keys(app.actions.items.add.input)).not.toContain('reviewed');
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		expect(
			run('items set', { id: 'a', reviewed: '2026-11-10' }, context),
		).rejects.toThrow("reviewed is written only by the app's own actions");
		await run('items review', { id: 'a' }, context);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "thought"\nadded: "2026-11-01"\nreviewed: "2026-11-10"\n---\n',
		);
	});

	test('rewrites YAML front matter as key: <JSON> lines, keeping the body and the keys no field declares', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: thought # a comment\nadded: 2026-11-01\ntags: [x, y]\n---\nBody\n',
		});
		expect(await run('items get', { id: 'a' }, context)).toEqual({
			path: 'data/items/a.md',
			id: 'a',
			kind: 'thought',
			added: '2026-11-01',
			done: false,
			body: 'Body\n',
		});
		await run('items set', { id: 'a', kind: 'quote' }, context);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-01"\ntags: ["x", "y"]\n---\nBody\n',
		);
	});

	test('adds front matter above a file that has none, which is all body', async () => {
		const context = createMemoryContext({ 'data/items/a.md': '# Just text\n' });
		expect(await run('items get', { id: 'a' }, context)).toEqual({
			path: 'data/items/a.md',
			id: 'a',
			done: false,
			body: '# Just text\n',
			problems: ['kind is missing', 'added is missing'],
		});
		await run('items set', { id: 'a', kind: 'thought' }, context);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "thought"\n---\n# Just text\n',
		);
	});
});

describe('edit', () => {
	test('replaces one quoted passage of the body, and refuses one it cannot find exactly once', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\n---\nWater the plant.\nWater the cat.\n',
		});
		const at = { id: 'a' };
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
		await expect(
			run('items edit', { id: 'nope', old: 'a', new: 'b' }, context),
		).rejects.toMatchObject({ name: 'Missing', path: 'data/items/nope.md' });
	});

	test('with an empty old fills an empty body, in YAML front matter too', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: thought\nadded: 2026-11-01\n---\n',
		});
		await run(
			'items edit',
			{ id: 'a', old: '', new: 'First words.\n' },
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: thought\nadded: 2026-11-01\n---\nFirst words.\n',
		);
	});
});

describe('front matter that cannot be read', () => {
	for (const [what, text] of [
		[
			'is neither grammar nor YAML',
			'---\nkind: [unclosed\n---\nWater the plant.\n',
		],
		[
			'opens with --- and never closes it',
			'---\nkind: "thought"\nWater the plant.\n',
		],
	] as const)
		test(`${what}: get and every writer refuse, list shows a problem row, delete works`, async () => {
			const context = createMemoryContext({ 'data/items/a.md': text });
			const refused = {
				name: 'Refused',
				message: `data/items/a.md cannot be read: its front matter is not key: <JSON> lines or YAML between two --- lines; fix it by hand first`,
			};
			const at = { id: 'a' };
			for (const attempt of [
				() => items.get(at),
				() => items.set(at, { kind: 'quote' }),
				() => items.set(at, () => ({ kind: 'quote' })),
				() => items.edit(at, { old: 'the plant', new: 'the cat' }),
				() => items.update(at, () => ({})),
			])
				await expect(inRun(context, attempt)).rejects.toMatchObject(refused);
			expect(
				inRun(context, () =>
					items.add({ id: 'a', kind: 'quote', added: '2026-11-01' }),
				),
			).rejects.toThrow('data/items/a.md is already there');
			expect(await context.folder.read('data/items/a.md')).toBe(text);
			expect(await inRun(context, () => items.list())).toEqual([
				{
					path: 'data/items/a.md',
					id: 'a',
					done: false,
					problems: [
						'its front matter is not key: <JSON> lines or YAML between two --- lines',
					],
				},
			]);
			expect(await inRun(context, () => items.delete(at))).toBe(true);
			expect(await context.folder.list()).toEqual([]);
		});
});

describe('list', () => {
	test('reads every file a template matches, with its path and keys, without bodies', async () => {
		const context = createMemoryContext({
			'data/items/b.md': '---\nkind: "link"\n---\nB\n',
			'data/items/a.md': 'no front matter\n',
			'data/items/.hidden.md': '---\nkind: "x"\n---\n',
			'data/items/nested/c.md': '---\nkind: "x"\n---\n',
			'data/items/notes.txt': 'not a match',
			'other/d.md': '---\nkind: "x"\n---\n',
		});
		expect(await run('items list', {}, context)).toEqual([
			{
				path: 'data/items/a.md',
				id: 'a',
				done: false,
				problems: ['kind is missing', 'added is missing'],
			},
			{
				path: 'data/items/b.md',
				id: 'b',
				kind: 'link',
				done: false,
				problems: ['added is missing'],
			},
		]);
	});

	test('lists a file named otherwise under its name on disk, saying so', async () => {
		const context = createMemoryContext({
			'data/items/Tokyo .md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		});
		const [row] = await inRun(context, () => items.list());
		expect(row).toEqual({
			path: 'data/items/Tokyo .md',
			id: 'Tokyo ',
			kind: 'link',
			added: '2026-11-01',
			done: false,
			problems: ['its name is not the one its key makes, data/items/Tokyo.md'],
		});
		// The key names the file it makes, which is not this one.
		expect(
			await inRun(context, () => items.get(row as { id: string })),
		).toBeUndefined();
	});

	test('never lists, gets, or adds a .local file, which stays on this computer', async () => {
		const context = createMemoryContext({
			'data/items/dune.md': '---\nkind: "link"\n---\n',
			'data/items/token.local.md': '---\nkind: "link"\n---\n',
			'data/items/Token.LOCAL.md': '---\nkind: "link"\n---\n',
		});
		const rows = await inRun(context, () => items.list());
		expect(rows.map((row) => row.path)).toEqual(['data/items/dune.md']);
		await expect(
			inRun(context, () => items.get({ id: 'token.local' })),
		).rejects.toThrow(
			'data/items/token.local.md would be a .local file, which stays on this computer; data/items/{id}.md names files that are committed',
		);
		await expect(
			run(
				'items add',
				{ id: 'token.local', kind: 'link', added: '2026-11-11', done: false },
				context,
			),
		).rejects.toThrow('would be a .local file');
		expect(await context.folder.list()).toEqual([
			'data/items/Token.LOCAL.md',
			'data/items/dune.md',
			'data/items/token.local.md',
		]);
	});
});

describe('delete', () => {
	test('answers whether a file was there', async () => {
		const context = createMemoryContext({ 'data/items/a.md': 'A\n' });
		expect(await run('items delete', { id: 'a' }, context)).toBe(true);
		expect(await run('items delete', { id: 'a' }, context)).toBe(false);
		expect(await context.folder.list()).toEqual([]);
	});
});

describe('a read', () => {
	test('takes path, keys, and body from the file, never from its front matter, and gives no other', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\npath: "data/items/b.md"\nid: "b"\nbody: "Fake."\nother: 1\n---\nReal.\n',
		});
		const record = {
			path: 'data/items/a.md',
			id: 'a',
			kind: 'thought' as const,
			added: '2026-11-01',
			done: false,
		};
		expect(await inRun(context, () => items.get({ id: 'a' }))).toEqual({
			...record,
			body: 'Real.\n',
		});
		expect(await inRun(context, () => items.list())).toEqual([record]);
	});

	test('leaves out a value that does not fit, or reads its default, and quotes it in problems', async () => {
		const text =
			'---\nkind: "song"\nadded: "next week"\ndone: "yes"\nreviewed: null\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		const problems = [
			'kind: "song" is not one of thought, link, quote',
			'added: "next week" is not a day like 2026-11-12',
			'done: "yes" is not true or false',
			'reviewed: null is not a day like 2026-11-12',
		];
		expect(await inRun(context, () => items.get({ id: 'a' }))).toEqual({
			path: 'data/items/a.md',
			id: 'a',
			done: false,
			body: '',
			problems,
		});
		expect(await inRun(context, () => items.list())).toEqual([
			{ path: 'data/items/a.md', id: 'a', done: false, problems },
		]);
		await inRun(context, () => items.set({ id: 'a' }, { kind: 'quote' }));
		expect(await context.folder.read('data/items/a.md')).toBe(
			text.replace('"song"', '"quote"'),
		);
	});
});

describe('update', () => {
	const counters = defineCollection({
		path: 'data/counters/{id}.md',
		fields: { n: field.integer({ optional: true }), note: field.text() },
	});
	const at = { id: 'a' };
	const seeded = () =>
		createMemoryContext({
			'data/counters/a.md': '---\nnote: "kept"\n---\nBody.\n',
		});

	test('writes the patch computed from the record, fields and body together, and returns the record written', async () => {
		const context = seeded();
		const written = await inRun(context, () =>
			counters.update(at, (record) => ({
				n: (record?.n ?? 0) + 1,
				body: `${record?.body ?? ''}More.\n`,
			})),
		);
		expect(written).toEqual({
			path: 'data/counters/a.md',
			id: 'a',
			n: 1,
			note: 'kept',
			body: 'Body.\nMore.\n',
		});
		expect(await context.folder.read('data/counters/a.md')).toBe(
			'---\nnote: "kept"\nn: 1\n---\nBody.\nMore.\n',
		);
		await inRun(context, () => counters.update(at, () => ({ n: null })));
		expect(await context.folder.read('data/counters/a.md')).toBe(
			'---\nnote: "kept"\n---\nBody.\nMore.\n',
		);
	});

	test('concurrent updates of one file both land, where a get then a set loses one', async () => {
		const context = seeded();
		const increment = () =>
			inRun(context, () =>
				counters.update(at, (record) => ({ n: (record?.n ?? 0) + 1 })),
			);
		await Promise.all([increment(), increment()]);
		expect((await inRun(context, () => counters.get(at)))?.n).toBe(2);

		const getThenSet = () =>
			inRun(context, async () => {
				const record = await counters.get(at);
				await counters.set(at, { n: (record?.n ?? 0) + 1 });
			});
		await Promise.all([getThenSet(), getThenSet()]);
		expect((await inRun(context, () => counters.get(at)))?.n).toBe(3);
	});

	test('a change that throws, gives what set refuses, or changes nothing writes nothing', async () => {
		const context = seeded();
		const before = await context.folder.read('data/counters/a.md');
		await expect(
			inRun(context, () =>
				counters.update(at, () => {
					throw new Error('not now');
				}),
			),
		).rejects.toThrow('not now');
		await expect(
			inRun(context, () =>
				counters.update(at, () => ({ note: null }) as never),
			),
		).rejects.toThrow('note is required, so it cannot be removed');
		expect(await context.folder.read('data/counters/a.md')).toBe(before);
		// A change of nothing leaves the file as it is and answers the record.
		const kept = await inRun(context, () => counters.update(at, () => ({})));
		const current = await inRun(context, () => counters.get(at));
		expect(kept).toEqual(current as typeof kept);
		expect(await context.folder.read('data/counters/a.md')).toBe(before);
		expect(await context.folder.list()).toEqual(['data/counters/a.md']);
	});

	test('gives undefined when there is no file, and what it returns makes one, as add would', async () => {
		const context = seeded();
		const seen: unknown[] = [];
		const made = await inRun(context, () =>
			counters.update({ id: 'b' }, (record) => {
				seen.push(record);
				return { n: 1, note: 'new', body: 'New.\n' };
			}),
		);
		expect(seen).toEqual([undefined]);
		expect(made).toEqual({
			path: 'data/counters/b.md',
			id: 'b',
			n: 1,
			note: 'new',
			body: 'New.\n',
		});
		await expect(
			inRun(context, () => counters.update({ id: 'c' }, () => ({}))),
		).rejects.toThrow('data/counters/c.md: note is missing');
		await expect(
			inRun(context, () =>
				counters.update({ id: 'c' }, () => {
					throw new Error('not here');
				}),
			),
		).rejects.toThrow('not here');
		expect(await context.folder.list()).toEqual([
			'data/counters/a.md',
			'data/counters/b.md',
		]);
	});

	test('is a method, not a verb', () => {
		expect(Object.keys(counters.actions())).not.toContain('update');
	});
});

describe('keys', () => {
	test('fill the template as add does, refusing a value that cannot name a file', () => {
		expect(items.pathOf({ id: 'dune' })).toBe('data/items/dune.md');
		for (const id of ['../x', 'a/b', 'a\\b', '.hidden', ''])
			expect(() => items.pathOf({ id })).toThrow('cannot name a file');
		expect(() => items.pathOf({} as never)).toThrow(
			'A data/items/{id}.md record is named by its id; give it',
		);
	});

	test('name one file however a value is typed: NFC, trimmed, single spaces', async () => {
		const decomposed = 'Gödel'; // ö as o and a combining mark
		expect(items.pathOf({ id: `  ${decomposed},\n Escher  ` })).toBe(
			'data/items/Gödel, Escher.md',
		);
		expect(() => items.pathOf({ id: 'x'.repeat(201) })).toThrow(
			'is too long to name a file',
		);
		const context = createMemoryContext({
			'data/items/Tokyo.md': '---\nkind: "link"\n---\n',
		});
		expect(
			(await inRun(context, () => items.get({ id: 'Tokyo ' })))?.path,
		).toBe('data/items/Tokyo.md');
	});

	test('are read only by their names, so a path is refused and a row passes as it is', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: "link"\n---\n',
		});
		await expect(
			inRun(context, () => items.get({ path: 'data/items/a.md' } as never)),
		).rejects.toThrow(
			'Name a data/items/{id}.md record by its id, not its path',
		);
		const [row] = await inRun(context, () => items.list());
		expect((await inRun(context, () => items.get(row as never)))?.path).toBe(
			'data/items/a.md',
		);
	});
});

describe('a readOnly field that is required and has no default', () => {
	test('leaves add out of the actions, and naming add throws', () => {
		const stamps = defineCollection({
			path: 'data/stamps/{id}.md',
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
			'data/stamps/{id}.md has no "add": at is written only by the app\'s own actions, required, and without a default, so an exposed add could never be given it; write the app\'s own add with defineAction',
		);
	});
});

describe('a collection with no placeholder', () => {
	test('reads as absent until add makes it, and set and edit refuse it until then', async () => {
		const context = createMemoryContext();
		expect(await inRun(context, () => settings.get())).toBeUndefined();
		expect(await run('settings list', {}, context)).toEqual([]);
		await expect(run('settings get', {}, context)).rejects.toMatchObject({
			name: 'Missing',
			path: 'data/settings.md',
		});
		await expect(
			run('settings set', { dailyGoal: 20 }, context),
		).rejects.toMatchObject({ name: 'Missing', path: 'data/settings.md' });
		await expect(
			run('settings edit', { old: '', new: 'x' }, context),
		).rejects.toMatchObject({ name: 'Missing', path: 'data/settings.md' });
		expect(await context.folder.list()).toEqual([]);

		await run('settings add', { dailyGoal: 20 }, context);
		expect(await context.folder.read('data/settings.md')).toBe(
			'---\ndailyGoal: 20\nvoice: "female"\n---\n',
		);
		expect(run('settings set', { voice: 'robot' }, context)).rejects.toThrow(
			'data/settings.md: voice: "robot" is not one of female, male',
		);
		await run('settings set', { dailyGoal: null }, context);
		await run('settings edit', { old: '', new: 'Notes.\n' }, context);
		expect(await run('settings get', {}, context)).toEqual({
			path: 'data/settings.md',
			voice: 'female',
			body: 'Notes.\n',
		});
		expect(await run('settings delete', {}, context)).toBe(true);
		expect(await inRun(context, () => settings.get())).toBeUndefined();
	});

	test('update gives undefined while there is no file, and makes it', async () => {
		const context = createMemoryContext();
		const written = await inRun(context, () =>
			settings.update((file) => ({
				dailyGoal: (file?.dailyGoal ?? 10) + 5,
				body: `${file?.voice ?? 'none'}\n`,
			})),
		);
		expect(written).toEqual({
			path: 'data/settings.md',
			dailyGoal: 15,
			voice: 'female',
			body: 'none\n',
		});
		expect(settings.pathOf()).toBe('data/settings.md');
	});

	test('its methods take no keys', async () => {
		await expect(
			inRun(createMemoryContext(), () =>
				(settings.get as (keys: object) => Promise<unknown>)({
					path: 'data/settings.md',
				}),
			),
		).rejects.toThrow('data/settings.md has no key, so name none');
	});
});

describe('a .local collection', () => {
	const google = defineCollection({
		path: 'data/google.local.md',
		fields: { refreshToken: field.text({ optional: true }) },
	});

	test('reads and writes through its methods', async () => {
		const context = createMemoryContext();
		await inRun(context, () => google.add({ refreshToken: 'abc' }));
		expect(await inRun(context, () => google.get())).toEqual({
			path: 'data/google.local.md',
			refreshToken: 'abc',
			body: '',
		});
	});

	test('offers no actions, so no generated verb hands out its values', () => {
		expect(() => google.actions()).toThrow(
			'data/google.local.md never leaves this computer, so it offers no actions',
		);
		expect(() => google.actions('get')).toThrow('never leaves this computer');
	});

	test('names a field that does not fit without quoting its value', async () => {
		const context = createMemoryContext({
			'data/google.local.md': '---\nrefreshToken: 12345\n---\n',
		});
		const read = await inRun(context, () => google.get());
		expect(read?.problems).toEqual(['refreshToken is not text']);
		const refused = inRun(context, () =>
			google.set({ refreshToken: 67890 as unknown as string }),
		);
		await expect(refused).rejects.toThrow(
			'data/google.local.md: refreshToken is not text',
		);
		await expect(refused).rejects.not.toThrow('67890');
	});
});

describe('check', () => {
	test('gives each problem line with its kind, the line without its value', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: "song"\nadded: "next week"\n---\n',
			'data/items/b.md': '---\nkind: "thought"\nadded: "soon"\n---\n',
			'data/items/c.md': '---\nkind: "thought"\n---\n',
			'data/items/d.md': '---\nkind: [unclosed\n---\n',
			'data/items/e.md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
			'data/items/f .md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
			'data/items/g.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\nsecret: "s3cr3t"\n---\n',
		});
		const added = {
			line: 'added: "soon" is not a day like 2026-11-12',
			kind: 'added is not a day like 2026-11-12',
		};
		const unreadable =
			'its front matter is not key: <JSON> lines or YAML between two --- lines';
		expect(await inRun(context, () => items.check())).toEqual({
			files: 7,
			records: [
				{
					path: 'data/items/a.md',
					problems: [
						{
							line: 'kind: "song" is not one of thought, link, quote',
							kind: 'kind is not one of thought, link, quote',
						},
						{ ...added, line: added.line.replace('soon', 'next week') },
					],
				},
				{ path: 'data/items/b.md', problems: [added] },
				{
					path: 'data/items/c.md',
					problems: [{ line: 'added is missing', kind: 'added is missing' }],
				},
				{
					path: 'data/items/d.md',
					problems: [{ line: unreadable, kind: unreadable }],
				},
				{
					path: 'data/items/f .md',
					problems: [
						{
							line: 'its name is not the one its key makes, data/items/f.md',
							kind: 'its name is not the one its key makes',
						},
					],
				},
				// g.md fits: front matter no field declares is kept, not reported.
			],
		});
		// The rows of the same files keep problems as lines.
		const rows = await inRun(context, () => items.list());
		expect(
			rows.find((row) => row.path === 'data/items/b.md')?.problems,
		).toEqual([added.line]);
		expect(
			rows.find((row) => row.path === 'data/items/g.md')?.problems,
		).toBeUndefined();
	});

	test('of a collection with no placeholder counts no file while it is absent', async () => {
		expect(await inRun(createMemoryContext(), () => settings.check())).toEqual({
			files: 0,
			records: [],
		});
		const context = createMemoryContext({
			'data/settings.md': '---\nvoice: "robot"\n---\n',
		});
		expect(await inRun(context, () => settings.check())).toEqual({
			files: 1,
			records: [
				{
					path: 'data/settings.md',
					problems: [
						{
							line: 'voice: "robot" is not one of female, male',
							kind: 'voice is not one of female, male',
						},
					],
				},
			],
		});
	});
});

describe('outside a run', () => {
	test('a collection throws rather than touch any folder', () => {
		expect(items.list()).rejects.toThrow(
			"An app's collections and folder are read only inside an action's run",
		);
	});
});

for (const schema of [
	field.file(),
	field.file({ optional: true }),
	Type.Array(field.file()),
	Type.Object({ a: field.file() }),
	Type.Union([Type.String(), field.file()]),
	Type.String({ 'x-epicenter-file': {}, readOnly: true }),
]) {
	test(`definition refuses a file marker in ${JSON.stringify(schema)}`, () => {
		expect(() =>
			defineCollection({
				path: 'data/files/{slug}.md',
				fields: { attachment: schema },
			}),
		).toThrow('has the file field "attachment"');
	});
}

test('ordinary text and lists still define a collection', () => {
	expect(() =>
		defineCollection({
			path: 'data/text/{slug}.md',
			fields: { title: field.text(), tags: field.list(field.text()) },
		}),
	).not.toThrow();
});

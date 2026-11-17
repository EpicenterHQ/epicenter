/** Collections return fitting records or explicit failures, preserving files on refused writes. */
import { describe, expect, test } from 'bun:test';
import { Ok, partitionResults, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { ActionError } from './errors.ts';

type ActionErrorResult = Result<unknown, ActionError>;
const UNREADABLE =
	'its front matter is not key: value lines between two --- lines, each key once';

import { Type } from 'typebox';
import { defineErrors } from 'wellcrafted/error';
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
		voice: Type.Optional(
			Type.Union([Type.Literal('female'), Type.Literal('male')]),
		),
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
		items: { ...items.actions(), ...items.actions('delete'), review },
		settings: { ...settings.actions(), ...settings.actions('delete') },
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
	test('are four unless delete is named, each taking the keys flat where it names one record', () => {
		expect(Object.keys(items.actions())).toEqual(['list', 'get', 'add', 'set']);
		expect(Object.keys(items.actions('delete'))).toEqual(['delete']);
		expect(Object.keys(app.actions.items)).toEqual([
			'list',
			'get',
			'add',
			'set',
			'delete',
			'review',
		]);
		expect(Object.keys(app.actions.settings)).toEqual([
			'list',
			'get',
			'set',
			'delete',
		]);
		for (const verb of ['get', 'add', 'set', 'delete'] as const)
			expect(Object.keys(app.actions.items[verb].input)).toContain('id');
		// The set verb takes fields, what the caller last saw, and a passage; never the whole body.
		expect(Object.keys(app.actions.items.set.input)).toEqual([
			'id',
			'kind',
			'url',
			'added',
			'done',
			'was',
			'edit',
		]);
		expect(app.actions.settings.get.input).toEqual({});
		expect(app.actions.items.list.annotations).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
		});
		expect(app.actions.items.list.description).toBe(
			'Every data/items/{id}.md file: one result per file with its path and fields; a file that does not fit its fields is an error beside the rows',
		);
	});

	test('get refuses a record that is not there, naming its path', async () => {
		await expect(
			run('items get', { id: 'nope' }, createMemoryContext()),
		).resolves.toMatchObject({
			error: { name: 'Missing', path: 'data/items/nope.md' },
		});
	});

	test('list gives rows without bodies, where the method gives whole records', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: "link"\nadded: "2026-11-01"\n---\nA\n',
		});
		const row = {
			path: 'data/items/a.md',
			id: 'a',
			kind: 'link' as const,
			added: '2026-11-01',
			done: false,
		};
		expect(await run('items list', {}, context)).toEqual(Ok([Ok(row)]));
		expect<unknown>(await inRun(context, () => items.list())).toEqual([
			Ok({ ...row, body: 'A\n' }),
		]);
	});
});

describe('add', () => {
	test('makes a file as key: <JSON> lines in declared order, with only what it was given and a body', async () => {
		const context = createMemoryContext();
		const made = await run(
			'items add',
			{
				id: 'dune',
				added: '2026-11-09',
				kind: 'quote' as const,
				body: 'Fear is the mind-killer.\n',
			},
			context,
		);
		expect(await context.folder.read('data/items/dune.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-09"\n---\nFear is the mind-killer.\n',
		);
		expect(made).toEqual(
			Ok({
				path: 'data/items/dune.md',
				id: 'dune',
				kind: 'quote' as const,
				added: '2026-11-09',
				done: false,
				body: 'Fear is the mind-killer.\n',
			}),
		);
	});

	test('refuses a file already there, and one without its required fields', async () => {
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\nKept.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		expect(
			run(
				'items add',
				{ id: 'a', kind: 'quote' as const, added: '2026-11-02' },
				context,
			),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining('data/items/a.md is already there'),
			},
		});
		expect(
			run('items add', { id: 'b', kind: 'quote' as const }, context),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining('data/items/b.md: added is missing'),
			},
		});
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
		expect(made.data?.path).toMatch(
			/^data\/notes\/2026\/\d{4}-\d\d-\d\dT[\d-]+Z-[a-z0-9]{8}\.md$/,
		);
		// The record names itself, {time} included.
		expect<ActionErrorResult>(
			await inRun(context, () => notes.get(expectOk(made))),
		).toEqual(made);
		expect(
			inRun(context, () => add({ year: '../x', title: 'A' })),
		).resolves.toMatchObject({
			error: { message: expect.stringContaining('cannot name a file') },
		});
	});
});

describe('set', () => {
	test('changes only the lines it is given, keeping the rest byte for byte', async () => {
		const text =
			'---\nkind: "thought"\nadded:   "2026-11-01"\ndone: true\n---\n\nKeep me.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		await run(
			'items set',
			{ id: 'a', kind: 'link' as const, url: 'https://example.com' },
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\n\nKeep me.\n',
		);
		await run(
			'items set',
			{ id: 'a', edit: { old: '\nKeep me.\n', new: 'New.\n' } },
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\nNew.\n',
		);
	});

	test('returns Missing for a file that is not there, given fields or a function', async () => {
		const context = createMemoryContext();
		await expect(
			run('items set', { id: 'nope', kind: 'link' as const }, context),
		).resolves.toMatchObject({
			error: { name: 'Missing', path: 'data/items/nope.md' },
		});
		let called = false;
		await expect(
			inRun(context, () =>
				items.set({ id: 'nope' }, () => {
					called = true;
					return Ok({ kind: 'link' as const });
				}),
			),
		).resolves.toMatchObject({
			error: { name: 'Missing', path: 'data/items/nope.md' },
		});
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
				counters.set({ id: 'a' }, (now) => Ok({ n: (now.n ?? 0) + 1 })),
			);
		await Promise.all([increment(), increment()]);
		expect(await context.folder.read('data/counters/a.md')).toBe(
			'---\nn: 2\n---\nBody.\n',
		);
		// What a function returns is the app's own: it is not refused as nothing to set.
		expect(
			await inRun(context, () => counters.set({ id: 'a' }, () => Ok({}))),
		).toMatchObject({ data: { n: 2 } });
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
		expect(
			run('items set', { id: 'a', kind: null }, context),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining(
					'kind is required, so it cannot be removed',
				),
			},
		});
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
		expect(run('items set', { id: 'a' }, context)).resolves.toMatchObject({
			error: {
				message: expect.stringContaining(
					'Nothing to set in data/items/a.md: give a field',
				),
			},
		});
		expect(await context.folder.read('data/items/a.md')).toBe(text);
	});

	test("leaves a readOnly field out of the verbs, for the app's own action to write", async () => {
		expect(Object.keys(app.actions.items.set.input)).not.toContain('reviewed');
		expect(Object.keys(app.actions.items.add.input)).not.toContain('reviewed');
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		expect(
			run('items set', { id: 'a', reviewed: '2026-11-10' }, context),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining(
					"reviewed is written only by the app's own actions",
				),
			},
		});
		await run('items review', { id: 'a' }, context);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "thought"\nadded: "2026-11-01"\nreviewed: "2026-11-10"\n---\n',
		);
	});

	test('adds front matter above a file that has none, which is all body', async () => {
		const context = createMemoryContext({ 'data/items/a.md': '# Just text\n' });
		expect<unknown>(
			await inRun(context, () => items.get({ id: 'a' })),
		).toMatchObject({
			error: { name: 'Misfit', record: { body: '# Just text\n' } },
		});
		expect<unknown>(
			await inRun(context, () => items.set({ id: 'a' }, { kind: 'thought' })),
		).toMatchObject({ error: { name: 'Misfit' } });
		expect(await context.folder.read('data/items/a.md')).toBe('# Just text\n');
		expectOk(
			await inRun(context, () =>
				items.set({ id: 'a' }, { kind: 'thought', added: '2026-11-01' }),
			),
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "thought"\nadded: "2026-11-01"\n---\n# Just text\n',
		);
	});

	test('carries the body in code, as data or from a function', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\n---\nOne.\n',
		});
		await inRun(context, () => items.set({ id: 'a' }, { body: 'Two.\n' }));
		await inRun(context, () =>
			items.set({ id: 'a' }, (now) =>
				Ok({
					kind: 'quote' as const,
					body: `${now.body}Three.\n`,
				}),
			),
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-01"\n---\nTwo.\nThree.\n',
		);
	});

	test('a computed change may not write over a value that does not fit, and plain data repairs it', async () => {
		const text = '---\nkind: "song"\nadded: "2026-11-01"\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		let called = false;
		for (const attempt of [
			() =>
				items.set({ id: 'a' }, () => {
					called = true;
					return Ok({ kind: 'quote' as const });
				}),
			() =>
				items.update({ id: 'a' }, () => {
					called = true;
					return Ok({ done: true });
				}),
		])
			expect<unknown>(await inRun(context, attempt)).toMatchObject({
				error: { name: 'Misfit' },
			});
		expect(called).toBe(false);
		expect(await context.folder.read('data/items/a.md')).toBe(text);
		expectOk(
			await inRun(context, () => items.set({ id: 'a' }, { kind: 'quote' })),
		);
	});

	test('the verb refuses with Changed when a value named in was has changed, null meaning absent', async () => {
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		await expect(
			run(
				'items set',
				{ id: 'a', kind: 'link' as const, was: { kind: 'quote' as const } },
				context,
			),
		).resolves.toMatchObject({ error: { name: 'Changed', why: 'was' } });
		await expect(
			run(
				'items set',
				{ id: 'a', kind: 'link' as const, was: { url: 'x' } },
				context,
			),
		).resolves.toMatchObject({ error: { name: 'Changed', why: 'was' } });
		expect(await context.folder.read('data/items/a.md')).toBe(text);
		// Another caller's change to a field it does not name lands beside it.
		await run(
			'items set',
			{ id: 'a', kind: 'link' as const, was: { kind: 'thought', url: null } },
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		);
	});
});

describe('set with a passage', () => {
	test('there is no edit verb: actions names set instead', () => {
		expect('edit' in items).toBe(false);
		expect(() => items.actions('edit' as never)).toThrow(
			'data/items/{id}.md has no "edit": set takes edit: { old, new } now',
		);
	});

	test('replaces one quoted passage of the body, and refuses with Changed one it cannot find exactly once', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\n---\nWater the plant.\nWater the cat.\n',
		});
		const at = { id: 'a' };
		expect(
			await run(
				'items set',
				{ ...at, edit: { old: 'the plant', new: 'both plants' } },
				context,
			),
		).toMatchObject({
			data: {
				kind: 'thought',
				body: 'Water both plants.\nWater the cat.\n',
			},
		});
		expect(
			run(
				'items set',
				{ ...at, edit: { old: 'the plant', new: 'x' } },
				context,
			),
		).resolves.toMatchObject({
			error: {
				name: 'Changed',
				why: 'quote',
				message: expect.stringContaining('does not have that text'),
			},
		});
		expect(
			run('items set', { ...at, edit: { old: 'Water', new: 'Feed' } }, context),
		).resolves.toMatchObject({
			error: {
				name: 'Changed',
				why: 'twice',
				message: expect.stringContaining('more than once'),
			},
		});
		expect(
			run('items set', { ...at, edit: { old: '', new: 'x' } }, context),
		).resolves.toMatchObject({ error: { name: 'Changed', why: 'empty' } });
		await expect(
			run('items set', { id: 'nope', edit: { old: 'a', new: 'b' } }, context),
		).resolves.toMatchObject({
			error: { name: 'Missing', path: 'data/items/nope.md' },
		});
		// The whole body may be the quote, which replaces it all.
		expect(
			await run(
				'items set',
				{
					...at,
					edit: { old: 'Water both plants.\nWater the cat.\n', new: 'Rest.\n' },
				},
				context,
			),
		).toMatchObject({ data: { body: 'Rest.\n' } });
	});

	test('with an empty old fills an empty body, keeping lines that are not JSON', async () => {
		const text = '---\nkind: thought\nadded: 2026-11-01\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		expect(
			await run(
				'items set',
				{ id: 'a', edit: { old: '', new: 'First words.\n' } },
				context,
			),
		).toMatchObject({ error: { name: 'Misfit' } });
		expect(await context.folder.read('data/items/a.md')).toBe(text);
		expect(
			await run(
				'items set',
				{
					id: 'a',
					kind: 'thought',
					added: '2026-11-01',
					edit: { old: '', new: 'First words.\n' },
				},
				context,
			),
		).toMatchObject({ data: { body: 'First words.\n' } });
	});

	test('writes the fields and the passage in one write, returning the body', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\n---\nWater the plant.\n',
		});
		expect(
			await run(
				'items set',
				{
					id: 'a',
					kind: 'quote' as const,
					was: { kind: 'thought' },
					edit: { old: 'the plant', new: 'the cat' },
				},
				context,
			),
		).toEqual(
			Ok({
				path: 'data/items/a.md',
				id: 'a',
				kind: 'quote' as const,
				added: '2026-11-01',
				done: false,
				body: 'Water the cat.\n',
			}),
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-01"\n---\nWater the cat.\n',
		);
	});

	test('writes nothing when was or the passage does not hold, and says which', async () => {
		const text =
			'---\nkind: "thought"\nadded: "2026-11-01"\n---\nWater the plant.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		await expect(
			run(
				'items set',
				{
					id: 'a',
					kind: 'quote' as const,
					was: { kind: 'link' as const },
					edit: { old: 'the plant', new: 'the cat' },
				},
				context,
			),
		).resolves.toMatchObject({ error: { name: 'Changed', why: 'was' } });
		await expect(
			run(
				'items set',
				{
					id: 'a',
					kind: 'quote' as const,
					was: { kind: 'thought' },
					edit: { old: 'the dog', new: 'the cat' },
				},
				context,
			),
		).resolves.toMatchObject({ error: { name: 'Changed', why: 'quote' } });
		expect(await context.folder.read('data/items/a.md')).toBe(text);
	});

	test('refuses an edit without both old and new, as text', async () => {
		const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\nBody.\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		for (const edit of [
			{ old: 'Body.\n' },
			{ new: 'Text.\n' },
			{ old: 1, new: 'x' },
		])
			await expect(
				run('items set', { id: 'a', kind: 'quote' as const, edit }, context),
			).resolves.toMatchObject({
				error: {
					message: expect.stringContaining(
						'Edit the body of data/items/{id}.md with edit: { old, new }, each text',
					),
				},
			});
		expect(await context.folder.read('data/items/a.md')).toBe(text);
	});

	test('a collection whose fields are all read-only still sets its body', async () => {
		const stamped = defineCollection({
			path: 'data/stamped/{id}.md',
			fields: { at: field.date({ optional: true, readOnly: true }) },
		});
		const { set } = stamped.actions();
		expect(Object.keys(set.input)).toEqual(['id', 'was', 'edit']);
		const context = createMemoryContext({
			'data/stamped/a.md': '---\nat: "2026-11-01"\n---\nDraft.\n',
		});
		await inRun(context, () =>
			set({
				id: 'a',
				was: { at: '2026-11-01' },
				edit: { old: 'Draft.\n', new: 'Done.\n' },
			}),
		);
		expect(await context.folder.read('data/stamped/a.md')).toBe(
			'---\nat: "2026-11-01"\n---\nDone.\n',
		);
	});
});

describe('front matter read line by line', () => {
	test('a line that is not JSON reads as absent with a problem, and the other keys read and write', async () => {
		const text =
			'---\nkind: "thought"\nadded: 2026-11-01\nkept: by hand # a note\n---\nBody\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		const read = await inRun(context, () => items.get({ id: 'a' }));
		expect<ActionErrorResult>(read).toEqual(
			ActionError.Misfit({
				path: 'data/items/a.md',
				problems: [
					{
						line: 'added on line 3 is not JSON; write added: "2026-11-01"',
						kind: 'added is not JSON; write its text in double quotes',
					},
				],
				record: {
					path: 'data/items/a.md',
					id: 'a',
					kind: 'thought',
					done: false,
					body: 'Body\n',
				},
			}),
		);
		expect<unknown>(
			await inRun(context, () => items.set({ id: 'a' }, { kind: 'quote' })),
		).toEqual(read);
		expect(await context.folder.read('data/items/a.md')).toBe(text);
		expectOk(
			await inRun(context, () =>
				items.set({ id: 'a' }, { kind: 'quote', added: '2026-11-01' }),
			),
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-01"\nkept: by hand # a note\n---\nBody\n',
		);
	});

	test('a computed change may not write that key, and plain data repairs it', async () => {
		const text = '---\nkind: "thought"\nadded: 2026-11-01\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		for (const write of [
			() => items.set({ id: 'a' }, () => Ok({ added: '2026-11-02' })),
			() => items.update({ id: 'a' }, () => Ok({ added: '2026-11-02' })),
		])
			await expect(inRun(context, write)).resolves.toMatchObject({
				error: {
					name: 'Misfit',
					message: expect.stringContaining('data/items/a.md: added'),
				},
			});
		expect(await context.folder.read('data/items/a.md')).toBe(text);
		await inRun(context, () => items.set({ id: 'a' }, { added: '2026-11-01' }));
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
		);
		expect(
			(await inRun(context, () => items.check())).records[0]?.problems.map(
				({ line }) => line,
			),
		).toBeUndefined();
	});

	test('a write to another key leaves each line it does not name byte for byte', async () => {
		const lines =
			'serial: 12345678901234567890\nversion: 1.10\nzip: 01234\nlarge: 1e400\n';
		const context = createMemoryContext({
			'data/items/a.md': `---\nkind: "thought"\nadded: "2026-11-01"\n${lines}---\n`,
		});
		await run('items set', { id: 'a', kind: 'quote' as const }, context);
		expect(await context.folder.read('data/items/a.md')).toBe(
			`---\nkind: "quote"\nadded: "2026-11-01"\n${lines}---\n`,
		);
	});

	test('a key with nothing after it, or only spaces, has no value', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: "thought"\nadded:\nurl:   \n---\n',
		});
		expect(
			(await inRun(context, () => items.check())).records[0]?.problems.map(
				({ line }) => line,
			),
		).toEqual([
			'url on line 4 is not JSON: it has no value; give it one as JSON, or remove the line',
			'added on line 3 is not JSON: it has no value; give it one as JSON, or remove the line',
		]);
	});

	test('a value that is not JSON says what the field takes when quoting would not fit', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\nkind: thought\nadded: "2026-11-01"\ndone: yes\n---\n',
		});
		expect(
			(await inRun(context, () => items.check())).records[0]?.problems.map(
				({ line }) => line,
			),
		).toEqual([
			'kind on line 2 is not JSON; write kind: "thought"',
			'done on line 4 is not JSON; done takes true or false, written as JSON',
		]);
	});

	test('keeps CRLF line endings, on a changed line and a new one', async () => {
		const context = createMemoryContext({
			'data/items/a.md':
				'---\r\nkind: "thought"\r\nadded: 2026-11-01\r\n---\r\nBody\r\n',
		});
		await run(
			'items set',
			{
				id: 'a',
				kind: 'quote' as const,
				added: '2026-11-01',
				url: 'https://example.com',
			},
			context,
		);
		expect(await context.folder.read('data/items/a.md')).toBe(
			'---\r\nkind: "quote"\r\nadded: "2026-11-01"\r\nurl: "https://example.com"\r\n---\r\nBody\r\n',
		);
	});
});

describe('front matter that cannot be read', () => {
	for (const [what, text] of [
		[
			'has a line that is not key: value',
			'---\nkind: "thought"\n# a comment\n---\nWater the plant.\n',
		],
		[
			'names a key twice',
			'---\nkind: "thought"\nkind: "quote"\n---\nWater the plant.\n',
		],
		[
			'opens with --- and never closes it',
			'---\nkind: "thought"\nWater the plant.\n',
		],
	] as const)
		test(`${what}: get and every writer refuse, list shows a problem row, delete works`, async () => {
			const context = createMemoryContext({ 'data/items/a.md': text });
			const refused = {
				name: 'Misfit',
				message: `data/items/a.md does not fit its fields:\ndata/items/a.md: its front matter is not key: value lines between two --- lines, each key once`,
			};
			const at = { id: 'a' };
			for (const attempt of [
				() => items.get(at),
				() => items.set(at, { kind: 'quote' as const }),
				() => items.set(at, () => Ok({ kind: 'quote' as const })),
				() => items.update(at, () => Ok({})),
			])
				await expect(
					inRun(context, async () => await attempt()),
				).resolves.toMatchObject({ error: refused });
			await expect(
				run(
					'items set',
					{ ...at, edit: { old: 'the plant', new: 'the cat' } },
					context,
				),
			).resolves.toMatchObject({ error: refused });
			expect(
				inRun(context, () =>
					items.add({ id: 'a', kind: 'quote' as const, added: '2026-11-01' }),
				),
			).resolves.toMatchObject({
				error: {
					message: expect.stringContaining('data/items/a.md is already there'),
				},
			});
			expect(await context.folder.read('data/items/a.md')).toBe(text);
			expect<unknown>(await inRun(context, () => items.list())).toEqual([
				ActionError.Misfit({
					path: 'data/items/a.md',
					problems: [{ line: UNREADABLE, kind: UNREADABLE }],
				}),
			]);
			expect(
				Object.hasOwn(
					expectErr(await inRun(context, () => items.get(at))),
					'record',
				),
			).toBe(false);
			expect<unknown>(await inRun(context, () => items.delete(at))).toBe(true);
			expect(await context.folder.list()).toEqual([]);
		});
});

describe('list', () => {
	test('reads every file a template matches, with its path and keys, without bodies', async () => {
		const context = createMemoryContext({
			'data/items/b.md': '---\nkind: "link"\nadded: "2026-11-01"\n---\nB\n',
			'data/items/a.md': 'no front matter\n',
			'data/items/.hidden.md': '---\nkind: "x"\n---\n',
			'data/items/nested/c.md': '---\nkind: "x"\n---\n',
			'data/items/notes.txt': 'not a match',
			'other/d.md': '---\nkind: "x"\n---\n',
		});
		const rows = await run('items list', {}, context);
		expect(rows).toMatchObject({
			data: [
				{
					error: {
						name: 'Misfit',
						path: 'data/items/a.md',
						record: { id: 'a', done: false },
					},
				},
				{
					data: { path: 'data/items/b.md', id: 'b', kind: 'link' },
					error: null,
				},
			],
		});
		expect(JSON.stringify(rows)).not.toContain('body');
	});

	test('lists a file named otherwise under its name on disk, and its row reaches it', async () => {
		const context = createMemoryContext({
			'data/items/Tokyo .md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		});
		const [row] = await inRun(context, () => items.list());
		if (!row) throw new Error('Expected one row');
		expect(row).toEqual(
			Ok({
				path: 'data/items/Tokyo .md',
				id: 'Tokyo ',
				kind: 'link' as const,
				added: '2026-11-01',
				done: false,
				body: '',
			}),
		);
		expect(
			(await inRun(context, () => items.get(expectOk(row) as { id: string })))
				.data?.path,
		).toBe('data/items/Tokyo .md');
		expect(
			await inRun(context, () => items.delete(expectOk(row) as { id: string })),
		).toBe(true);
		expect(await context.folder.list()).toEqual([]);
	});

	test('never lists, gets, or adds a .local file, which stays on this computer', async () => {
		const context = createMemoryContext({
			'data/items/dune.md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
			'data/items/token.local.md':
				'---\nkind: "link"\nadded: "2026-11-01"\n---\n',
			'data/items/Token.LOCAL.md':
				'---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		});
		const rows = await inRun(context, () => items.list());
		expect(rows.map((row) => row.error?.path ?? row.data?.path)).toEqual([
			'data/items/dune.md',
		]);
		await expect(
			inRun(context, () => items.get({ id: 'token.local' })),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining(
					'data/items/token.local.md would be a .local file, which stays on this computer; data/items/{id}.md names files that are committed',
				),
			},
		});
		await expect(
			run(
				'items add',
				{
					id: 'token.local',
					kind: 'link' as const,
					added: '2026-11-11',
					done: false,
				},
				context,
			),
		).resolves.toMatchObject({
			error: { message: expect.stringContaining('would be a .local file') },
		});
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
		expect(await run('items delete', { id: 'a' }, context)).toEqual(Ok(true));
		expect(await run('items delete', { id: 'a' }, context)).toEqual(Ok(false));
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
		expect<unknown>(await inRun(context, () => items.get({ id: 'a' }))).toEqual(
			Ok({
				...record,
				body: 'Real.\n',
			}),
		);
		expect(await run('items list', {}, context)).toEqual(Ok([Ok(record)]));
	});

	test('leaves out a value that does not fit, a switch included, and quotes it in problems', async () => {
		const text =
			'---\nkind: "song"\nadded: "next week"\ndone: "yes"\nreviewed: null\n---\n';
		const context = createMemoryContext({ 'data/items/a.md': text });
		const read = await inRun(context, () => items.get({ id: 'a' }));
		expect<unknown>(read).toEqual(
			ActionError.Misfit({
				path: 'data/items/a.md',
				problems: [
					{
						line: 'kind: "song" is not one of thought, link, quote',
						kind: 'kind is not one of thought, link, quote',
					},
					{
						line: 'added: "next week" is not a day like 2026-11-12',
						kind: 'added is not a day like 2026-11-12',
					},
					{
						line: 'done: "yes" is not true or false',
						kind: 'done is not true or false',
					},
					{
						line: 'reviewed: null is not a day like 2026-11-12',
						kind: 'reviewed is not a day like 2026-11-12',
					},
				],
				record: { path: 'data/items/a.md', id: 'a', body: '' },
			}),
		);
		expect<unknown>(
			await inRun(context, () => items.set({ id: 'a' }, { kind: 'quote' })),
		).toEqual(read);
		expect(await context.folder.read('data/items/a.md')).toBe(text);
		expectOk(
			await inRun(context, () =>
				items.set(
					{ id: 'a' },
					{ kind: 'quote', added: '2026-11-01', done: true, reviewed: null },
				),
			),
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
			counters.update(at, (record) =>
				Ok({
					n: (record?.n ?? 0) + 1,
					body: `${record?.body ?? ''}More.\n`,
				}),
			),
		);
		expect(written).toEqual(
			Ok({
				path: 'data/counters/a.md',
				id: 'a',
				n: 1,
				note: 'kept',
				body: 'Body.\nMore.\n',
			}),
		);
		expect(await context.folder.read('data/counters/a.md')).toBe(
			'---\nnote: "kept"\nn: 1\n---\nBody.\nMore.\n',
		);
		await inRun(context, () => counters.update(at, () => Ok({ n: null })));
		expect(await context.folder.read('data/counters/a.md')).toBe(
			'---\nnote: "kept"\n---\nBody.\nMore.\n',
		);
	});

	test('concurrent updates of one file both land, where a get then a set loses one', async () => {
		const context = seeded();
		const increment = () =>
			inRun(context, () =>
				counters.update(at, (record) => Ok({ n: (record?.n ?? 0) + 1 })),
			);
		await Promise.all([increment(), increment()]);
		expect((await inRun(context, () => counters.get(at))).data?.n).toBe(2);

		const getThenSet = () =>
			inRun(context, async () => {
				const record = expectOk(await counters.get(at));
				await counters.set(at, { n: (record?.n ?? 0) + 1 });
			});
		await Promise.all([getThenSet(), getThenSet()]);
		expect((await inRun(context, () => counters.get(at))).data?.n).toBe(3);
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
				counters.update(at, () => Ok({ note: null } as never)),
			),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining(
					'note is required, so it cannot be removed',
				),
			},
		});
		expect(await context.folder.read('data/counters/a.md')).toBe(before);
		// A change of nothing leaves the file as it is and answers the record.
		const kept = await inRun(context, () => counters.update(at, () => Ok({})));
		const current = await inRun(context, () => counters.get(at));
		expect<unknown>(kept).toEqual(current);
		expect(await context.folder.read('data/counters/a.md')).toBe(before);
		expect(await context.folder.list()).toEqual(['data/counters/a.md']);
	});

	test('null for a field a file may go without leaves it out of a file it makes, as it removes it from one that is there', async () => {
		const context = createMemoryContext({});
		const change = () =>
			Ok({
				kind: 'link' as const,
				added: '2026-11-10',
				url: null,
			});
		const made = await inRun(context, () => items.update({ id: 'n' }, change));
		expect(made).toEqual(
			Ok({
				path: 'data/items/n.md',
				id: 'n',
				kind: 'link' as const,
				added: '2026-11-10',
				done: false,
				body: '',
			}),
		);
		const text = await context.folder.read('data/items/n.md');
		expect(text).toBe('---\nkind: "link"\nadded: "2026-11-10"\n---\n');
		await inRun(context, () => items.update({ id: 'n' }, change));
		expect(await context.folder.read('data/items/n.md')).toBe(text);
		await expect(
			inRun(context, () =>
				items.update({ id: 'm' }, () =>
					// @ts-expect-error a required field does not take null
					Ok({ kind: null, added: '2026-11-10' }),
				),
			),
		).resolves.toMatchObject({
			error: { message: expect.stringContaining('data/items/m.md: kind') },
		});
	});

	test('gives undefined when there is no file, and what it returns makes one, as add would', async () => {
		const context = seeded();
		const seen: unknown[] = [];
		const made = await inRun(context, () =>
			counters.update({ id: 'b' }, (record) => {
				seen.push(record);
				return Ok({ n: 1, note: 'new', body: 'New.\n' });
			}),
		);
		expect(seen).toEqual([undefined]);
		expect(made).toEqual(
			Ok({
				path: 'data/counters/b.md',
				id: 'b',
				n: 1,
				note: 'new',
				body: 'New.\n',
			}),
		);
		await expect(
			inRun(context, () => counters.update({ id: 'c' }, () => Ok({}))),
		).resolves.toMatchObject({
			error: {
				message: expect.stringContaining('data/counters/c.md: note is missing'),
			},
		});
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
			'data/items/Tokyo.md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		});
		expect(
			(await inRun(context, () => items.get({ id: 'Tokyo ' }))).data?.path,
		).toBe('data/items/Tokyo.md');
	});

	test('find a file by the name exactly as given first, while add and a creating update use the tidy name', async () => {
		const context = createMemoryContext({
			'data/items/Tokyo .md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
			'data/items/Tokyo.md': '---\nkind: "quote"\nadded: "2026-11-01"\n---\n',
		});
		const at = { id: 'Tokyo ' };
		expect((await inRun(context, () => items.get(at))).data?.kind).toBe('link');
		await inRun(context, () => items.set(at, { done: true }));
		expect(await context.folder.read('data/items/Tokyo .md')).toContain(
			'done: true',
		);
		await expect(
			inRun(context, () =>
				items.add({ id: 'Paris ', kind: 'link' as const, added: '2026-11-01' }),
			),
		).resolves.toMatchObject(Ok({ path: 'data/items/Paris.md' }));
		const made = await inRun(context, () =>
			items.update({ id: ' Rome' }, () =>
				Ok({
					kind: 'link' as const,
					added: '2026-11-01',
				}),
			),
		);
		expect(made.data?.path).toBe('data/items/Rome.md');
	});

	test('are read only by their names, so a path is refused and a row passes as it is', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: "link"\nadded: "2026-11-01"\n---\n',
		});
		await expect(
			inRun(context, () => items.get({ path: 'data/items/a.md' } as never)),
		).rejects.toThrow(
			'Name a data/items/{id}.md record by its id, not its path',
		);
		const [row] = await inRun(context, () => items.list());
		if (!row) throw new Error('Expected one row');
		expect(
			(await inRun(context, () => items.get(expectOk(row) as never))).data
				?.path,
		).toBe('data/items/a.md');
	});
});

describe('a readOnly field that is required', () => {
	test('leaves add out of the actions, and naming add throws', () => {
		const stamps = defineCollection({
			path: 'data/stamps/{id}.md',
			fields: { at: field.datetime({ readOnly: true }), note: field.text() },
		});
		expect(Object.keys(stamps.actions())).toEqual(['list', 'get', 'set']);
		expect(() => stamps.actions('add' as never)).toThrow(
			'data/stamps/{id}.md has no "add": at is written only by the app\'s own actions and required, so an exposed add could never be given it; write the app\'s own add with defineAction',
		);
	});
});

describe('a collection with no placeholder', () => {
	test('reads as an empty record before its first write', async () => {
		const context = createMemoryContext();
		const empty = Ok({ path: 'data/settings.md', body: '' });
		expect<unknown>(await inRun(context, () => settings.get())).toEqual(empty);
		expect(await run('settings list', {}, context)).toEqual(Ok([]));
		expect(await run('settings get', {}, context)).toEqual(empty);
		expect('add' in settings).toBe(false);
		expect(Object.keys(settings.actions())).toEqual(['list', 'get', 'set']);
		expect(() => settings.actions('add' as never)).toThrow(
			'data/settings.md has no "add": it is one file, which set makes',
		);
		for (const method of ['set', 'update'] as const) {
			expect<unknown>(
				await inRun(context, () =>
					settings[method]((now) => {
						expect(now).toEqual(empty.data);
						return Ok({});
					}),
				),
			).toEqual(empty);
			expect(await context.folder.list()).toEqual([]);
		}
		expectOk(await inRun(context, () => settings.set({ dailyGoal: 20 })));
		expect(await context.folder.read('data/settings.md')).toBe(
			'---\ndailyGoal: 20\n---\n',
		);
		expect(await run('settings delete', {}, context)).toEqual(Ok(true));
		expect<unknown>(await inRun(context, () => settings.get())).toEqual(empty);
		expect(
			await run(
				'settings set',
				{ edit: { old: '', new: 'Notes.\n' } },
				context,
			),
		).toEqual(Ok({ path: 'data/settings.md', body: 'Notes.\n' }));
	});

	test('its set verb makes the file when there is none, as add would', async () => {
		const context = createMemoryContext();
		await expect(
			run('settings set', { voice: 'male', was: { voice: 'female' } }, context),
		).resolves.toMatchObject({ error: { name: 'Changed', why: 'was' } });
		await run('settings set', { voice: 'male', was: { voice: null } }, context);
		expect(await context.folder.read('data/settings.md')).toBe(
			'---\nvoice: "male"\n---\n',
		);
		await run('settings set', { dailyGoal: 5 }, context);
		expect(await context.folder.read('data/settings.md')).toBe(
			'---\nvoice: "male"\ndailyGoal: 5\n---\n',
		);
	});

	test('update receives the empty record before its first write', async () => {
		const context = createMemoryContext();
		const written = await inRun(context, () =>
			settings.update((file) =>
				Ok({
					dailyGoal: (file.dailyGoal ?? 10) + 5,
					body: `${file.voice ?? 'none'}\n`,
				}),
			),
		);
		expect(written).toEqual(
			Ok({
				path: 'data/settings.md',
				dailyGoal: 15,
				body: 'none\n',
			}),
		);
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
		await inRun(context, () => google.set({ refreshToken: 'abc' }));
		expect<unknown>(await inRun(context, () => google.get())).toEqual(
			Ok({
				path: 'data/google.local.md',
				refreshToken: 'abc',
				body: '',
			}),
		);
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
		expect(expectErr(read).problems.map(({ line }) => line)).toEqual([
			'refreshToken is not text',
		]);
		const refused = inRun(context, () =>
			google.set({ refreshToken: 67890 as unknown as string }),
		);
		await expect(refused).resolves.toMatchObject({
			error: {
				message: expect.stringContaining(
					'data/google.local.md: refreshToken is not text',
				),
			},
		});
		expect(JSON.stringify(await refused)).not.toContain('67890');
	});
});

describe('check', () => {
	test('gives each problem line with its kind, the line without its value', async () => {
		const context = createMemoryContext({
			'data/items/a.md': '---\nkind: "song"\nadded: "next week"\n---\n',
			'data/items/b.md': '---\nkind: "thought"\nadded: "soon"\n---\n',
			'data/items/c.md': '---\nkind: "thought"\n---\n',
			'data/items/d.md': '---\nkind: "thought"\n# a comment\n---\n',
			'data/items/e.md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
			'data/items/f .md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
			'data/items/g.md':
				'---\nkind: "thought"\nadded: "2026-11-01"\nsecret: "s3cr3t"\nnote: by hand\n---\n',
			'data/items/h.md': '---\nkind: "thought"\nadded: 2026-11-01\n---\n',
		});
		const added = {
			line: 'added: "soon" is not a day like 2026-11-12',
			kind: 'added is not a day like 2026-11-12',
		};
		const unreadable =
			'its front matter is not key: value lines between two --- lines, each key once';
		expect<unknown>(await inRun(context, () => items.check())).toEqual({
			files: 8,
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
				// f .md fits: a name a person typed is its key as it is.
				// g.md fits: front matter no field declares is kept, not reported, JSON or not.
				{
					path: 'data/items/h.md',
					problems: [
						{
							line: 'added on line 3 is not JSON; write added: "2026-11-01"',
							kind: 'added is not JSON; write its text in double quotes',
						},
					],
				},
			],
		});
		// The rows of the same files keep problems as lines.
		const rows = await inRun(context, () => items.list());
		expect(
			rows.find((row) => row.error?.path === 'data/items/b.md')?.error
				?.problems,
		).toEqual([added]);
		expect(
			rows.find((row) => row.data?.path === 'data/items/g.md')?.error,
		).toBeNull();
	});

	test('of a collection with no placeholder counts no file while it is absent', async () => {
		expect<unknown>(
			await inRun(createMemoryContext(), () => settings.check()),
		).toEqual({
			files: 0,
			records: [],
		});
		const context = createMemoryContext({
			'data/settings.md': '---\nvoice: "robot"\n---\n',
		});
		expect<unknown>(await inRun(context, () => settings.check())).toEqual({
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

describe('the design review defects', () => {
	const notes = defineCollection({
		path: 'data/notes/{title}.md',
		fields: { tags: field.list(field.text()) },
	});

	test('a value that does not fit reads as absent, and a computed write may not replace it', async () => {
		const text = '---\ntags: a, b\n---\nBody\n';
		const context = createMemoryContext({ 'data/notes/a.md': text });
		const before = await inRun(context, () => notes.get({ title: 'a' }));
		expect(
			(expectErr(before) as Extract<ActionError, { name: 'Misfit' }>).record
				?.tags,
		).toBeUndefined();
		expect(
			(
				expectErr(before) as Extract<ActionError, { name: 'Misfit' }>
			).problems.map(({ line }) => line),
		).toEqual([
			'tags on line 2 is not JSON; tags takes a list of text, written as JSON',
		]);
		await expect(
			inRun(context, () =>
				notes.set({ title: 'a' }, (now) =>
					Ok({
						tags: [...(now.tags ?? []), 'new'],
					}),
				),
			),
		).resolves.toMatchObject({
			error: {
				name: 'Misfit',
				message: expect.stringContaining('data/notes/a.md'),
			},
		});
		expect(await context.folder.read('data/notes/a.md')).toBe(text);
	});

	test('a row for a file whose name has a double space reaches that file', async () => {
		const context = createMemoryContext({
			'data/notes/Dune  Messiah.md': '---\ntags: ["x"]\n---\nBody\n',
		});
		const [row] = await inRun(context, () => notes.list());
		if (!row) throw new Error('Expected one row');
		expect(row?.data?.title).toBe('Dune  Messiah');
		expect(row?.error).toBeNull();
		expect(
			(
				await inRun(context, () =>
					notes.get(expectOk(row) as { title: string }),
				)
			).data?.path,
		).toBe('data/notes/Dune  Messiah.md');
		await inRun(context, () =>
			notes.set(expectOk(row) as { title: string }, { tags: ['y'] }),
		);
		expect(await context.folder.list()).toEqual([
			'data/notes/Dune  Messiah.md',
		]);
		expect(await context.folder.read('data/notes/Dune  Messiah.md')).toBe(
			'---\ntags: ["y"]\n---\nBody\n',
		);
	});
});

describe('outside a run', () => {
	test('a collection throws rather than touch any folder', () => {
		expect(items.list()).rejects.toThrow(
			"An app's collections and folder are read only inside an action's run",
		);
	});
});

test('a definition refuses a default at any depth, and was as a placeholder or a field', () => {
	for (const schema of [
		Type.Integer({ default: 5 }),
		Type.Array(Type.String({ default: 'x' })),
		Type.Object({ a: Type.Optional(Type.Boolean({ default: false })) }),
	])
		expect(() =>
			defineCollection({ path: 'data/d/{id}.md', fields: { n: schema } }),
		).toThrow(
			'The collection at data/d/{id}.md has a default in the field "n"; a read gives only what the file holds, so write the default in code where the value is read',
		);
	// A property named default is a name, not a default.
	expect(() =>
		defineCollection({
			path: 'data/d/{id}.md',
			fields: { n: Type.Object({ default: Type.String() }) },
		}),
	).not.toThrow();
	expect(() =>
		defineCollection({ path: 'data/d/{was}.md', fields: {} }),
	).toThrow('has the placeholder {was}, which the set verb takes');
	expect(() =>
		defineCollection({ path: 'data/d/{id}.md', fields: { was: field.text() } }),
	).toThrow('has a field "was", which the set verb takes');
});

test('add writes nothing for an absent switch or list, and a read gives them as false and []', async () => {
	const flags = defineCollection({
		path: 'data/flags/{id}.md',
		fields: { on: field.boolean(), tags: field.list(field.text()) },
	});
	const context = createMemoryContext();
	const made = await inRun(context, () => flags.add({ id: 'a' }));
	expect(await context.folder.read('data/flags/a.md')).toBe('---\n---\n');
	expect(made).toEqual(
		Ok({
			path: 'data/flags/a.md',
			id: 'a',
			on: false,
			tags: [],
			body: '',
		}),
	);
});

test('ordinary text and lists still define a collection', () => {
	expect(() =>
		defineCollection({
			path: 'data/text/{slug}.md',
			fields: { title: field.text(), tags: field.list(field.text()) },
		}),
	).not.toThrow();
});

test('list keeps fitting and malformed files in path order and partitionResults separates them', async () => {
	const context = createMemoryContext({
		'data/items/b.md': '---\nkind: "song"\nadded: "2026-11-01"\n---\nBad\n',
		'data/items/a.md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\nGood\n',
	});
	const rows = await inRun(context, () => items.list());
	expect(rows.map((row) => row.error?.path ?? row.data?.path)).toEqual([
		'data/items/a.md',
		'data/items/b.md',
	]);
	const { oks, errs } = partitionResults(rows);
	expect(oks).toHaveLength(1);
	expect(errs).toHaveLength(1);
	expect(oks[0]?.data.body).toBe('Good\n');
	expect(errs[0]?.error.record?.body).toBe('Bad\n');
	const verb = expectOk(await inRun(context, () => items.actions().list({})));
	const [good, bad] = verb;
	if (!good || !bad) throw new Error('Expected both rows');
	expect(Object.hasOwn(expectOk(good), 'body')).toBe(false);
	const partial = expectErr(bad).record;
	if (!partial) throw new Error('Expected a partial record');
	expect(Object.hasOwn(partial, 'body')).toBe(false);
});

test('local Misfit hides valid secrets beside malformed fields and refusals hide supplied values', async () => {
	const google = defineCollection({
		path: 'data/google.local.md',
		fields: {
			refreshToken: field.text({ optional: true }),
			expires: field.datetime({ optional: true }),
		},
	});
	const context = createMemoryContext({
		'data/google.local.md':
			'---\nrefreshToken: "secret-abc"\nexpires: "soon"\n---\nPrivate body\n',
	});
	const read = await inRun(context, () => google.get());
	expect(read).toMatchObject({
		error: {
			name: 'Misfit',
			problems: [
				{
					line: 'expires is not a date and time like 2026-11-12T09:30:00Z',
					kind: 'expires is not a date and time like 2026-11-12T09:30:00Z',
				},
			],
		},
	});
	expect(Object.hasOwn(expectErr(read), 'record')).toBe(false);
	for (const secret of ['secret-abc', 'soon', 'Private body'])
		expect(JSON.stringify(read)).not.toContain(secret);
	const refusal = await inRun(context, () =>
		google.set({ refreshToken: 67890 as never }),
	);
	expect(refusal).toMatchObject({ error: { name: 'Refused' } });
	expect(JSON.stringify(refusal)).not.toContain('67890');
});

test('unnameable string keys are Refused from readers, writers and verbs, while pathOf and delete throw', async () => {
	const context = createMemoryContext();
	for (const id of ['../x', 'token.local']) {
		for (const attempt of [
			() => items.get({ id }),
			() => items.set({ id }, { done: true }),
			() =>
				items.update({ id }, () =>
					Ok({ kind: 'thought' as const, added: '2026-11-01' }),
				),
			() => items.add({ id, kind: 'thought', added: '2026-11-01' }),
		])
			expect(await inRun(context, async () => await attempt())).toMatchObject({
				error: { name: 'Refused' },
			});
		for (const verb of ['get', 'set', 'delete'] as const)
			expect(
				await inRun(context, () =>
					items.actions(verb)[verb]({ id, done: true } as never),
				),
			).toMatchObject({ error: { name: 'Refused' } });
		expect(() => items.pathOf({ id })).toThrow();
		await expect(inRun(context, () => items.delete({ id }))).rejects.toThrow();
	}
	await expect(
		inRun(context, () => items.get({ id: 42 } as never)),
	).rejects.toThrow('named by its id');
	expect(await context.folder.list()).toEqual([]);
});

test('a single file must permit an empty record and no-op writes never make it', async () => {
	expect(() =>
		defineCollection({
			path: 'data/settings.md',
			fields: { title: field.text() },
		}),
	).toThrow(
		'The collection at data/settings.md is one file, read as empty before it exists, so the field "title" must be optional, a switch, or a list without min',
	);
	const context = createMemoryContext();
	const single = defineCollection({
		path: 'data/settings.md',
		fields: { on: field.boolean(), tags: field.list(field.text()) },
	});
	const empty = Ok({ path: 'data/settings.md', on: false, tags: [], body: '' });
	expect(await inRun(context, () => single.get())).toEqual(empty);
	expect(
		await inRun(context, () => single.set({ on: false, tags: [] })),
	).toEqual(empty);
	expect(
		await inRun(context, () =>
			single.update((now) => {
				expect(now).toEqual(empty.data);
				return Ok({ body: '' });
			}),
		),
	).toEqual(empty);
	expect(await context.folder.list()).toEqual([]);
	expect(await inRun(context, () => single.list())).toEqual([]);
});

test('plain and computed patches can both change fields named data and error', async () => {
	const records = defineCollection({
		path: 'data/settings.md',
		fields: {
			data: field.text({ optional: true }),
			error: field.text({ optional: true }),
		},
	});
	await inRun(createMemoryContext(), async () => {
		const plain = await records.set({ data: 'one', error: 'two' });
		expect(plain.data).toMatchObject({ data: 'one', error: 'two' });
		const computed = await records.set((now) =>
			Ok({ data: now.error, error: now.data }),
		);
		expect(computed.data).toMatchObject({ data: 'two', error: 'one' });
		expect((await records.get()).data).toEqual(computed.data);
	});
});

test('callback Err is forwarded unchanged, while plain returns and thrown callbacks reject without writing', async () => {
	const Declined = defineErrors({
		Later: () => ({ message: 'try later', after: 7 }),
	});
	const declined = Declined.Later();
	const text = '---\nkind: "thought"\nadded: "2026-11-01"\n---\nKept\n';
	const context = createMemoryContext({ 'data/items/a.md': text });
	for (const method of ['set', 'update'] as const) {
		const result = await inRun(context, () =>
			items[method]({ id: 'a' }, () => declined),
		);
		expect(result).toBe(declined);
		await expect(
			inRun(context, () =>
				items[method]({ id: 'a' }, (() => ({ done: true })) as never),
			),
		).rejects.toThrow(
			`The change given to ${method} must return a Result: Ok(change) or Err(error)`,
		);
		await expect(
			inRun(context, () =>
				items[method]({ id: 'a' }, () => {
					throw new Error('fault');
				}),
			),
		).rejects.toThrow('fault');
		expect(await context.folder.read('data/items/a.md')).toBe(text);
	}
});

test('a folder conflict is returned and a callback throwing the same Changed rejects', async () => {
	const context = createMemoryContext({
		'data/items/a.md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
	});
	const changed = ActionError.Changed({ path: 'data/items/a.md', why: 'kept' });
	const conflict = {
		...context,
		folder: {
			...context.folder,
			async edit() {
				return changed;
			},
		},
	};
	expect(
		await inRun(conflict, () => items.set({ id: 'a' }, { done: true })),
	).toEqual(changed);
	for (const method of ['set', 'update'] as const)
		await expect(
			inRun(context, () =>
				items[method]({ id: 'a' }, () => {
					throw changed.error;
				}),
			),
		).rejects.toBe(changed.error);
});

test('an action forwards a collection Result and another adds only its own Missing', async () => {
	const lookup = defineAction({
		description: 'Look up an item',
		input: { id: field.text() },
		run: ({ id }) => items.get({ id }),
	});
	const kind = defineAction({
		description: 'Read an item kind',
		input: { id: field.text() },
		async run({ id }) {
			const read = await lookup({ id });
			if (read.error !== null) return read;
			if (read.data === undefined)
				return ActionError.Missing({ path: items.pathOf({ id }) });
			return Ok(read.data.kind);
		},
	});
	const context = createMemoryContext({
		'data/items/a.md': '---\nkind: "song"\nadded: "2026-11-01"\n---\n',
		'data/items/b.md': '---\nkind: "quote"\nadded: "2026-11-01"\n---\n',
	});
	expect<unknown>(await inRun(context, () => kind({ id: 'a' }))).toEqual(
		await inRun(context, () => lookup({ id: 'a' })),
	);
	expect(await inRun(context, () => kind({ id: 'nope' }))).toEqual(
		ActionError.Missing({ path: 'data/items/nope.md' }),
	);
	expect(await inRun(context, () => lookup({ id: 'nope' }))).toEqual(
		Ok(undefined),
	);
	expect(await inRun(context, () => kind({ id: 'b' }))).toEqual(Ok('quote'));
});

test('an exact file whose key cannot be tidied is still reached by get and delete', async () => {
	const context = createMemoryContext({
		'data/items/ .md': '---\nkind: "thought"\nadded: "2026-11-01"\n---\n',
	});
	const [row] = await inRun(context, () => items.list());
	if (!row) throw new Error('Expected one row');
	const keys = expectOk(row);
	expect(keys.id).toBe(' ');
	expect(await inRun(context, () => items.get(keys))).toEqual(row);
	expect(await inRun(context, () => items.delete(keys))).toBe(true);
	expect(await context.folder.list()).toEqual([]);
	expect(await inRun(context, () => items.get(keys))).toMatchObject({
		error: { name: 'Refused' },
	});
});

test('verbs propagate thrown tagged I/O faults and delete does not parse records', async () => {
	const context = createMemoryContext({
		'data/items/a.md': '---\n# unreadable\n---\n',
	});
	const refused = ActionError.Refused({
		message: 'unexpected read fault',
	}).error;
	const broken = {
		...context,
		folder: {
			...context.folder,
			async read() {
				throw refused;
			},
		},
	};
	await expect(
		inRun(broken, () => items.actions().get({ id: 'a' })),
	).rejects.toBe(refused);
	const deletion = items.actions('delete').delete;
	expect(await inRun(context, () => deletion({ id: 'a' }))).toEqual(Ok(true));
	expect(await context.folder.list()).toEqual([]);
});

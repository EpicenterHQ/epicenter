import { describe, expect, test } from 'bun:test';
import { collectionActions, createMemoryContext } from './index.ts';

const items = collectionActions('items', {
	path: 'items/{id}.md',
	fields: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: ['thought', 'link', 'quote'] },
			url: { type: 'string', format: 'uri' },
			added: { type: 'string', format: 'date' },
			done: { type: 'boolean', default: false },
		},
		required: ['kind', 'added'],
	},
});

function run(words: string, input: object, context: ReturnType<typeof createMemoryContext>) {
	const action = items[words];
	if (!action) throw new Error(`no action ${words}`);
	return action.run(input as never, context);
}

describe('a Markdown collection', () => {
	test('gives list, get, set, and delete, reading by the key alone', () => {
		expect(Object.keys(items)).toEqual([
			'items list',
			'items get',
			'items set',
			'items delete',
		]);
		expect(items['items get']?.positional).toEqual(['id']);
		expect(items['items list']?.annotations).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
		});
	});

	test('set makes a new file as key: <JSON> lines in declared order, with defaults', async () => {
		const context = createMemoryContext();
		const made = await run(
			'items set',
			{ id: 'dune', added: '2026-11-09', kind: 'quote', body: 'Fear is the mind-killer.\n' },
			context,
		);
		expect(await context.folder.read('items/dune.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-09"\ndone: false\n---\nFear is the mind-killer.\n',
		);
		expect(made).toEqual({
			kind: 'quote',
			added: '2026-11-09',
			done: false,
			id: 'dune',
			body: 'Fear is the mind-killer.\n',
		});
	});

	test('set refuses a new file without its required fields, and writes nothing', async () => {
		const context = createMemoryContext();
		expect(run('items set', { id: 'dune', kind: 'quote' }, context)).rejects.toThrow(
			'A new items/dune.md needs added',
		);
		expect(await context.folder.list()).toEqual([]);
	});

	test('set changes only the lines it is given, keeping the rest byte for byte', async () => {
		const text =
			'---\nkind: "thought"\nadded:   "2026-11-01"\ndone: true\n---\n\nKeep me.\n';
		const context = createMemoryContext({ 'items/a.md': text });
		await run('items set', { id: 'a', kind: 'link', url: 'https://example.com' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\n\nKeep me.\n',
		);
		await run('items set', { id: 'a', body: 'New.\n' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "link"\nadded:   "2026-11-01"\ndone: true\nurl: "https://example.com"\n---\nNew.\n',
		);
	});

	test('set rewrites YAML front matter as key: <JSON> lines and keeps the body', async () => {
		const context = createMemoryContext({
			'items/a.md': '---\nkind: thought # a comment\nadded: 2026-11-01\ntags: [x, y]\n---\nBody\n',
		});
		expect(await run('items get', { id: 'a' }, context)).toEqual({
			kind: 'thought',
			added: '2026-11-01',
			tags: ['x', 'y'],
			id: 'a',
			body: 'Body\n',
		});
		await run('items set', { id: 'a', kind: 'quote' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "quote"\nadded: "2026-11-01"\ntags: ["x", "y"]\n---\nBody\n',
		);
	});

	test('a file without front matter is all body, and set adds front matter above it', async () => {
		const context = createMemoryContext({ 'items/a.md': '# Just text\n' });
		expect(await run('items get', { id: 'a' }, context)).toEqual({
			id: 'a',
			body: '# Just text\n',
		});
		await run('items set', { id: 'a', kind: 'thought' }, context);
		expect(await context.folder.read('items/a.md')).toBe(
			'---\nkind: "thought"\n---\n# Just text\n',
		);
	});

	test('front matter that is neither grammar nor YAML is read as body, and set refuses it', async () => {
		const text = '---\nkind: [unclosed\n---\nBody\n';
		const context = createMemoryContext({ 'items/a.md': text });
		expect(await run('items get', { id: 'a' }, context)).toEqual({ id: 'a', body: text });
		expect(run('items set', { id: 'a', kind: 'quote' }, context)).rejects.toThrow(
			'items/a.md has front matter that is neither key: <JSON> lines nor YAML; fix it by hand first',
		);
		expect(await context.folder.read('items/a.md')).toBe(text);
	});

	test('get names a missing file', async () => {
		expect(run('items get', { id: 'nope' }, createMemoryContext())).rejects.toThrow(
			'There is no items/nope.md',
		);
	});

	test('list reads every file the path matches, by key, without bodies', async () => {
		const context = createMemoryContext({
			'items/b.md': '---\nkind: "link"\n---\nB\n',
			'items/a.md': 'no front matter\n',
			'items/.hidden.md': '---\nkind: "x"\n---\n',
			'items/nested/c.md': '---\nkind: "x"\n---\n',
			'items/notes.txt': 'not a match',
			'other/d.md': '---\nkind: "x"\n---\n',
		});
		expect(await run('items list', {}, context)).toEqual([
			{ id: 'a' },
			{ kind: 'link', id: 'b' },
		]);
	});

	test('delete answers whether a file was there', async () => {
		const context = createMemoryContext({ 'items/a.md': 'A\n' });
		expect(await run('items delete', { id: 'a' }, context)).toBe(true);
		expect(await run('items delete', { id: 'a' }, context)).toBe(false);
		expect(await context.folder.list()).toEqual([]);
	});
});

describe('a JSON collection', () => {
	test('one file with no placeholder gives get and set, merging its fields', async () => {
		const settings = collectionActions('settings', {
			path: 'settings.json',
			fields: {
				type: 'object',
				properties: { theme: { type: 'string' }, size: { type: 'number' } },
			},
		});
		expect(Object.keys(settings)).toEqual(['settings get', 'settings set']);
		const context = createMemoryContext({ 'settings.json': '{ "size": 12, "other": true }' });
		await settings['settings set']?.run({ theme: 'dark' } as never, context);
		expect(await context.folder.read('settings.json')).toBe(
			'{\n  "size": 12,\n  "other": true,\n  "theme": "dark"\n}\n',
		);
		expect(await settings['settings get']?.run({} as never, context)).toEqual({
			size: 12,
			other: true,
			theme: 'dark',
		});
	});

	test('set refuses a file that is not a JSON object', async () => {
		const settings = collectionActions('settings', {
			path: 'settings.json',
			fields: { type: 'object' },
		});
		const context = createMemoryContext({ 'settings.json': '[1, 2]' });
		expect(settings['settings set']?.run({} as never, context)).rejects.toThrow(
			'settings.json is not a JSON object; fix it by hand first',
		);
	});
});

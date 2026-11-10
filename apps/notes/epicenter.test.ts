/**
 * Notes actions preserve Markdown, name a developed capture once even on retry,
 * and refuse stale body edits and changes to the capture field.
 */
import { expect, test } from 'bun:test';
import { createMemoryContext, inRun } from '@epicenter/app';
import notes from './epicenter.js';

const { add, list, set, edit } = notes.actions;
const capture = 'captures/2026-11-10T09-30-00-000Z-k3x9a2f8.md';

test('add writes an ordinary note with its title, time, and Markdown', async () => {
	const context = createMemoryContext({});
	const file = await inRun(context, () =>
		add({ title: '  An idea  ', body: 'Develop this.' }),
	);
	expect(file).toMatchObject({
		title: 'An idea',
		body: 'Develop this.\n',
		added: true,
	});
	expect(file.path).toMatch(/^notes\/\d{4}-.+\.md$/);
	expect(file.createdAt).toMatch(/^\d{4}-.+T.+[+-]\d{2}:\d{2}$/);
	expect(await context.folder.read(file.path)).toBe(
		`---\ntitle: "An idea"\ncreatedAt: "${file.createdAt}"\n---\nDevelop this.\n`,
	);
});

test('a retry finds the developed capture without changing its file', async () => {
	const context = createMemoryContext({});
	const first = await inRun(context, () =>
		add({ capture, title: 'Idea', body: 'First' }),
	);
	expect(first.path).toBe('notes/capture-2026-11-10T09-30-00-000Z-k3x9a2f8.md');
	const text = await context.folder.read(first.path);
	expect(text).toContain(`capture: "${capture}"`);
	const retry = await inRun(context, () =>
		add({ capture, title: 'Other', body: 'Different' }),
	);
	expect(retry).toMatchObject({
		path: first.path,
		added: false,
		title: 'Idea',
		body: 'First\n',
	});
	expect(await context.folder.read(first.path)).toBe(text);
	expect(await inRun(context, () => list({}))).toHaveLength(1);
});

test('a hand-written note can already name a capture at another path', async () => {
	const text = '---\ncapture: "captures/x.md"\n---\nMine\n';
	const context = createMemoryContext({ 'notes/mine.md': text });
	expect(
		await inRun(context, () => add({ capture: 'captures/x.md' })),
	).toMatchObject({ path: 'notes/mine.md', added: false });
	expect(await inRun(context, () => list({}))).toHaveLength(1);
	expect(await context.folder.read('notes/mine.md')).toBe(text);
});

test('concurrent adds meet at one file', async () => {
	const context = createMemoryContext({});
	const answers = await inRun(context, () =>
		Promise.all([add({ capture }), add({ capture })]),
	);
	expect(answers[0]?.path).toBe(answers[1]?.path);
	expect(answers.filter((answer) => answer.added)).toHaveLength(1);
	expect(await inRun(context, () => list({}))).toHaveLength(1);
});

test('invalid capture paths and multiline titles write nothing', async () => {
	const context = createMemoryContext({});
	for (const capture of [
		'notes/x.md',
		'captures/../x.md',
		'captures/.x.md',
		'captures/x\\y.md',
	]) {
		await expect(inRun(context, () => add({ capture }))).rejects.toThrow();
	}
	await expect(
		inRun(context, () => add({ title: 'Two\nlines' })),
	).rejects.toThrow('A note title is one line');
	expect(await inRun(context, () => list({}))).toEqual([]);
});

test('set exposes title but refuses the readOnly fields', async () => {
	const context = createMemoryContext({});
	const first = await inRun(context, () => add({ capture }));
	const text = await context.folder.read(first.path);
	// A remote caller can send fields outside the TypeScript input.
	await expect(
		inRun(context, () =>
			set({ path: first.path, ...{ capture: 'captures/y.md' } }),
		),
	).rejects.toThrow();
	await expect(
		inRun(context, () =>
			set({ path: first.path, ...{ createdAt: '2026-11-10T00:00:00Z' } }),
		),
	).rejects.toThrow();
	expect(await context.folder.read(first.path)).toBe(text);
	expect(
		await inRun(context, () =>
			set({ path: first.path, title: 'Changed title' }),
		),
	).toMatchObject({ title: 'Changed title', capture });
});

test('a stale body quote is Changed and the current whole body can be edited', async () => {
	const context = createMemoryContext({});
	const first = await inRun(context, () => add({ body: 'Original' }));
	const changed = await inRun(context, () =>
		edit({ path: first.path, old: first.body, new: 'An agent changed it.\n' }),
	);
	const text = await context.folder.read(first.path);
	await expect(
		inRun(context, () =>
			edit({ path: first.path, old: first.body, new: 'Mine' }),
		),
	).rejects.toMatchObject({ name: 'Changed' });
	expect(await context.folder.read(first.path)).toBe(text);
	expect(
		await inRun(context, () =>
			edit({ path: first.path, old: changed.body, new: 'Mine\n' }),
		),
	).toMatchObject({ body: 'Mine\n' });
});

test('an untitled empty note omits optional fields and preserves an existing body newline', async () => {
	const context = createMemoryContext({});
	const empty = await inRun(context, () => add({ title: '   ' }));
	expect(empty.body).toBe('');
	expect(await context.folder.read(empty.path)).toBe(
		`---\ncreatedAt: "${empty.createdAt}"\n---\n`,
	);
	const full = await inRun(context, () => add({ body: 'Markdown\n\n' }));
	expect(full.body).toBe('Markdown\n\n');
});

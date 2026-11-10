import { expect, test } from 'bun:test';
import { createMemoryContext, inRun } from '@epicenter/app';
import tasks from './epicenter.ts';

const { add } = tasks.actions;

test('add writes a task the collection reads, with an optional due day', async () => {
	const context = createMemoryContext({});
	const added = await inRun(context, () =>
		add({ title: 'Buy milk', due: '2026-11-12' }),
	);
	expect(added).toMatchObject({
		title: 'Buy milk',
		done: false,
		due: '2026-11-12',
	});
	expect(added.path).toMatch(/^tasks\/.+\.md$/);
	expect(await context.folder.read(added.path)).toBe(
		'---\ntitle: "Buy milk"\ndone: false\ndue: "2026-11-12"\n---\n',
	);
});

test('add keeps the first line as the title and the rest, then notes, as the body', async () => {
	const context = createMemoryContext({});
	const added = await inRun(context, () =>
		add({ title: 'Call Mom\nabout the trip', notes: 'Ask about Sunday' }),
	);
	expect(await context.folder.read(added.path)).toBe(
		'---\ntitle: "Call Mom"\ndone: false\n---\nabout the trip\n\nAsk about Sunday\n',
	);
});

test('add refuses an empty title', async () => {
	await expect(
		inRun(createMemoryContext({}), () => add({ title: '  \n' })),
	).rejects.toThrow('A task needs a title');
});

test('the collection gives the other verbs, by path', async () => {
	const context = createMemoryContext({
		'tasks/a.md': '---\ntitle: "Water the plants"\ndone: false\n---\n',
	});
	const { set, list } = tasks.actions;
	await inRun(context, () => set({ path: 'tasks/a.md', done: true }));
	expect(await inRun(context, () => list({}))).toEqual([
		{ path: 'tasks/a.md', time: 'a', title: 'Water the plants', done: true },
	]);
});

test('set refuses a title of several lines, or a blank one, as add keeps one', async () => {
	const text = '---\ntitle: "Water the plants"\ndone: false\n---\n';
	const context = createMemoryContext({ 'tasks/a.md': text });
	const { set } = tasks.actions;
	for (const title of ['Water\nthe plants', '   '])
		await expect(
			inRun(context, () => set({ path: 'tasks/a.md', title })),
		).rejects.toThrow(
			`tasks/a.md: title: ${JSON.stringify(title)} is not one line, not blank, saying what to do`,
		);
	expect(await context.folder.read('tasks/a.md')).toBe(text);
});

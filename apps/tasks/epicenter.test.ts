import { expect, test } from 'bun:test';
import { createMemoryContext } from '@epicenter/app';
import tasks from './epicenter.ts';

test('add writes a task the collection reads, with an optional due day', async () => {
	const context = createMemoryContext({});
	const added = await tasks.actions.add.run(
		{ title: 'Buy milk', due: '2026-11-12' },
		context,
	);
	expect(added).toMatchObject({ title: 'Buy milk', done: false, due: '2026-11-12' });
	expect(await context.folder.read(`tasks/${added.id}.md`)).toBe(
		'---\ntitle: "Buy milk"\ndone: false\ndue: "2026-11-12"\n---\n',
	);
});

test('add keeps the first line as the title and the rest, then notes, as the body', async () => {
	const context = createMemoryContext({});
	const added = await tasks.actions.add.run(
		{ title: 'Call Mom\nabout the trip', notes: 'Ask about Sunday' },
		context,
	);
	expect(await context.folder.read(`tasks/${added.id}.md`)).toBe(
		'---\ntitle: "Call Mom"\ndone: false\n---\nabout the trip\n\nAsk about Sunday\n',
	);
});

test('add refuses an empty title', async () => {
	await expect(tasks.actions.add.run({ title: '  \n' }, createMemoryContext({}))).rejects.toThrow(
		'A task needs a title',
	);
});

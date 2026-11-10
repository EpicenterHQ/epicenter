import { expect, setSystemTime, test } from 'bun:test';
import { createMemoryContext, inRun, localDay } from '@epicenter/app';
import reading from './epicenter.ts';

const { add, start, finish, list } = reading.actions;

test('start adds a book I am reading, named by its title as typed', async () => {
	const context = createMemoryContext({});
	const started = await inRun(context, () =>
		start({ title: '  Gödel,  Escher, Bach ', author: 'Douglas Hofstadter' }),
	);
	expect(started).toMatchObject({
		path: 'books/Gödel, Escher, Bach.md',
		title: 'Gödel, Escher, Bach',
		author: 'Douglas Hofstadter',
		started: localDay(),
	});
	expect(await context.folder.read(started.path)).toBe(
		`---\nauthor: "Douglas Hofstadter"\nstarted: "${localDay()}"\n---\n`,
	);
});

test('a book moves from meaning to read, to reading, to read, and starting it again rereads it', async () => {
	const context = createMemoryContext({});
	const run = <T>(call: () => Promise<T>) => inRun(context, call);
	setSystemTime(new Date(2026, 10, 1, 9));
	await run(() => add({ title: 'Dune', author: 'Frank Herbert' }));
	expect(await run(() => list({}))).toEqual([
		{ path: 'books/Dune.md', title: 'Dune', author: 'Frank Herbert' },
	]);

	setSystemTime(new Date(2026, 10, 2, 9));
	await run(() => start({ title: 'Dune' }));
	setSystemTime(new Date(2026, 10, 3, 9));
	await run(() => start({ title: 'Dune' }));
	expect(await run(() => list({}))).toMatchObject([{ started: '2026-11-02' }]);

	setSystemTime(new Date(2026, 10, 20, 23, 59));
	const finished = await run(() => finish({ title: 'Dune', rating: 5 }));
	expect(finished).toMatchObject({
		started: '2026-11-02',
		finished: '2026-11-20',
		rating: 5,
	});

	setSystemTime(new Date(2027, 0, 5, 9));
	const again = await run(() => start({ title: 'Dune' }));
	expect(again).toMatchObject({ started: '2027-01-05', rating: 5 });
	expect(again).not.toHaveProperty('finished');
	setSystemTime();
});

test('finish adds a book I read without logging it first, and keeps a finished day', async () => {
	const context = createMemoryContext({});
	setSystemTime(new Date(2026, 10, 11, 9));
	const read = await inRun(context, () => finish({ title: 'Piranesi' }));
	expect(read).toMatchObject({ title: 'Piranesi', finished: '2026-11-11' });
	expect(read).not.toHaveProperty('started');

	setSystemTime(new Date(2026, 10, 12, 9));
	const rated = await inRun(context, () => finish({ title: 'Piranesi', rating: 4 }));
	expect(rated).toMatchObject({ finished: '2026-11-11', rating: 4 });
	setSystemTime();
});

test('a rating outside 1 to 5 written by hand reads as a problem, not a rating', async () => {
	const context = createMemoryContext({
		'books/Dune.md': '---\nrating: 7\n---\n',
	});
	expect(await inRun(context, () => list({}))).toEqual([
		{
			path: 'books/Dune.md',
			title: 'Dune',
			problems: ['rating: 7 is not a whole number from 1 to 5'],
		},
	]);
});

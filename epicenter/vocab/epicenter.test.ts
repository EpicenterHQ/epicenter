import { describe, expect, test } from 'bun:test';
import { createMemoryContext } from '@epicenter/app';
import vocab, { type Grade, isDue, schedule } from './epicenter.ts';

/** 9pm local time on 10 November 2026; a day's interval is due at 4am local time. */
const evening = new Date(2026, 10, 10, 21, 0, 0);
const morningAfter = (days: number) => new Date(2026, 10, 10 + days, 4).toISOString();

function review(grades: Grade[]) {
	let word: Parameters<typeof schedule>[0] = {};
	for (const grade of grades) word = schedule(word, grade, evening);
	return word;
}

describe('schedule', () => {
	test('a new word remembered is due the next morning, then in six days, then by its ease', () => {
		const first = schedule({}, 'good', evening);
		expect(first).toEqual({ due: morningAfter(1), interval: 1, ease: 2.5, reps: 1 });
		const second = schedule(first, 'good', evening);
		expect(second).toMatchObject({ due: morningAfter(6), interval: 6, reps: 2 });
		expect(schedule(second, 'good', evening)).toMatchObject({ interval: 15, reps: 3 });
	});

	test('a review after midnight counts toward the night before', () => {
		const lateNight = new Date(2026, 10, 11, 1, 30);
		expect(schedule({}, 'good', lateNight).due).toBe(morningAfter(1));
		const morning = new Date(2026, 10, 11, 9, 0);
		expect(schedule({}, 'good', morning).due).toBe(morningAfter(2));
	});

	test('again starts the word over, due in ten minutes, and lowers its ease', () => {
		const forgotten = schedule(review(['good', 'good']), 'again', evening);
		expect(forgotten).toEqual({
			due: new Date(evening.getTime() + 10 * 60_000).toISOString(),
			interval: 0,
			ease: 2.3,
			reps: 0,
		});
	});

	test('hard grows the interval least and easy most', () => {
		const known = review(['good', 'good']);
		const [hard, good, easy] = (['hard', 'good', 'easy'] as const).map(
			(grade) => schedule(known, grade, evening),
		);
		expect(hard?.interval).toBe(7);
		expect(good?.interval).toBe(15);
		expect(easy?.interval).toBe(20);
		expect([hard?.ease, good?.ease, easy?.ease]).toEqual([2.35, 2.5, 2.65]);
	});

	test('ease never falls below 1.3, and every remembered review grows the interval', () => {
		const word = review(Array(10).fill('again').concat(['good', 'good', 'hard', 'hard']));
		expect(word.ease).toBe(1.3);
		expect(word.interval).toBe(8);
	});

	test('a word with no due is due; one with a later due is not', () => {
		expect(isDue({}, evening)).toBe(true);
		expect(isDue({ due: morningAfter(1) }, evening)).toBe(false);
		expect(isDue({ due: morningAfter(-1) }, evening)).toBe(true);
	});
});

describe('actions', () => {
	const { add, review: grade, due } = vocab.actions;

	test('add writes words/<word>.md and returns an existing word unchanged', async () => {
		const context = createMemoryContext({});
		const added = await add.run(
			{ word: ' 你好 ', meaning: 'hello', reading: 'nǐ hǎo', body: '你好，我叫小明。' },
			context,
		);
		expect(added).toMatchObject({ word: '你好', meaning: 'hello', added: true });
		const text = await context.folder.read('words/你好.md');
		expect(text).toContain('meaning: "hello"\nreading: "nǐ hǎo"\ncreatedAt: ');
		expect(text?.endsWith('---\n你好，我叫小明。\n')).toBe(true);

		const again = await add.run({ word: '你好', meaning: 'hi' }, context);
		expect(again).toMatchObject({ meaning: 'hello', added: false });
	});

	test('add refuses a word that cannot name a file', async () => {
		const context = createMemoryContext({});
		await expect(add.run({ word: 'and/or' }, context)).rejects.toThrow('cannot name a file');
		await expect(add.run({ word: '  ' }, context)).rejects.toThrow('A word is needed');
	});

	test('review schedules the word and due leaves it out until then', async () => {
		const context = createMemoryContext({});
		await add.run({ word: '谢谢', meaning: 'thanks' }, context);
		await add.run({ word: '再见', meaning: 'goodbye' }, context);
		expect((await due.run({}, context)).map((word) => word.word).sort()).toEqual(['再见', '谢谢']);

		const graded = await grade.run({ word: '谢谢', grade: 'good' }, context);
		expect(graded).toMatchObject({ word: '谢谢', interval: 1, reps: 1 });
		const text = await context.folder.read('words/谢谢.md');
		expect(text).toContain('meaning: "thanks"');
		expect(text).toContain('interval: 1\n');

		const left = await due.run({}, context);
		expect(left.map((word) => word.word)).toEqual(['再见']);
		expect(left[0]?.next.good).toBe(schedule({}, 'good', new Date()).due);
	});

	test('due puts words reviewed before ahead of new ones, the most overdue first', async () => {
		const context = createMemoryContext({
			'words/new.md': '---\ncreatedAt: "2026-01-01T00:00:00Z"\n---\n',
			'words/late.md':
				'---\ncreatedAt: "2026-01-02T00:00:00Z"\ndue: "2026-02-01T00:00:00Z"\n---\n',
			'words/later.md':
				'---\ncreatedAt: "2026-01-03T00:00:00Z"\ndue: "2026-03-01T00:00:00Z"\n---\nexample\n',
			'words/future.md':
				'---\ncreatedAt: "2026-01-03T00:00:00Z"\ndue: "2999-01-01T00:00:00Z"\n---\n',
		});
		const words = await due.run({}, context);
		expect(words.map((word) => word.word)).toEqual(['late', 'later', 'new']);
		expect(words[1]?.body).toBe('example\n');
	});

	test('review of a word that is not there throws', async () => {
		await expect(
			grade.run({ word: 'missing', grade: 'good' }, createMemoryContext({})),
		).rejects.toThrow('There is no words/missing.md');
	});
});

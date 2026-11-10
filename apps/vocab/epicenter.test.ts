import { describe, expect, test } from 'bun:test';
import { createMemoryContext, inRun } from '@epicenter/app';
import vocab, { type Grade, isDue, schedule } from './epicenter.ts';

/** 9pm local time on 10 November 2026; a day's interval is due at 4am local time. */
const evening = new Date(2026, 10, 10, 21, 0, 0);
const morningAfter = (days: number) =>
	new Date(2026, 10, 10 + days, 4).toISOString();

function review(grades: Grade[]) {
	let word: Parameters<typeof schedule>[0] = {};
	for (const grade of grades) word = schedule(word, grade, evening);
	return word;
}

describe('schedule', () => {
	test('a new word remembered is due the next morning, then in six days, then by its ease', () => {
		const first = schedule({}, 'good', evening);
		expect(first).toEqual({
			due: morningAfter(1),
			interval: 1,
			ease: 2.5,
			reps: 1,
		});
		const second = schedule(first, 'good', evening);
		expect(second).toMatchObject({
			due: morningAfter(6),
			interval: 6,
			reps: 2,
		});
		expect(schedule(second, 'good', evening)).toMatchObject({
			interval: 15,
			reps: 3,
		});
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
		const word = review(
			Array(10).fill('again').concat(['good', 'good', 'hard', 'hard']),
		);
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
		const added = await inRun(context, () =>
			add({
				word: ' 你好 ',
				meaning: 'hello',
				reading: 'nǐ hǎo',
				body: '你好，我叫小明。',
			}),
		);
		expect(added).toMatchObject({
			path: 'words/你好.md',
			meaning: 'hello',
			added: true,
		});
		const text = await context.folder.read('words/你好.md');
		expect(text).toContain('meaning: "hello"\nreading: "nǐ hǎo"\ncreatedAt: ');
		expect(text?.endsWith('---\n你好，我叫小明。\n')).toBe(true);

		const again = await inRun(context, () =>
			add({ word: '你好', meaning: 'hi' }),
		);
		expect(again).toMatchObject({ meaning: 'hello', added: false });
	});

	test('add refuses a word that cannot name a file', async () => {
		const context = createMemoryContext({});
		await expect(inRun(context, () => add({ word: 'and/or' }))).rejects.toThrow(
			'cannot name a file',
		);
		await expect(inRun(context, () => add({ word: '  ' }))).rejects.toThrow(
			'A word is needed',
		);
	});

	test('review schedules the word and due leaves it out until then', async () => {
		const context = createMemoryContext({});
		await inRun(context, () => add({ word: '谢谢', meaning: 'thanks' }));
		await inRun(context, () => add({ word: '再见', meaning: 'goodbye' }));
		const paths = async () =>
			(await inRun(context, () => due({}))).map((word) => word.path);
		expect((await paths()).sort()).toEqual(['words/再见.md', 'words/谢谢.md']);

		const graded = await inRun(context, () =>
			grade({ path: 'words/谢谢.md', grade: 'good' }),
		);
		expect(graded).toMatchObject({
			path: 'words/谢谢.md',
			interval: 1,
			reps: 1,
		});
		const text = await context.folder.read('words/谢谢.md');
		expect(text).toContain('meaning: "thanks"');
		expect(text).toContain('interval: 1\n');

		const left = await inRun(context, () => due({}));
		expect(left.map((word) => word.path)).toEqual(['words/再见.md']);
		expect(left[0]?.next.good).toBe(schedule({}, 'good', new Date()).due);
	});

	test('the schedule is written only by review, not by words set', async () => {
		const context = createMemoryContext({});
		await inRun(context, () => add({ word: '谢谢' }));
		const { set } = vocab.actions;
		await expect(
			inRun(context, () =>
				set({ path: 'words/谢谢.md', interval: 9 } as never),
			),
		).rejects.toThrow("interval is written only by the app's own actions");
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
		const words = await inRun(context, () => due({}));
		expect(words.map((word) => word.path)).toEqual([
			'words/late.md',
			'words/later.md',
			'words/new.md',
		]);
		expect(words[1]?.body).toBe('example\n');
	});

	test('a due written by hand that is not a date and time makes the word due now, and says why', async () => {
		const context = createMemoryContext({
			'words/null.md':
				'---\ncreatedAt: "2026-01-01T00:00:00Z"\ndue: null\n---\n',
			'words/soon.md':
				'---\ncreatedAt: "2026-01-02T00:00:00Z"\ndue: "next week"\n---\n',
			'words/undated.md': '---\nmeaning: "no createdAt"\n---\n',
		});
		const words = await inRun(context, () => due({}));
		expect(words.map((word) => word.path)).toEqual([
			'words/null.md',
			'words/soon.md',
			'words/undated.md',
		]);
		expect(words[0]).toMatchObject({
			word: 'null',
			problems: ['due: null is not a date and time'],
			other: { due: null },
		});
		expect(words[0]).not.toHaveProperty('due');
		expect(words[2]?.problems).toEqual(['createdAt is missing']);
	});

	test('review of a word that is not there throws', async () => {
		await expect(
			inRun(createMemoryContext({}), () =>
				grade({ path: 'words/missing.md', grade: 'good' }),
			),
		).rejects.toThrow('There is no words/missing.md');
	});
});

import { expect, test } from 'bun:test';
import { createMemoryContext, inRun } from '@epicenter/app';
import capture, { preview } from './epicenter.ts';

const { add, recent } = capture.actions;

const note = (capturedAt: string, body: string) =>
	`---\ncapturedAt: ${JSON.stringify(capturedAt)}\n---\n${body}`;

test('recent orders by the instant capturedAt names, not by its text, and cuts at limit', async () => {
	const context = createMemoryContext({
		// 09:00 in UTC+8 is 01:00Z, before b's 02:00Z although its text sorts later.
		'data/captures/a.md': note('2026-11-10T09:00:00+08:00', 'Early\n'),
		'data/captures/b.md': note('2026-11-10T02:00:00Z', 'Later\n'),
		'data/captures/c.md': note('2026-11-09T12:00:00Z', 'Day before\n'),
		'data/captures/notes.txt': 'not a capture',
	});
	expect(await inRun(context, () => recent({ limit: 2 }))).toEqual({
		total: 3,
		captures: [
			{
				path: 'data/captures/b.md',
				capturedAt: '2026-11-10T02:00:00Z',
				text: 'Later',
				thoughts: 0,
			},
			{
				path: 'data/captures/a.md',
				capturedAt: '2026-11-10T09:00:00+08:00',
				text: 'Early',
				thoughts: 0,
			},
		],
	});
});

test('recent lists a capture with no date last, and matching searches the whole file', async () => {
	const context = createMemoryContext({
		'data/captures/a.md': note(
			'2026-11-10T02:00:00Z',
			'Dune\n\n## Thoughts\n\n- spice\n',
		),
		'data/captures/b.md': 'Written by hand, no front matter. Spice too.\n',
		'data/captures/c.md': note('2026-11-10T03:00:00Z', 'Arrakis\n'),
		'data/captures/d.md': note('last Tuesday', 'Undated by hand\n'),
	});
	const all = await inRun(context, () => recent({}));
	expect(all.captures.map((row) => row.path)).toEqual([
		'data/captures/c.md',
		'data/captures/a.md',
		'data/captures/d.md',
		'data/captures/b.md',
	]);
	expect(all.captures[2]?.capturedAt).toBeUndefined();
	expect(all.captures[3]?.capturedAt).toBeUndefined();

	const spice = await inRun(context, () => recent({ matching: ' SPICE ' }));
	expect(spice.total).toBe(2);
	expect(spice.captures.map((row) => row.path)).toEqual([
		'data/captures/a.md',
		'data/captures/b.md',
	]);
});

test('add then recent shows the capture with its text', async () => {
	const context = createMemoryContext({});
	const { path } = await inRun(context, () =>
		add({ text: 'Fear is the mind-killer.' }),
	);
	expect(path).toMatch(/^data\/captures\/.+\.md$/);
	expect((await inRun(context, () => recent({}))).captures).toEqual([
		{
			path,
			capturedAt: expect.any(String),
			text: 'Fear is the mind-killer.',
			thoughts: 0,
		},
	]);
});

test("capturedAt is written only by add, which is the app's own", async () => {
	expect(capture.actions.add.input).not.toHaveProperty('capturedAt');
	const context = createMemoryContext({
		'data/captures/a.md': note('2026-11-10T02:00:00Z', 'Dune\n'),
	});
	const { set } = capture.actions;
	await expect(
		inRun(context, () =>
			set({ path: 'data/captures/a.md', capturedAt: 'x' } as never),
		),
	).rejects.toThrow("capturedAt is written only by the app's own actions");
});

test('preview is the text before ## Thoughts and counts the bullets under it', () => {
	expect(
		preview(
			'\nText\n\n## Thoughts\n\n- one\n  more\n- two\n\n## Later\n\n- not a thought\n',
		),
	).toEqual({
		text: 'Text',
		thoughts: 2,
	});
	expect(preview(`${'x'.repeat(300)}\n`).text).toBe(`${'x'.repeat(280)}…`);
});

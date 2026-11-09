import { expect, test } from 'bun:test';
import { createMemoryContext } from '@epicenter/app';
import capture, { preview } from './epicenter.ts';

const note = (capturedAt: string, body: string) =>
	`---\ncapturedAt: ${JSON.stringify(capturedAt)}\n---\n${body}`;

test('recent orders by the instant capturedAt names, not by its text, and cuts at limit', async () => {
	const context = createMemoryContext({
		// 09:00 in UTC+8 is 01:00Z, before b's 02:00Z although its text sorts later.
		'captures/a.md': note('2026-11-10T09:00:00+08:00', 'Early\n'),
		'captures/b.md': note('2026-11-10T02:00:00Z', 'Later\n'),
		'captures/c.md': note('2026-11-09T12:00:00Z', 'Day before\n'),
		'captures/notes.txt': 'not a capture',
	});
	const recent = await capture.actions.recent.run({ limit: 2 }, context);
	expect(recent).toEqual({
		total: 3,
		captures: [
			{
				id: 'b',
				capturedAt: '2026-11-10T02:00:00Z',
				text: 'Later',
				thoughts: 0,
			},
			{
				id: 'a',
				capturedAt: '2026-11-10T09:00:00+08:00',
				text: 'Early',
				thoughts: 0,
			},
		],
	});
});

test('recent lists a capture with no date last, and matching searches the whole file', async () => {
	const context = createMemoryContext({
		'captures/a.md': note(
			'2026-11-10T02:00:00Z',
			'Dune\n\n## Thoughts\n\n- spice\n',
		),
		'captures/b.md': 'Written by hand, no front matter. Spice too.\n',
		'captures/c.md': note('2026-11-10T03:00:00Z', 'Arrakis\n'),
	});
	const all = await capture.actions.recent.run({}, context);
	expect(all.captures.map((row) => row.id)).toEqual(['c', 'a', 'b']);
	expect(all.captures[2]?.capturedAt).toBeUndefined();

	const spice = await capture.actions.recent.run(
		{ matching: ' SPICE ' },
		context,
	);
	expect(spice.total).toBe(2);
	expect(spice.captures.map((row) => row.id)).toEqual(['a', 'b']);
});

test('add then recent shows the capture with its text', async () => {
	const context = createMemoryContext({});
	const { id } = await capture.actions.add.run(
		{ text: 'Fear is the mind-killer.' },
		context,
	);
	const recent = await capture.actions.recent.run({}, context);
	expect(recent.captures).toEqual([
		{
			id,
			capturedAt: expect.any(String),
			text: 'Fear is the mind-killer.',
			thoughts: 0,
		},
	]);
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

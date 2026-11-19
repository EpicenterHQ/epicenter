import { expect, test } from 'bun:test';
import { memoryFiles } from '../files/memory';
import { createRecordings } from './recordings';

const A = '2026-11-19T17-30-38-810Z-aaaaaaaa';
const B = '2026-11-19T17-31-00-000Z-bbbbbbbb';
const C = '2026-11-19T17-32-00-000Z-cccccccc';

test('a recording is its note and its audio by id, either one alone', async () => {
	const recordings = createRecordings(
		memoryFiles({
			[`recordings/${A}.md`]: '---\ndurationMs: 1500\n---\nhello\n',
			[`recordings/${A}.webm`]: 'audio',
			[`recordings/${B}.m4a`]: 'audio',
			[`recordings/${C}.md`]: 'only a note\n',
			[`recordings/${C}.md.tmp`]: 'half written',
			'recordings/notes.txt': 'not a recording',
		}),
	);
	const { data } = await recordings.list();
	expect(
		data?.map(({ id, durationMs, transcript, audio }) => ({
			id,
			durationMs,
			transcript,
			audio,
		})),
	).toEqual([
		{
			id: A,
			durationMs: 1500,
			transcript: 'hello',
			audio: `recordings/${A}.webm`,
		},
		{
			id: B,
			durationMs: undefined,
			transcript: '',
			audio: `recordings/${B}.m4a`,
		},
		{
			id: C,
			durationMs: undefined,
			transcript: 'only a note',
			audio: undefined,
		},
	]);
	expect(data?.[0]?.at?.toISOString()).toBe('2026-11-19T17:30:38.810Z');
});

test('a missing folder lists nothing', async () => {
	expect((await createRecordings(memoryFiles()).list()).data).toEqual([]);
});

test('setTranscript keeps the note’s fields and gives audio alone a note', async () => {
	const files = memoryFiles({ [`recordings/${B}.webm`]: 'audio' });
	const recordings = createRecordings(files);
	await recordings.add({ id: A, durationMs: 900 });
	await recordings.setTranscript({ id: A, transcript: 'first' });
	await recordings.setTranscript({ id: B, transcript: 'second' });
	const { data } = await recordings.list();
	expect(
		data?.map(({ durationMs, transcript }) => ({ durationMs, transcript })),
	).toEqual([
		{ durationMs: 900, transcript: 'first' },
		{ durationMs: undefined, transcript: 'second' },
	]);
});

test('delete removes the note and the audio', async () => {
	const files = memoryFiles({
		[`recordings/${A}.md`]: 'hello\n',
		[`recordings/${A}.webm`]: 'audio',
		[`recordings/${B}.m4a`]: 'audio',
	});
	const recordings = createRecordings(files);
	await recordings.delete({ id: A });
	await recordings.delete({ id: B });
	expect((await files.list('recordings')).data).toEqual([]);
});

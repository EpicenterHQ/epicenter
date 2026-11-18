/**
 * Whispering's folder over `memoryFiles`: what one read of it answers, and
 * audio deleted on request, never on its own.
 *
 * Key behaviors:
 * - Audio with no note lists as an untitled recording dated from its id;
 *   a note with no audio stays a recording
 * - "Delete audio older than" removes only audio recorded before the cutoff
 * - a recording whose audio has no note gets its note first, so it stays listed
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { decode, encode } from './files/files.js';
import { memoryFiles } from './files/memory.js';
import { audioOf, audioSizeOf, openFolder, unnotedOf } from './folder.js';

const OLD = '2025-01-01T09-00-00-000Z-oldaudio';
const NOTED = '2025-02-01T09-00-00-000Z-notedold';
const NEW = '2026-11-01T09-00-00-000Z-newaudio';
const NOTE_ONLY = '2026-11-02T09-00-00-000Z-noteonly';

const standup = (recordedAt: string) =>
	encode(`---\ntitle: "Standup"\nrecordedAt: "${recordedAt}"\n---\nnotes\n`);

test('audio with no note lists as an untitled recording dated from its id, and a note with no audio stays a recording', async () => {
	const folder = openFolder(
		memoryFiles({
			[`recordings/${OLD}.webm`]: new Uint8Array([1, 2, 3]),
			[`recordings/${NOTE_ONLY}.md`]: standup('2026-11-02T09:00:00.000Z'),
		}),
	);
	const snapshot = expectOk(await folder.read());

	expect(unnotedOf(snapshot)).toEqual([
		{ id: OLD, title: '', recordedAt: '2025-01-01T09:00:00.000Z', body: '' },
	]);
	expect(snapshot.recordings.items.map(({ id }) => id)).toEqual([NOTE_ONLY]);
	expect(audioOf(snapshot, NOTE_ONLY)).toEqual({ kind: 'absent' });
	expect(audioOf(snapshot, OLD).kind).toBe('here');
});

test('audio recorded before the cutoff is deleted, and audio with no note gets its note first', async () => {
	const files = memoryFiles({
		[`recordings/${OLD}.webm`]: new Uint8Array([1, 2, 3]),
		[`recordings/${NOTED}.webm`]: new Uint8Array([4, 5]),
		[`recordings/${NOTED}.md`]: standup('2025-02-01T09:00:00.000Z'),
		[`recordings/${NEW}.webm`]: new Uint8Array([6]),
	});
	const folder = openFolder(files);
	expect(audioSizeOf(expectOk(await folder.read()))).toBe(6);

	expect(
		expectOk(
			await folder.deleteAudioBefore({
				cutoff: new Date('2026-01-01T00:00:00Z'),
			}),
		),
	).toBe(2);

	const names = expectOk(await files.list('recordings')).map(
		({ name }) => name,
	);
	expect(names).toEqual([`${OLD}.md`, `${NOTED}.md`, `${NEW}.webm`]);
	const made = expectOk(await files.read(`recordings/${OLD}.md`));
	expect(decode(made as Uint8Array)).toBe(
		'---\ntitle: ""\nrecordedAt: "2025-01-01T09:00:00.000Z"\n---\n',
	);
	const after = expectOk(await folder.read());
	expect(after.recordings.items.find(({ id }) => id === OLD)?.title).toBe('');
	expect(audioSizeOf(after)).toBe(1);
});

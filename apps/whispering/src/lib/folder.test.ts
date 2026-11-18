/**
 * The folder over `memoryFiles`: audio deleted on request, never on its own.
 *
 * Key behaviors:
 * - "Delete audio older than" removes only audio recorded before the cutoff
 * - a recording whose audio has no note gets its note first, so it stays listed
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { decode, encode } from './files/files.js';
import { memoryFiles } from './files/memory.js';

// Loaded after the Svelte test support, which compiles `.svelte.ts` runes.
const { openFolder } = await import('./folder.svelte.js');

const OLD = '2025-01-01T09-00-00-000Z-oldaudio';
const NOTED = '2025-02-01T09-00-00-000Z-notedold';
const NEW = '2026-11-01T09-00-00-000Z-newaudio';

test('audio recorded before the cutoff is deleted, and audio with no note gets its note first', async () => {
	const files = memoryFiles({
		[`recordings/${OLD}.webm`]: new Uint8Array([1, 2, 3]),
		[`recordings/${NOTED}.webm`]: new Uint8Array([4, 5]),
		[`recordings/${NOTED}.md`]: encode(
			'---\ntitle: "Standup"\nrecordedAt: "2025-02-01T09:00:00.000Z"\n---\nnotes\n',
		),
		[`recordings/${NEW}.webm`]: new Uint8Array([6]),
	});
	const folder = openFolder(files);
	expectOk(await folder.load());
	expect(folder.audioSize()).toBe(6);

	expect(
		expectOk(await folder.deleteAudioBefore(new Date('2026-01-01T00:00:00Z'))),
	).toBe(2);

	const names = expectOk(await files.list('recordings')).map(
		({ name }) => name,
	);
	expect(names).toEqual([`${OLD}.md`, `${NOTED}.md`, `${NEW}.webm`]);
	const made = expectOk(await files.read(`recordings/${OLD}.md`));
	expect(decode(made as Uint8Array)).toBe(
		'---\ntitle: ""\nrecordedAt: "2025-01-01T09:00:00.000Z"\n---\n',
	);
	expect(folder.recordings.get({ id: OLD })?.title).toBe('');
	expect(folder.audioSize()).toBe(1);
});

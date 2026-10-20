/**
 * Whispering Table Tests
 *
 * `definition.ts` names the tables Whispering reads and the schema each
 * row's frontmatter reads through. These read rows the way the folder does,
 * from files in a real directory, so a schema that misreads a row fails
 * here and not at the first launch.
 *
 * Key behaviors:
 * - The tables are the five directories, with the fields in their order
 * - A recipe names its model, `null` reads as "use the connection", and a
 *   field left out is an issue, never a refusal
 * - A recording row declares `audioPath`, and reading it infers nothing
 * - A field the schema does not name is kept with the row
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import {
	audioPathIn,
	recordingAudioStem,
	whisperingTables,
} from './definition.js';
import {
	openTestFolder,
	whisperingDirectory,
} from './services.test-support.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A folder holding `files`, opened with Whispering's tables. */
async function folderWith(files: Record<string, string>) {
	const root = await whisperingDirectory('whispering-definition-');
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, dirname(path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	const folder = await openTestFolder(root);
	cleanups.push(async () => {
		await folder.close();
		await rm(dirname(root), { recursive: true, force: true });
	});
	return folder;
}

test('the tables are the five directories, with their fields in order', () => {
	expect(Object.keys(whisperingTables)).toEqual([
		'recordings',
		'transcriptions',
		'transformations',
		'transformation_runs',
		'text_runs',
	]);
	const properties = (table: keyof typeof whisperingTables) =>
		Object.keys(
			(whisperingTables[table] as unknown as { properties: object }).properties,
		);
	expect(properties('recordings')).toEqual([
		'title',
		'recordedAt',
		'durationMs',
		'capture',
		'audioPath',
	]);
	// A result on pasted text names no recording or transcript.
	expect(properties('text_runs')).toEqual([
		'transformationId',
		'transformationTitle',
		'createdAt',
		'model',
		'endpoint',
		'prompt',
		'input',
	]);
	// The length is written when a recording stops, so it may be absent.
	expect(
		(whisperingTables.recordings as unknown as { required: string[] }).required,
	).toEqual(['title', 'recordedAt', 'capture', 'audioPath']);
});

test('a recipe names its model, or says “use the connection” with null; a field left out is an issue', async () => {
	const folder = await folderWith({
		'transformations/named.md':
			'---\ntitle: Clean up\nmodel: gpt-4o-mini\n---\nFix it.\n',
		'transformations/connection.md':
			'---\ntitle: Clean up\nmodel: null\n---\nFix it.\n',
		'transformations/silent.md': '---\ntitle: Clean up\n---\nFix it.\n',
	});
	const recipes = folder.tables.transformations;

	expect(expectOk(await recipes.get('named'))).toMatchObject({
		fields: { title: 'Clean up', model: 'gpt-4o-mini' },
		issues: null,
	});
	expect(expectOk(await recipes.get('connection'))).toMatchObject({
		fields: { title: 'Clean up', model: null },
		issues: null,
	});
	// The file says nothing about the model: it is listed for repair, as it is.
	const silent = expectOk(await recipes.get('silent'));
	expect(silent?.issues).toHaveLength(1);
	expect(silent?.body).toBe('Fix it.\n');
});

test('a recording’s audio is only what its row names, and a field the schema does not name is kept', async () => {
	expect(recordingAudioStem('20260102-030405-abcd')).toBe(
		'audio/20260102-030405-abcd',
	);
	expect(audioPathIn({ audioPath: 'audio/take.wav' })).toBe('audio/take.wav');
	// A row with no path, or an empty one, names no audio. Nothing is guessed.
	expect(audioPathIn({})).toBeUndefined();
	expect(audioPathIn({ audioPath: '' })).toBeUndefined();

	const folder = await folderWith({
		'recordings/take.md':
			'---\ntitle: Take\nrecordedAt: 2026-01-02T03:04:05.000Z\ncapture: microphone\naudioPath: audio/take.wav\nmood: calm\n---\n',
		'recordings/nameless.md':
			'---\ntitle: Take\nrecordedAt: 2026-01-02T03:04:05.000Z\ncapture: microphone\n---\n',
		'recordings/bad-time.md':
			'---\ntitle: Take\nrecordedAt: yesterday\ncapture: microphone\naudioPath: audio/take.wav\n---\n',
	});
	const recordings = folder.tables.recordings;
	const take = expectOk(await recordings.get('take'));
	expect(take?.issues).toBeNull();
	expect(take?.fields).toMatchObject({
		audioPath: 'audio/take.wav',
		mood: 'calm',
	});
	expect(expectOk(await recordings.get('nameless'))?.issues).not.toBeNull();
	// An instant is a fixed-width UTC time, so its text sorts as time does.
	expect(expectOk(await recordings.get('bad-time'))?.issues).not.toBeNull();
});

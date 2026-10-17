/**
 * Whispering Definition Tests
 *
 * `definition.ts` names only the inert vocabulary. These check it the way an
 * opener does, so a schema a folder cannot keep fails here and not at the
 * first launch.
 * Validation reads the prepared definition without opening storage.
 *
 * Key behaviors:
 * - The definition is one a file folder accepts
 * - A recipe names its model, and `null` reads as "use the connection"
 * - A recording row declares `audioPath`, and reading it infers nothing
 */
import { expect, test } from 'bun:test';
import { defineFolder, parseRow } from '@epicenter/folder';
import {
	audioPathIn,
	recordingAudioStem,
	whisperingDefinition,
} from './definition.js';

test('a file folder accepts the definition as declared', () => {
	const checked = defineFolder(whisperingDefinition);

	expect(checked.title).toBe('Whispering');
	expect(Object.keys(checked.tables)).toEqual([
		'recordings',
		'transcriptions',
		'transformations',
		'transformation_runs',
		'text_runs',
	]);
	// A result on pasted text names no recording or transcript.
	expect(Object.keys(checked.tables.text_runs.fields)).toEqual([
		'transformationId',
		'transformationTitle',
		'createdAt',
		'model',
		'endpoint',
		'prompt',
		'input',
	]);
	expect(Object.keys(checked.tables.recordings.fields)).toEqual([
		'title',
		'recordedAt',
		'durationMs',
		'capture',
		'audioPath',
	]);
});

test('a recipe names its model, or says “use the connection” with null', () => {
	const recipes = (text: string) =>
		parseRow(whisperingDefinition.tables.transformations, text);
	expect(
		recipes('---\ntitle: Clean up\nmodel: gpt-4o-mini\n---\nFix it.\n').data
			?.fields,
	).toEqual({ title: 'Clean up', model: 'gpt-4o-mini' });
	expect(
		recipes('---\ntitle: Clean up\nmodel: null\n---\nFix it.\n').data?.fields,
	).toEqual({ title: 'Clean up', model: null });
	// A field left out is still an issue: the file says nothing about it.
	expect(recipes('---\ntitle: Clean up\n---\nFix it.\n').error).toHaveLength(1);
});

test('a recording’s audio is only what its row names', () => {
	expect(recordingAudioStem('20260102-030405-abcd')).toBe(
		'audio/20260102-030405-abcd',
	);
	expect(audioPathIn({ audioPath: 'audio/take.wav' })).toBe('audio/take.wav');
	// A row with no path, or an empty one, names no audio. Nothing is guessed.
	expect(audioPathIn({})).toBeUndefined();
	expect(audioPathIn({ audioPath: '' })).toBeUndefined();
});

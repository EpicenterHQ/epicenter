/**
 * Whispering Definition Tests
 *
 * `definition.ts` names only the inert vocabulary, because the page and
 * `scripts/shape.ts` both load it. These check it the way an opener does,
 * so a schema a folder cannot keep fails here and not at the first launch.
 * Validation reads the prepared definition without opening storage.
 *
 * Key behaviors:
 * - The definition is one a file folder accepts
 * - A recipe from an earlier build, with string model and endpoint, still
 *   reads as a row, and `null` reads as "use the connection"
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

test('a recipe written by an earlier build still reads, and a new one says “use the connection” with null', () => {
	const recipes = (text: string) =>
		parseRow(whisperingDefinition.tables.transformations, text);
	const earlier = recipes(
		'---\ntitle: Clean up\nmodel: gpt-4o-mini\nendpoint: https://api.openai.com/v1\n---\nFix it.\n',
	);
	expect(earlier.data?.fields).toEqual({
		title: 'Clean up',
		model: 'gpt-4o-mini',
		endpoint: 'https://api.openai.com/v1',
	});
	const inherits = recipes(
		'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nFix it.\n',
	);
	expect(inherits.data?.fields).toEqual({
		title: 'Clean up',
		model: null,
		endpoint: null,
	});
	// A field left out is still an issue: the file says nothing about it.
	expect(recipes('---\ntitle: Clean up\n---\nFix it.\n').error).toHaveLength(2);
});

test('a recording’s audio is only what its row names', () => {
	expect(recordingAudioStem('20260102-030405-abcd')).toBe(
		'recordings/20260102-030405-abcd',
	);
	expect(audioPathIn({ audioPath: 'audio/take.wav' })).toBe('audio/take.wav');
	// A row with no path, or an empty one, names no audio. Nothing is guessed.
	expect(audioPathIn({})).toBeUndefined();
	expect(audioPathIn({ audioPath: '' })).toBeUndefined();
});

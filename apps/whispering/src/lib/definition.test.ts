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
		'connection',
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

test('a recipe names a model or null, and a key an earlier build wrote is kept and never read', () => {
	const recipes = (text: string) =>
		parseRow(whisperingDefinition.tables.transformations, text);
	expect(
		recipes('---\ntitle: Clean up\nmodel: null\n---\nFix it.\n').data?.fields,
	).toEqual({ title: 'Clean up', model: null });
	// An earlier build's endpoint is not declared: it stays in the file, and
	// nothing reads it as where the recipe runs.
	const earlier = recipes(
		'---\ntitle: Clean up\nmodel: gpt-4o-mini\nendpoint: https://api.openai.com/v1\n---\nFix it.\n',
	);
	expect(earlier.error).toBeNull();
	expect<Record<string, unknown> | undefined>(earlier.data?.fields).toEqual({
		title: 'Clean up',
		model: 'gpt-4o-mini',
		endpoint: 'https://api.openai.com/v1',
	});
	// A field left out is still an issue: the file says nothing about it.
	expect(recipes('---\ntitle: Clean up\n---\nFix it.\n').error).toHaveLength(1);
});

test('a result row made before connections were rows still reads, naming none', () => {
	const text =
		'---\nrecordingId: r1\ncreatedAt: 2026-01-02T03:04:05.000Z\nmodel: whisper-1\nendpoint: https://api.openai.com/v1\n---\n';
	const row = parseRow(whisperingDefinition.tables.transcriptions, text);
	expect(row.error).toBeNull();
	expect(row.data?.fields.connection).toBeUndefined();
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

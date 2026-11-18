/**
 * Whispering's notes: how a note's text reads against its kind's fields.
 * A false issue puts a good note in front of the person to repair; a miss
 * lets a broken one list as if it read. NoteRepair shows these reasons as
 * the person types, so each says which field and, where it can, which line.
 *
 * Key behaviors:
 * - A note that fits reads as its fields and body; a key not declared is kept
 * - Front matter that does not read is one issue, at its line
 * - Each field that does not fit is one issue at the field's line, a
 *   missing one with no line, and a nested failure names where it is
 * - A nested value is one JSON value on its line, written and read back whole
 * - Every note and `settings.md` Whispering writes reads back with no issue
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from '../folder.js';
import { testFiles } from '../services.test-support.js';
import { checkNote, NOTES, SETTINGS } from './folder.js';
import { timeId } from './ids.js';
import { newNote, parseNote } from './note.js';

const recordings = NOTES.recordings.fields;

describe('checkNote', () => {
	test('a note that fits reads as its fields and body, keeping a key not declared', () => {
		expect(
			expectOk(
				checkNote(
					recordings,
					'---\ntitle: "Standup"\nrecordedAt: "2026-10-31T09:30:00.000Z"\nmood: "fine"\n---\nBody\n',
				),
			),
		).toEqual({
			fields: {
				title: 'Standup',
				recordedAt: '2026-10-31T09:30:00.000Z',
				mood: 'fine',
			},
			body: 'Body\n',
		});
	});

	test('a value that is not JSON is one issue at its line, and a repeated key is one issue', () => {
		const [issue, ...rest] = expectErr(
			checkNote(
				recordings,
				'---\ntitle: "x"\nrecordedAt: "2026-10-31T09:30:00.000Z"\ndurationMs: five\n---\n',
			),
		);
		expect(rest).toEqual([]);
		expect(issue).toMatchObject({ field: 'durationMs', line: 4 });
		expect(
			expectErr(checkNote(recordings, '---\ntitle: "x"\ntitle: "y"\n---\n')),
		).toHaveLength(1);
	});

	test("each field that does not fit is one issue at the field's line; a missing one has none", () => {
		const issues = expectErr(
			checkNote(
				recordings,
				'---\nrecordedAt: "2026-13-31T09:30:00.000Z"\ndurationMs: -5\n---\n',
			),
		);
		expect(issues.map(({ field, line }) => [field, line])).toEqual([
			['title', undefined],
			['recordedAt', 2],
			['durationMs', 3],
		]);
		expect(issues[0]?.message).toBe('title is missing');
	});

	test('a recordedAt not written as toISOString writes it does not fit', () => {
		expect(
			expectErr(
				checkNote(
					recordings,
					'---\ntitle: "x"\nrecordedAt: "2026-10-31T09:30:00+08:00"\n---\n',
				),
			)[0],
		).toMatchObject({ field: 'recordedAt', line: 3 });
	});

	test('a nested failure in settings.md names where in the value it is, at its line', () => {
		const issues = expectErr(
			checkNote(
				SETTINGS.fields,
				'---\nshortcut: "CommandOrControl+Shift+K"\nconnections: [{"id": "openai", "name": 7, "baseUrl": "https://api.openai.com/v1", "models": []}]\n---\n',
			),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ field: 'connections', line: 3 });
		expect(issues[0]?.message).toContain('connections/0/name');
	});

	test('an empty settings.md reads: every setting is optional', () => {
		expect(expectOk(checkNote(SETTINGS.fields, ''))).toEqual({
			fields: {},
			body: '',
		});
	});
});

test('a nested value is one JSON value on its line, and reads back whole', () => {
	const models = { transcribe: { endpoint: 'openai', model: 'whisper-1' } };
	const written = newNote({ shortcut: 'K', models }, '', [
		'models',
		'shortcut',
	]);
	expect(written).toBe(
		'---\nmodels: {"transcribe": {"endpoint": "openai", "model": "whisper-1"}}\nshortcut: "K"\n---\n',
	);
	expect(expectOk(parseNote(written)).fields).toEqual({
		models,
		shortcut: 'K',
	});
});

test('every note and settings.md Whispering writes reads back with no issue', async () => {
	const { files, outside } = testFiles();
	const { notes, settings } = openFolder(files);
	const at = new Date('2026-10-31T09:30:00.000Z');
	const id = timeId(at);
	await outside.write(`recordings/${id}.m4a`, new Uint8Array([1, 2, 3]));
	expectOk(
		await notes.set({
			collection: 'recordings',
			id,
			fields: {
				title: 'Standup',
				recordedAt: at.toISOString(),
				durationMs: 1500,
			},
		}),
	);
	const transcription = timeId();
	expectOk(
		await notes.set({
			collection: 'transcriptions',
			id: transcription,
			fields: {
				recordingId: id,
				createdAt: new Date().toISOString(),
				model: 'whisper-1',
				endpoint: 'https://api.openai.com/v1',
			},
			body: { seen: null, text: 'um so a steady tone\n' },
		}),
	);
	expectOk(
		await settings.setConnections({
			connections: [
				{
					id: 'openai',
					name: 'OpenAI',
					baseUrl: 'https://api.openai.com/v1',
					models: ['whisper-1'],
					key: 'https://api.openai.com/v1',
				},
			],
		}),
	);
	expectOk(
		await settings.setChoice({
			job: 'transcribe',
			choice: { endpoint: 'openai', model: 'whisper-1' },
		}),
	);
	expectOk(
		await settings.setShortcut({
			key: 'CommandOrControl+Shift+K',
		}),
	);

	const paths = outside.paths();
	expect(paths).toHaveLength(4);
	expect(paths).toContain(`recordings/${id}.m4a`);
	for (const path of paths.filter((path) => path.endsWith('.md'))) {
		const fields =
			path === SETTINGS.path
				? SETTINGS.fields
				: Object.values(NOTES).find(({ dir }) => path.startsWith(`${dir}/`))
						?.fields;
		expect(fields).toBeDefined();
		const text = (await outside.read(path)) ?? '';
		expect(checkNote(fields!, text).error).toBeNull();
	}
});

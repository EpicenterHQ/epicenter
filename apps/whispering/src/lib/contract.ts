/**
 * Whispering's contract: what its files are, as plain data any program can
 * check (`epicenter check <dir> --contract <url>/contract.json`).
 *
 * - A recording is a note at `recordings/{id}.md` (its title, when it was
 *   recorded, and how long it is; notes in the body) beside its audio at `recordings/{id}.{ext}`: `m4a` or `webm` from a
 *   browser, `webm` from the desktop (`wav` when it could not encode one).
 * - A transcription is a note naming its recording, the transcript as body.
 * - A transformation is a reusable title and instructions (the body), with an
 *   optional model of its own (`null` uses the text model chosen in Settings).
 * - Applying one writes a result: on a transcript in `transformation_runs/`,
 *   on pasted text in `text_runs/`. Each keeps the prompt and input it sent,
 *   with the answer as its body, so it reads the same after anything it came
 *   from changes or goes.
 *
 * A file's id is its identity: renaming a recording changes its title, never
 * its path, so a result's `recordingId` never breaks.
 *
 * - `settings.md` is the person's settings (ADR-0894): the model for each
 *   job (`transcribe`, `chat`), each provider connection and its endpoint,
 *   never its key, and the desktop app's global shortcut in the
 *   global-shortcut plugin's spelling (`CommandOrControl+Shift+;`), which
 *   a browser ignores. It moves and exports with the recordings.
 *
 * A key and anything that names this computer's hardware (the microphone)
 * stay out of the files: a key in the Keychain on the desktop and in
 * `localStorage` in a browser, the rest in `localStorage`.
 *
 * It is published, unchanged, as `static/contract.json` (`bun run contract`
 * writes it).
 */
import { defineContract } from './format/contract/index.js';

/** An instant in UTC, to the millisecond, as `Date.prototype.toISOString` writes it. */
const instant = {
	type: 'string',
	format: 'date-time',
	pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
} as const;

/** A model chosen for a job: the endpoint that offers it, and its id there. */
const choice = {
	type: 'object',
	properties: {
		endpoint: { type: 'string' },
		model: { type: 'string' },
	},
	required: ['endpoint', 'model'],
} as const;

export const whispering = defineContract({
	description:
		'Voice notes: a note per recording beside its audio, its transcripts, reusable recipes, the results of applying them, and the person’s settings.',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				recordedAt: instant,
				durationMs: { type: 'number', minimum: 0 },
			},
			required: ['title', 'recordedAt'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
		transcriptions: {
			path: 'transcriptions/{id}.md',
			fields: {
				recordingId: { type: 'string' },
				createdAt: instant,
				model: { type: 'string' },
				endpoint: { type: 'string' },
			},
			required: ['recordingId', 'createdAt', 'model', 'endpoint'],
		},
		transformations: {
			path: 'transformations/{id}.md',
			fields: {
				title: { type: 'string' },
				model: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			},
			required: ['title', 'model'],
		},
		transformation_runs: {
			path: 'transformation_runs/{id}.md',
			fields: {
				recordingId: { type: 'string' },
				transcriptionId: { type: 'string' },
				transformationId: { type: 'string' },
				transformationTitle: { type: 'string' },
				createdAt: instant,
				model: { type: 'string' },
				endpoint: { type: 'string' },
				prompt: { type: 'string' },
				input: { type: 'string' },
			},
			required: [
				'recordingId',
				'transcriptionId',
				'transformationId',
				'transformationTitle',
				'createdAt',
				'model',
				'endpoint',
				'prompt',
				'input',
			],
		},
		text_runs: {
			path: 'text_runs/{id}.md',
			fields: {
				transformationId: { type: 'string' },
				transformationTitle: { type: 'string' },
				createdAt: instant,
				model: { type: 'string' },
				endpoint: { type: 'string' },
				prompt: { type: 'string' },
				input: { type: 'string' },
			},
			required: [
				'transformationId',
				'transformationTitle',
				'createdAt',
				'model',
				'endpoint',
				'prompt',
				'input',
			],
		},
		settings: {
			path: 'settings.md',
			fields: {
				models: {
					type: 'object',
					properties: { transcribe: choice, chat: choice },
				},
				connections: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
							name: { type: 'string' },
							baseUrl: { type: 'string' },
							models: { type: 'array', items: { type: 'string' } },
							key: { type: 'string' },
						},
						required: ['id', 'name', 'baseUrl', 'models'],
					},
				},
				shortcut: { type: 'string' },
			},
		},
	},
});

export type Whispering = typeof whispering;

/**
 * Whispering's contract: what its files are, as plain data any program can
 * check (`epicenter check <url>/contract.json <dir>`).
 *
 * - A recording is a note at `recordings/{id}.md` (its title, when it was
 *   recorded, how long it is, and what it was captured from; notes in the
 *   body) beside its audio at `recordings/{id}.{ext}`: `m4a` or `webm` from a
 *   browser, `wav` from the desktop.
 * - A transcription is a note naming its recording, the transcript as body.
 * - A transformation is a reusable title and instructions (the body), with an
 *   optional model of its own (`null` uses the text connection's).
 * - Applying one writes a result: on a transcript in `transformation_runs/`,
 *   on pasted text in `text_runs/`. Each keeps the prompt and input it sent,
 *   with the answer as its body, so it reads the same after anything it came
 *   from changes or goes.
 *
 * A file's id is its identity: renaming a recording changes its title, never
 * its path, so a result's `recordingId` never breaks.
 *
 * Whispering keeps no settings in its files: its connections (where requests
 * go, and their keys) and the chosen microphone belong to a device, so they
 * stay in the browser.
 *
 * Its name makes the repository `<account>/whispering` (decision 46). It is
 * published, unchanged, as `static/contract.json` (`bun run contract` writes
 * it).
 */
import { defineContract } from '@epicenter/definition/contract';

/** An instant in UTC, to the millisecond, as `Date.prototype.toISOString` writes it. */
const instant = {
	type: 'string',
	format: 'date-time',
	pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
} as const;

export const whispering = defineContract({
	name: 'whispering',
	description:
		'Voice notes: a note per recording beside its audio, its transcripts, reusable recipes, and the results of applying them.',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				recordedAt: instant,
				durationMs: { type: 'number', minimum: 0 },
				capture: { enum: ['microphone', 'fixture'] },
			},
			required: ['title', 'recordedAt', 'capture'],
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
	},
});

export type Whispering = typeof whispering;
